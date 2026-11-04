import { z } from 'zod';

const HttpsUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }, '需要不含用户名、密码或片段的 HTTPS 地址');

export const AIConfigSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  baseUrl: HttpsUrl.refine((value) => !new URL(value).search, 'AI Base URL 不得包含查询参数'),
  model: z.string().trim().max(150),
  timeoutMs: z.number().int().min(1000).max(60000),
  jsonMode: z.boolean(),
  dailyBudgetUsd: z.number().finite().min(0).max(10000),
  maxCallCostUsd: z.number().finite().min(0).max(1000),
});
export const AIConfigViewSchema = AIConfigSchema.extend({
  apiKeyConfigured: z.boolean(),
  configOrigin: z.enum(['environment', 'database']),
  hasOverride: z.boolean(),
});
export const AIConfigPatchSchema = AIConfigSchema.partial()
  .extend({
    apiKey: z
      .string()
      .trim()
      .max(4096)
      .refine((value) => !/[\r\n]/.test(value), 'API Key 不得包含换行')
      .optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict();
export const AIConnectionTestSchema = z.object({
  status: z.enum(['connected', 'skipped']),
  message: z.string(),
  model: z.string(),
});
export const NotificationConfigPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    botToken: z.string().trim().max(4096).optional(),
    chatId: z.string().trim().max(200).optional(),
    webhookUrl: z.union([z.literal(''), HttpsUrl]).optional(),
    serverUrl: z.union([z.literal(''), HttpsUrl]).optional(),
    smtpHost: z
      .string()
      .trim()
      .max(255)
      .refine((value) => !/[\r\n]/.test(value), 'SMTP 主机不得包含换行')
      .optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpSecurity: z.enum(['tls', 'starttls']).optional(),
    smtpUsername: z
      .string()
      .trim()
      .max(320)
      .refine((value) => !/[\r\n]/.test(value), 'SMTP 用户名不得包含换行')
      .optional(),
    smtpPassword: z
      .string()
      .max(4096)
      .refine((value) => !/[\r\n]/.test(value), 'SMTP 密码不得包含换行')
      .optional(),
    fromEmail: z.email().optional(),
    toEmails: z.array(z.email()).max(20).optional(),
    clearCredentials: z.boolean().optional(),
  })
  .strict();
export const NotificationConfigViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: z.enum(['telegram', 'feishu', 'bark', 'email']),
  enabled: z.boolean(),
  configured: z.boolean(),
  description: z.string(),
  configOrigin: z.enum(['environment', 'database']),
  chatId: z.string(),
  botTokenConfigured: z.boolean(),
  webhookConfigured: z.boolean(),
  smtpHost: z.string().default(''),
  smtpPort: z.number().int().nullable().default(null),
  smtpSecurity: z.enum(['tls', 'starttls']).nullable().default(null),
  smtpUsername: z.string().default(''),
  smtpPasswordConfigured: z.boolean().default(false),
  fromEmail: z.string().default(''),
  toEmails: z.array(z.string()).default([]),
});
export type AIConfig = z.infer<typeof AIConfigSchema>;
export type AIConfigView = z.infer<typeof AIConfigViewSchema>;
export type AIConfigPatch = z.infer<typeof AIConfigPatchSchema>;
export type NotificationConfigPatch = z.infer<typeof NotificationConfigPatchSchema>;
