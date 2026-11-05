import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '@radar/config';
import { AIConfigSchema, type AIConfigPatch, type NotificationConfigPatch } from '@radar/shared';
import { z } from 'zod';
import { sql } from './index.js';

const CONFIG_KEY = 'integrations:ai';
// Existing installations can use SESSION_SECRET; a separate stable key avoids session rotation coupling.
const encryptionKey = () =>
  createHash('sha256')
    .update(config.integrationEncryptionKey || config.sessionSecret)
    .digest();
export function encryptIntegrationSecret(secret: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [
    'v1',
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}
export function decryptIntegrationSecret(value: string, context: string): string {
  try {
    const [version, nonce, tag, encrypted] = value.split('.');
    if (version !== 'v1' || !nonce || !tag || encrypted === undefined) throw new Error();
    const cipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(nonce, 'base64url'),
    );
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      cipher.update(Buffer.from(encrypted, 'base64url')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('无法解密集成配置，请检查服务器加密密钥或重新保存凭据');
  }
}
function envAIConfig() {
  return {
    name: 'OpenAI-compatible',
    enabled: true,
    baseUrl: config.aiBaseUrl,
    model: config.aiModel,
    reasoningEffort: config.aiReasoningEffort,
    timeoutMs: 20000,
    jsonMode: true,
    dailyBudgetUsd: config.aiDailyBudgetUsd,
    maxCallCostUsd: config.aiMaxCallCostUsd,
    maxDailyCalls: config.aiMaxDailyCalls,
  };
}
type StoredAI = Omit<ReturnType<typeof envAIConfig>, 'maxDailyCalls'> & {
  maxDailyCalls?: number;
  encryptedApiKey: string;
};
export async function readAIConfig() {
  const row = (await sql`SELECT data FROM system_settings WHERE key=${CONFIG_KEY}`)[0];
  if (!row)
    return {
      ...envAIConfig(),
      apiKey: config.aiApiKey,
      configOrigin: 'environment' as const,
      hasOverride: false,
    };
  const data = row.data as StoredAI;
  return {
    ...AIConfigSchema.parse({ maxDailyCalls: config.aiMaxDailyCalls, ...data }),
    apiKey: decryptIntegrationSecret(data.encryptedApiKey, CONFIG_KEY),
    configOrigin: 'database' as const,
    hasOverride: true,
  };
}
export function aiConfigView(effective: Awaited<ReturnType<typeof readAIConfig>>) {
  const { apiKey, ...view } = effective;
  return { ...view, apiKeyConfigured: Boolean(apiKey) };
}
export async function saveAIConfig(patch: AIConfigPatch) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${CONFIG_KEY}))`;
    const row = (await tx`SELECT data FROM system_settings WHERE key=${CONFIG_KEY}`)[0];
    const stored = row?.data as StoredAI | undefined;
    const fields = AIConfigSchema.parse({
      maxDailyCalls: config.aiMaxDailyCalls,
      ...(stored ?? envAIConfig()),
      ...patch,
    });
    // A full replacement can recover from a lost/rotated encryption key without decrypting old data.
    const apiKey = patch.clearApiKey
      ? ''
      : patch.apiKey?.trim() ||
        (stored ? decryptIntegrationSecret(stored.encryptedApiKey, CONFIG_KEY) : config.aiApiKey);
    const data: StoredAI = {
      ...fields,
      encryptedApiKey: encryptIntegrationSecret(apiKey, CONFIG_KEY),
    };
    await tx`INSERT INTO system_settings(key,data) VALUES(${CONFIG_KEY},${tx.json(data)}) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=now()`;
    return aiConfigView({ ...fields, apiKey, configOrigin: 'database', hasOverride: true });
  });
}

const NotificationSecretsSchema = z.object({
  botToken: z.string().default(''),
  chatId: z.string().default(''),
  webhookUrl: z.string().default(''),
  serverUrl: z.string().default(''),
  smtpHost: z.string().default(''),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  smtpSecurity: z.enum(['tls', 'starttls']).default('starttls'),
  smtpUsername: z.string().default(''),
  smtpPassword: z.string().default(''),
  fromEmail: z.union([z.literal(''), z.email()]).default(''),
  toEmails: z.array(z.email()).max(20).default([]),
});
type NotificationSecrets = z.infer<typeof NotificationSecretsSchema>;
type ChannelRow = { id: string; provider: string; name: string; enabled: boolean; data?: unknown };
function envNotificationConfig(provider: string): NotificationSecrets {
  return {
    botToken: provider === 'telegram' ? config.telegramBotToken : '',
    chatId: provider === 'telegram' ? config.telegramChatId : '',
    webhookUrl: provider === 'feishu' ? config.feishuWebhookUrl : '',
    serverUrl: provider === 'bark' ? config.barkServerUrl : '',
    smtpHost: provider === 'email' ? config.smtpHost : '',
    smtpPort: provider === 'email' ? config.smtpPort : 587,
    smtpSecurity: provider === 'email' ? config.smtpSecurity : 'starttls',
    smtpUsername: provider === 'email' ? config.smtpUsername : '',
    smtpPassword: provider === 'email' ? config.smtpPassword : '',
    fromEmail: provider === 'email' ? config.smtpFromEmail : '',
    toEmails: provider === 'email' ? config.smtpToEmails : [],
  };
}
export function readNotificationConfig(provider: string, data: unknown) {
  const stored = data as { encryptedCredentials?: string } | null;
  const secrets = stored?.encryptedCredentials
    ? NotificationSecretsSchema.parse(
        JSON.parse(
          decryptIntegrationSecret(stored.encryptedCredentials, `notification:${provider}`),
        ),
      )
    : envNotificationConfig(provider);
  const configured =
    provider === 'telegram'
      ? Boolean(secrets.botToken && secrets.chatId)
      : provider === 'feishu'
        ? Boolean(secrets.webhookUrl)
        : provider === 'bark'
          ? Boolean(secrets.serverUrl)
          : provider === 'email'
            ? Boolean(
                secrets.smtpHost &&
                secrets.smtpPort &&
                secrets.fromEmail &&
                secrets.toEmails.length &&
                Boolean(secrets.smtpUsername) === Boolean(secrets.smtpPassword),
              )
            : false;
  return {
    ...secrets,
    configured,
    configOrigin: stored?.encryptedCredentials ? ('database' as const) : ('environment' as const),
  };
}
export function notificationConfigView(row: ChannelRow) {
  let credentials: ReturnType<typeof readNotificationConfig>;
  try {
    credentials = readNotificationConfig(row.provider, row.data);
  } catch {
    // Keep the editor reachable after encryption-key rotation; sending still fails closed.
    return {
      id: String(row.id),
      name: String(row.name),
      provider: row.provider,
      enabled: row.enabled,
      configured: false,
      configOrigin: 'database' as const,
      chatId: '',
      botTokenConfigured: false,
      webhookConfigured: false,
      smtpHost: '',
      smtpPort: null,
      smtpSecurity: null,
      smtpUsername: '',
      smtpPasswordConfigured: false,
      fromEmail: '',
      toEmails: [],
      description: '已保存凭据无法解密，请重新填写完整凭据或清除配置后保存',
    };
  }
  return {
    id: String(row.id),
    name: String(row.name),
    provider: row.provider,
    enabled: row.enabled,
    configured: credentials.configured,
    configOrigin: credentials.configOrigin,
    chatId: credentials.chatId,
    botTokenConfigured: Boolean(credentials.botToken),
    webhookConfigured: Boolean(credentials.webhookUrl || credentials.serverUrl),
    description:
      credentials.configOrigin === 'database'
        ? '已保存服务器加密配置；空白凭据保留原值'
        : row.provider === 'email'
          ? '配置自定义 SMTP 服务器、发件人与收件人'
          : '使用服务器环境默认配置',
    smtpHost: credentials.smtpHost,
    smtpPort: credentials.smtpPort,
    smtpSecurity: credentials.smtpSecurity,
    smtpUsername: credentials.smtpUsername,
    smtpPasswordConfigured: Boolean(credentials.smtpPassword),
    fromEmail: credentials.fromEmail,
    toEmails: credentials.toEmails,
  };
}
export async function saveNotificationConfig(
  ownerId: string,
  id: string,
  patch: NotificationConfigPatch,
) {
  return sql.begin(async (tx) => {
    const row = (
      await tx<
        ChannelRow[]
      >`SELECT id,name,provider,enabled,data FROM notification_channels WHERE id=${id} AND owner_id=${ownerId} FOR UPDATE`
    )[0];
    if (!row) return null;
    const replacing =
      patch.clearCredentials ||
      (row.provider === 'telegram'
        ? Boolean(patch.botToken && patch.chatId)
        : row.provider === 'feishu'
          ? Boolean(patch.webhookUrl)
          : row.provider === 'bark'
            ? Boolean(patch.serverUrl)
            : row.provider === 'email'
              ? Boolean(
                  patch.smtpPassword &&
                  patch.smtpHost &&
                  patch.smtpPort &&
                  patch.fromEmail &&
                  patch.toEmails?.length,
                )
              : false);
    const old = replacing
      ? NotificationSecretsSchema.parse({})
      : readNotificationConfig(row.provider, row.data);
    const secrets: NotificationSecrets = {
      botToken: patch.clearCredentials ? '' : patch.botToken?.trim() || old.botToken,
      chatId: patch.clearCredentials ? '' : patch.chatId?.trim() || old.chatId,
      webhookUrl: patch.clearCredentials ? '' : patch.webhookUrl?.trim() || old.webhookUrl,
      serverUrl: patch.clearCredentials ? '' : patch.serverUrl?.trim() || old.serverUrl,
      smtpHost: patch.clearCredentials ? '' : patch.smtpHost?.trim() || old.smtpHost,
      smtpPort: patch.clearCredentials ? 587 : (patch.smtpPort ?? old.smtpPort),
      smtpSecurity: patch.clearCredentials ? 'starttls' : (patch.smtpSecurity ?? old.smtpSecurity),
      smtpUsername: patch.clearCredentials ? '' : patch.smtpUsername?.trim() || old.smtpUsername,
      smtpPassword: patch.clearCredentials ? '' : patch.smtpPassword || old.smtpPassword,
      fromEmail: patch.clearCredentials ? '' : patch.fromEmail?.trim() || old.fromEmail,
      toEmails: patch.clearCredentials ? [] : (patch.toEmails ?? old.toEmails),
    };
    // Only create an override when credentials were explicitly changed, preserving env defaults on toggles.
    const touched =
      [
        'botToken',
        'chatId',
        'webhookUrl',
        'serverUrl',
        'smtpHost',
        'smtpPort',
        'smtpSecurity',
        'smtpUsername',
        'smtpPassword',
        'fromEmail',
        'toEmails',
      ].some((key) => Boolean(patch[key as keyof NotificationConfigPatch])) ||
      patch.clearCredentials;
    const oldData =
      row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {};
    const data = touched
      ? {
          ...oldData,
          encryptedCredentials: encryptIntegrationSecret(
            JSON.stringify(secrets),
            `notification:${row.provider}`,
          ),
        }
      : oldData;
    const name = patch.name ?? row.name;
    const enabled = patch.enabled ?? row.enabled;
    await tx`UPDATE notification_channels SET name=${name},enabled=${enabled},data=${tx.json(data as never)} WHERE id=${id}`;
    return notificationConfigView({ ...row, name, enabled, data });
  });
}
