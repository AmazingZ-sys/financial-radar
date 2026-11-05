import { z } from 'zod';
import { config, isInternalXCollectorUrl } from '@radar/config';
import { buildXSearchQuery, XSessionCookiesSchema } from '@radar/shared';
import { ConnectorError, classifyStatus, retryAfterMs } from './http.js';
import type {
  Connector,
  Cursor,
  FetchResult,
  NormalizedEvent,
  RawItem,
  SourceMetadata,
} from './types.js';

export type XRecentSearchOptions = {
  sessionCookies: string;
  collectorUrl?: string;
  collectorSecret?: string;
  usernames: string[];
  keywords: string[];
  pollIntervalSeconds: number;
  maxResults: number;
};

/** Account scopes and keywords are literals, never administrator-supplied query operators. */
export function buildXQuery(input: { usernames: string[]; keywords: string[] }): string {
  try {
    const query = buildXSearchQuery(input);
    if (!query) throw new Error('missing account scope');
    return query;
  } catch {
    throw new ConnectorError('X 关注账号或字面关键词无效，或查询超过 512 字符', 'SCHEMA');
  }
}

const Id = z.string().regex(/^[0-9]{1,19}$/);
const Reference = z.object({
  id: Id,
  type: z.enum(['retweeted', 'quoted', 'replied_to']),
});
const Post = z.object({
  id: Id,
  text: z.string().min(1).max(50_000),
  authorId: Id,
  createdAt: z.iso.datetime({ offset: true }),
  originalUrl: z.string().url(),
  referencedPosts: z.array(Reference).max(100),
  hashtags: z.array(z.string().min(1).max(200)).max(100),
  cashtags: z.array(z.string().min(1).max(200)).max(100),
});
const SearchResponse = z.object({
  posts: z.array(Post).max(100),
  hasMore: z.boolean(),
});
const CursorSchema = z.object({
  sinceId: Id.optional(),
  baseSinceId: Id.optional(),
  startTime: z.iso.datetime({ offset: true }).optional(),
  endTime: z.iso.datetime({ offset: true }).optional(),
  beforeId: Id.optional(),
  pendingNewestId: Id.optional(),
});
type XSearchCursor = z.infer<typeof CursorSchema>;

function newestId(...values: (string | undefined)[]): string | undefined {
  return values.reduce<string | undefined>(
    (latest, value) => (value && (!latest || BigInt(value) > BigInt(latest)) ? value : latest),
    undefined,
  );
}

const MAX_RESPONSE_BYTES = 2_000_000;
async function responseJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError('X 响应超过 2MB 限制', 'SCHEMA');
  }
  if (!response.body) throw new ConnectorError('X 返回空响应', 'SCHEMA');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ConnectorError('X 响应超过 2MB 限制', 'SCHEMA');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('X 响应读取失败或 JSON 格式无效', 'SCHEMA');
  } finally {
    reader.releaseLock();
  }
}

