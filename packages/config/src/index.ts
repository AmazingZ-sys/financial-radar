import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { AIReasoningEffortSchema, DEFAULT_AI_REASONING_EFFORT } from '@radar/shared';
export * from './outbound.js';
loadDotenv({ quiet: true });
const boolean = z.enum(['true', 'false']).transform((s) => s === 'true');
const csv = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const githubRepositories = z
  .string()
  .default('ordinals/ord')
  .transform((value, ctx) => {
    const values = [...new Set(csv(value).map((item) => item.toLowerCase()))];
    if (
      values.length > 20 ||
      values.some(
        (item) =>
          !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(item) ||
          item.endsWith('/.') ||
          item.endsWith('/..'),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'GITHUB_REPOSITORIES 须为最多20个 owner/repository 白名单',
      });
      return z.NEVER;
    }
    return values;
  });
function validSolanaAddress(value: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().default('postgresql://radar:radar_dev_only@127.0.0.1:5432/radar'),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  DATA_MODE: z.enum(['fixture', 'live']).default('fixture'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  ADMIN_EMAIL: z.email().default('admin@radar.local'),
  ADMIN_PASSWORD: z.string().min(12).default('change-me-local-only'),
  SESSION_SECRET: z
    .string()
    .min(32)
    .default('local-only-change-session-secret-at-least-32-characters'),
  SECURE_COOKIE: boolean.default(false),
  COOKIE_SAME_SITE: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
  APP_VERSION: z.string().default('0.0.0-dev'),
  COMMIT_SHA: z.string().default('development'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  FEISHU_WEBHOOK_URL: z.union([z.literal(''), z.url()]).default(''),
  BARK_SERVER_URL: z.union([z.literal(''), z.url()]).default(''),
  SMTP_HOST: z.string().max(255).default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURITY: z.enum(['tls', 'starttls']).default('starttls'),
  SMTP_USERNAME: z.string().max(320).default(''),
  SMTP_PASSWORD: z.string().max(4096).default(''),
  SMTP_FROM_EMAIL: z.union([z.literal(''), z.email()]).default(''),
  SMTP_TO_EMAILS: z.string().default('').transform(csv).pipe(z.array(z.email()).max(20)),
  AI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default(''),
  AI_REASONING_EFFORT: AIReasoningEffortSchema.default(DEFAULT_AI_REASONING_EFFORT),
  AI_DAILY_BUDGET_USD: z.coerce.number().min(0).default(1),
  AI_MAX_CALL_COST_USD: z.coerce.number().min(0).default(0.1),
  INTEGRATION_ENCRYPTION_KEY: z
    .string()
    .refine((value) => !value || value.length >= 32, '集成加密密钥至少 32 个字符')
    .default(''),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_REPOSITORIES: githubRepositories,
  DEX_CHAIN: z
    .enum(['solana', 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc'])
    .default('solana'),
  DEX_TOKEN_ADDRESSES: z.string().default(''),
  UNISAT_API_KEY: z.string().default(''),
  EVM_FACTORY_ADDRESS: z
    .string()
    .regex(/^$|^0x[0-9a-fA-F]{40}$/)
    .default(''),
  SOLANA_PROGRAM_ID: z
    .string()
    .regex(/^$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .default(''),
  EVM_RPC_URL: z.union([z.literal(''), z.url()]).default(''),
  SOLANA_RPC_URL: z.union([z.literal(''), z.url()]).default(''),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(86400).default(60),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const v = schema.parse(env);
  const dexTokenAddresses = [
    ...new Set(
      csv(v.DEX_TOKEN_ADDRESSES).map((value) =>
        v.DEX_CHAIN === 'solana' ? value : value.toLowerCase(),
      ),
    ),
  ];
  if (
    dexTokenAddresses.length > 30 ||
    dexTokenAddresses.some((value) =>
      v.DEX_CHAIN === 'solana' ? !validSolanaAddress(value) : !/^0x[0-9a-f]{40}$/.test(value),
    )
  )
    throw new Error('DEX_TOKEN_ADDRESSES 须为最多30个与 DEX_CHAIN 对应的有效 token 地址');
  if (v.NODE_ENV === 'production') {
    if (
      v.ADMIN_PASSWORD === 'change-me-local-only' ||
      v.SESSION_SECRET.startsWith('local-only') ||
      !v.SECURE_COOKIE ||
      !v.WEB_ORIGIN.startsWith('https://')
    )
      throw new Error(
        'Production requires a unique administrator password, session secret, HTTPS origin and secure cookies',
      );
    if (v.DATABASE_URL.includes('radar_dev_only'))
      throw new Error('Production database credentials must be replaced');
  }
  if (v.COOKIE_SAME_SITE === 'None' && !v.SECURE_COOKIE)
    throw new Error('SameSite=None requires Secure cookies');
  return {
    nodeEnv: v.NODE_ENV,
    port: v.PORT,
    databaseUrl: v.DATABASE_URL,
    redisUrl: v.REDIS_URL,
    dataMode: v.DATA_MODE,
    webOrigin: v.WEB_ORIGIN,
    adminEmail: v.ADMIN_EMAIL,
    adminPassword: v.ADMIN_PASSWORD,
    sessionSecret: v.SESSION_SECRET,
    secureCookie: v.SECURE_COOKIE,
    cookieSameSite: v.COOKIE_SAME_SITE,
    version: v.APP_VERSION,
    commitSha: v.COMMIT_SHA,
    telegramBotToken: v.TELEGRAM_BOT_TOKEN,
    telegramChatId: v.TELEGRAM_CHAT_ID,
    feishuWebhookUrl: v.FEISHU_WEBHOOK_URL,
    barkServerUrl: v.BARK_SERVER_URL,
    smtpHost: v.SMTP_HOST,
    smtpPort: v.SMTP_PORT,
    smtpSecurity: v.SMTP_SECURITY,
    smtpUsername: v.SMTP_USERNAME,
    smtpPassword: v.SMTP_PASSWORD,
    smtpFromEmail: v.SMTP_FROM_EMAIL,
    smtpToEmails: v.SMTP_TO_EMAILS,
    aiBaseUrl: v.AI_BASE_URL,
    aiApiKey: v.AI_API_KEY,
    aiModel: v.AI_MODEL,
    aiReasoningEffort: v.AI_REASONING_EFFORT,
    aiDailyBudgetUsd: v.AI_DAILY_BUDGET_USD,
    aiMaxCallCostUsd: v.AI_MAX_CALL_COST_USD,
    integrationEncryptionKey: v.INTEGRATION_ENCRYPTION_KEY,
    githubToken: v.GITHUB_TOKEN,
    githubRepositories: v.GITHUB_REPOSITORIES,
    dexChain: v.DEX_CHAIN,
    dexTokenAddresses,
    unisatApiKey: v.UNISAT_API_KEY,
    evmRpcUrl: v.EVM_RPC_URL,
    evmFactoryAddress: v.EVM_FACTORY_ADDRESS,
    solanaRpcUrl: v.SOLANA_RPC_URL,
    solanaProgramId: v.SOLANA_PROGRAM_ID,
    pollIntervalSeconds: v.POLL_INTERVAL_SECONDS,
    logLevel: v.LOG_LEVEL,
  };
}
export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig();
