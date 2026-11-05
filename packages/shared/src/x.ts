import { z } from 'zod';

export const XUsernameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, '').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{1,15}$/, '账号只填写用户名，不填写链接'));
export const XKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N} #$._-]+$/u, '关键词只允许文字、数字、空格和 # $ . _ -');
const XIntervalSchema = z.number().int().min(300).max(86400);
const XConfigFieldsSchema = z.object({
  enabled: z.boolean(),
  usernames: z
    .array(XUsernameSchema)
    .max(20)
    .transform((value) => [...new Set(value)].sort()),
  keywords: z
    .array(XKeywordSchema)
    .max(10)
    .transform((value) => [...new Set(value)].sort()),
  pollIntervalMinSeconds: XIntervalSchema,
  pollIntervalMaxSeconds: XIntervalSchema,
  maxResults: z.number().int().min(10).max(100),
  dailyRequestLimit: z.number().int().min(0).max(500),
  candidateMinAuthors: z.number().int().min(2).max(20),
  candidateWindowMinutes: z.number().int().min(15).max(60),
});
export const XConfigSchema = XConfigFieldsSchema.refine(
  (value) => value.pollIntervalMinSeconds <= value.pollIntervalMaxSeconds,
  { message: '最小采集间隔不能大于最大采集间隔', path: ['pollIntervalMaxSeconds'] },
);
export type XConfig = z.infer<typeof XConfigSchema>;
export function buildXSearchQuery(scope: Pick<XConfig, 'usernames' | 'keywords'>): string {
  const usernames = XConfigSchema.shape.usernames.parse(scope.usernames);
  const keywords = XConfigSchema.shape.keywords.parse(scope.keywords);
  if (!usernames.length) return '';
  const accounts = `(${usernames.map((name) => `from:${name}`).join(' OR ')})`;
  const terms = keywords.length ? ` (${keywords.map((word) => `"${word}"`).join(' OR ')})` : '';
  const query = `${accounts}${terms} -filter:retweets -filter:replies`;
  if (query.length > 512) throw new Error('X 查询范围超过512字符，请减少账号或关键词');
  return query;
}
export const DEFAULT_X_CONFIG: XConfig = {
  enabled: false,
  usernames: [],
  keywords: [],
  pollIntervalMinSeconds: 600,
  pollIntervalMaxSeconds: 1200,
  maxResults: 10,
  dailyRequestLimit: 96,
  candidateMinAuthors: 3,
  candidateWindowMinutes: 60,
};
export const XSessionCookiesSchema = z
  .string()
  .regex(/^[^\r\n]*$/, '登录态不得包含换行')
  .trim()
  .min(1)
  .max(4096)
  .transform((value, ctx) => {
    const parts = value.split(';').map((part) => part.trim());
    if (parts.at(-1) === '') parts.pop();
    const cookies = new Map<string, string>();
    let valid = parts.length === 2;
    for (const part of parts) {
      const separator = part.indexOf('=');
      const name = part.slice(0, separator).trim();
      const secret = part.slice(separator + 1).trim();
      if (
        separator < 1 ||
        !['auth_token', 'ct0'].includes(name) ||
        cookies.has(name) ||
        !/^[A-Za-z0-9._~%+/=-]{1,2048}$/.test(secret)
      )
        valid = false;
      cookies.set(name, secret);
    }
    if (!valid || !cookies.has('auth_token') || !cookies.has('ct0')) {
      ctx.addIssue({
        code: 'custom',
        message: '仅填写 auth_token=...; ct0=...，不得包含其他 Cookie、空值或重复字段',
      });
      return z.NEVER;
    }
    return `auth_token=${cookies.get('auth_token')}; ct0=${cookies.get('ct0')}`;
  });
export const XConfigPatchSchema = XConfigFieldsSchema.partial()
  .extend({
    pollIntervalSeconds: XIntervalSchema.optional(),
    sessionCookies: XSessionCookiesSchema.optional(),
    clearSessionCookies: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.pollIntervalSeconds !== undefined &&
      (value.pollIntervalMinSeconds !== undefined || value.pollIntervalMaxSeconds !== undefined)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['pollIntervalSeconds'],
        message: '兼容单值间隔不能与新区间同时填写',
      });
    if (
      value.pollIntervalMinSeconds !== undefined &&
      value.pollIntervalMaxSeconds !== undefined &&
      value.pollIntervalMinSeconds > value.pollIntervalMaxSeconds
    )
      ctx.addIssue({
        code: 'custom',
        path: ['pollIntervalMaxSeconds'],
        message: '最小采集间隔不能大于最大采集间隔',
      });
  });
export type XConfigPatch = z.infer<typeof XConfigPatchSchema>;
function legacyInterval(value: unknown) {
  const minimum = XIntervalSchema.parse(value);
  return {
    pollIntervalMinSeconds: minimum,
    pollIntervalMaxSeconds: Math.min(86400, Math.ceil(minimum * 1.5)),
  };
}
/** Read legacy settings without rewriting them; validate partial updates after merging. */
export function mergeXConfig(stored: Record<string, unknown>, patch: XConfigPatch = {}): XConfig {
  const parsed = XConfigPatchSchema.parse(patch);
  const legacyStored =
    stored.pollIntervalMinSeconds === undefined &&
    stored.pollIntervalMaxSeconds === undefined &&
    stored.pollIntervalSeconds !== undefined
      ? legacyInterval(stored.pollIntervalSeconds)
      : {};
  const legacyPatch =
    parsed.pollIntervalSeconds === undefined ? {} : legacyInterval(parsed.pollIntervalSeconds);
  return XConfigSchema.parse({
    ...DEFAULT_X_CONFIG,
    ...stored,
    ...legacyStored,
    ...parsed,
    ...legacyPatch,
  });
}
const Time = z.iso.datetime({ offset: true });
export const XSampleSchema = z.object({
  id: z.string(),
  text: z.string(),
  authorId: z.string(),
  url: z.url(),
  sourcePublishedAt: Time.nullable(),
});
export const XConnectionTestSchema = z.object({
  dataMode: z.enum(['live', 'fixture']),
  status: z.enum(['connected', 'failed', 'skipped']),
  message: z.string(),
  checkedAt: Time,
  httpStatus: z.number().int().nullable(),
  returnedPosts: z.number().int().nonnegative(),
  samples: z.array(XSampleSchema).max(3),
});
export type XConnectionTest = z.infer<typeof XConnectionTestSchema>;
export const XPollStateSchema = z.object({
  lastRequestAt: Time.nullable(),
  nextRequestAt: Time.nullable(),
  lastDelaySeconds: XIntervalSchema.nullable(),
});
export type XPollState = z.infer<typeof XPollStateSchema>;
export const XConfigViewSchema = XConfigSchema.safeExtend({
  pollIntervalSeconds: XIntervalSchema,
  sessionConfigured: z.boolean(),
  collectorConfigured: z.boolean(),
  credentialError: z.boolean(),
  configOrigin: z.enum(['default', 'database']),
  dataMode: z.enum(['live', 'fixture']),
  query: z.string(),
  usage: z.object({
    day: z.string(),
    requests: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
  lastTest: XConnectionTestSchema.nullable(),
  scheduling: XPollStateSchema,
  source: z.object({
    enabled: z.boolean(),
    status: z.string(),
    lastFetchedAt: Time.nullable(),
    lastError: z.string().nullable(),
  }),
});
export type XConfigView = z.infer<typeof XConfigViewSchema>;