export class XRecentSearchConnector implements Connector {
  metadata: SourceMetadata;
  private responseStatus: number | null = null;
  get lastHttpStatus(): number | null {
    return this.responseStatus;
  }
  capabilities = {
    history: false,
    checkpoint: true,
    scope: 'watchlist' as const,
    sourceTimestamp: true,
  };
  rateLimit = { maxRequests: 1, windowMs: 300_000, respectRetryAfter: true };
  constructor(
    private readonly options: XRecentSearchOptions,
    private readonly fetcher: typeof fetch = fetch,
    private readonly beforeRequest?: () => Promise<void>,
  ) {
    if (
      !Number.isInteger(options.maxResults) ||
      options.maxResults < 10 ||
      options.maxResults > 100 ||
      !Number.isInteger(options.pollIntervalSeconds) ||
      options.pollIntervalSeconds < 300 ||
      options.pollIntervalSeconds > 86400
    )
      throw new ConnectorError('X 单页数量或轮询间隔超出范围', 'SCHEMA');
    this.metadata = {
      id: 'x-search',
      name: 'X · 自建采集关注账号讨论',
      officialUrl: 'https://github.com/vladkens/twscrape',
      transport: 'pull',
      mode: 'live',
      categories: ['crypto', 'social'],
      trust: 0.5,
      pollIntervalSeconds: options.pollIntervalSeconds,
      licenseStatus: 'authorization-required',
    };
    this.rateLimit.windowMs = options.pollIntervalSeconds * 1000;
  }
  async initialize() {}
  async shutdown() {}
  async healthCheck() {
    if (!this.options.sessionCookies.trim() || !this.options.usernames.length)
      return { status: 'unconfigured' as const, detail: '需要配置自己的 X 登录态与关注账号' };
    try {
      buildXQuery(this.options);
      XSessionCookiesSchema.parse(this.options.sessionCookies);
      if (
        !isInternalXCollectorUrl(this.options.collectorUrl ?? config.xCollectorUrl) ||
        (this.options.collectorSecret ?? config.xCollectorSecret).length < 32
      )
        return {
          status: 'unconfigured' as const,
          detail: '服务器尚未配置内部 X 采集器地址与共享密钥',
        };
      return {
        status: 'healthy' as const,
        detail: '自建采集已配置，无数据 API 费用；登录态及连接健康以实际测试结果为准',
      };
    } catch {
      return { status: 'unconfigured' as const, detail: 'X 登录态或关注范围配置无效' };
    }
  }
  async fetch(cursor: Cursor = {}): Promise<FetchResult> {
    const health = await this.healthCheck();
    if (health.status !== 'healthy') throw new ConnectorError(health.detail, 'AUTH');
    const parsed = CursorSchema.safeParse(cursor);
    if (!parsed.success || cursor.nextToken !== undefined)
      throw new ConnectorError('X 自建采集游标无效，未发起请求', 'SCHEMA');
    const saved = parsed.data;
    if (
      saved.beforeId &&
      (!saved.endTime ||
        !saved.pendingNewestId ||
        Boolean(saved.baseSinceId) === Boolean(saved.startTime))
    )
      throw new ConnectorError('X 分页游标缺少固定查询窗口，未发起请求', 'SCHEMA');
    const baseline = saved.beforeId ? saved.baseSinceId : saved.sinceId;
    const startTime = baseline
      ? undefined
      : saved.beforeId
        ? saved.startTime
        : new Date(Date.now() - 15 * 60_000).toISOString();
    const endTime = saved.beforeId ? saved.endTime! : new Date(Date.now()).toISOString();
    if (startTime && Date.parse(startTime) >= Date.parse(endTime))
      throw new ConnectorError('X 查询时间窗口无效，未发起请求', 'SCHEMA');
    const request = {
      query: buildXQuery(this.options),
      sessionCookies: XSessionCookiesSchema.parse(this.options.sessionCookies),
      maxResults: this.options.maxResults,
      ...(baseline ? { sinceId: baseline } : { startTime }),
      endTime,
      ...(saved.beforeId ? { beforeId: saved.beforeId } : {}),
    };
    // This is a local request counter, never a paid data API reservation.
    this.responseStatus = null;
    await this.beforeRequest?.();
    let response: Response;
    try {
      response = await this.fetcher(
        new URL('/v1/search', this.options.collectorUrl ?? config.xCollectorUrl).href,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
          headers: {
            Authorization: `Bearer ${this.options.collectorSecret ?? config.xCollectorSecret}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        },
      );
    } catch {
      throw new ConnectorError('X 自建采集器连接失败或超时；未自动重试或切换付费服务', 'TRANSIENT');
    }
    this.responseStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorError(
        `X 自建采集 HTTP ${response.status}；请检查登录态、内部服务或限流状态`,
        classifyStatus(response.status),
        response.status === 429 ? retryAfterMs(response.headers.get('retry-after')) : 0,
      );
    }
    const result = SearchResponse.safeParse(await responseJson(response));
    if (!result.success) throw new ConnectorError('X 采集器返回数据结构无效，未推进游标', 'SCHEMA');
    const data = result.data;
    const posts = data.posts;
    if (posts.length > this.options.maxResults || (data.hasMore && posts.length === 0))
      throw new ConnectorError('X 采集器返回条数或分页标记无效，未推进游标', 'SCHEMA');
    for (const post of posts) {
      if (
        (saved.beforeId && BigInt(post.id) >= BigInt(saved.beforeId)) ||
        (baseline && BigInt(post.id) <= BigInt(baseline)) ||
        (startTime && Date.parse(post.createdAt) < Date.parse(startTime)) ||
        Date.parse(post.createdAt) >= Date.parse(endTime) ||
        post.originalUrl !== `https://x.com/i/web/status/${post.id}`
      )
        throw new ConnectorError('X 采集证据超出固定窗口或分页没有向前推进', 'SCHEMA');
    }
    const newest = newestId(...posts.map((post) => post.id));
    const oldest = posts.reduce<string | undefined>(
      (value, post) => (!value || BigInt(post.id) < BigInt(value) ? post.id : value),
      undefined,
    );
    const items: RawItem[] = [];
    const seen = new Set<string>();
    for (const post of posts) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      const referencedPosts = post.referencedPosts;
      if (referencedPosts.some((reference) => ['retweeted', 'replied_to'].includes(reference.type)))
        continue;
      const createdAt = new Date(post.createdAt).toISOString();
      items.push({
        externalId: post.id,
        publishedAt: createdAt,
        payload: {
          id: post.id,
          text: post.text,
          authorId: post.authorId,
          createdAt,
          referencedPosts,
          hashtags: [...new Set(post.hashtags)],
          cashtags: [...new Set(post.cashtags)],
          originalUrl: `https://x.com/i/web/status/${post.id}`,
        },
      });
    }
    const pendingNewest = saved.beforeId ? saved.pendingNewestId : newest;
    const completedNewest = newestId(saved.sinceId, pendingNewest);
    const next: XSearchCursor = data.hasMore
      ? {
          ...(saved.sinceId ? { sinceId: saved.sinceId } : {}),
          ...(baseline ? { baseSinceId: baseline } : { startTime }),
          endTime,
          beforeId: oldest!,
          ...(pendingNewest ? { pendingNewestId: pendingNewest } : {}),
        }
      : { ...(completedNewest ? { sinceId: completedNewest } : {}) };
    return { items, cursor: next };
  }
  normalize(item: RawItem): NormalizedEvent {
    if (!Id.safeParse(item.externalId).success || typeof item.payload.text !== 'string')
      throw new ConnectorError('X 原始帖子身份或正文无效', 'SCHEMA');
    return {
      sourceId: this.metadata.id,
      externalId: item.externalId,
      identity: `x:${item.externalId}`,
      title: item.payload.text.replace(/\s+/g, ' ').slice(0, 160),
      description: item.payload.text,
      originalUrl: `https://x.com/i/web/status/${item.externalId}`,
      sourcePublishedAt: item.publishedAt,
      eventOccurredAt: null,
      assets: [],
      categories: this.metadata.categories,
      eventType: 'SOCIAL_POST',
      confidence: this.metadata.trust,
      severity: 'P3',
      verificationStatus: 'UNVERIFIED',
      dataMode: 'live',
      metrics: { authorId: String(item.payload.authorId ?? '') },
    };
  }
}
