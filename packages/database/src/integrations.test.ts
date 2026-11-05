import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '@radar/config';

const mocks = vi.hoisted(() => ({
  sql: Object.assign(vi.fn<(...args: unknown[]) => Promise<unknown[]>>(), {
    begin: vi.fn(),
    json: (value: unknown) => value,
  }),
}));
vi.mock('./index.js', () => ({ sql: mocks.sql, closeDatabase: vi.fn(async () => {}) }));
import {
  encryptIntegrationSecret,
  decryptIntegrationSecret,
  aiConfigView,
  notificationConfigView,
  readNotificationConfig,
  readAIConfig,
  saveAIConfig,
} from './integrations.js';
import { closeDatabase } from './index.js';
afterAll(async () => closeDatabase());
describe('integration credential storage', () => {
  it('encrypts with unique nonces, authenticates context, and rejects tampering', () => {
    const one = encryptIntegrationSecret('sample-secret-for-test', 'ai');
    const two = encryptIntegrationSecret('sample-secret-for-test', 'ai');
    expect(one).not.toBe(two);
    expect(one).not.toContain('sample-secret');
    expect(decryptIntegrationSecret(one, 'ai')).toBe('sample-secret-for-test');
    expect(() => decryptIntegrationSecret(one, 'notification')).toThrow('无法解密');
    expect(() => decryptIntegrationSecret(one.slice(0, -4) + 'abcd', 'ai')).toThrow('无法解密');
    const empty = encryptIntegrationSecret('', 'ai');
    expect(decryptIntegrationSecret(empty, 'ai')).toBe('');
  });
  it('does not expose API keys in the safe configuration view', () => {
    const view = aiConfigView({
      name: 'Relay',
      enabled: true,
      baseUrl: 'https://relay.example/v1',
      apiKey: 'only-server-knows',
      model: 'model-a',
      reasoningEffort: 'high',
      timeoutMs: 20000,
      jsonMode: true,
      dailyBudgetUsd: 1,
      maxCallCostUsd: 0.1,
      maxDailyCalls: 20,
      configOrigin: 'database',
      hasOverride: true,
    });
    expect(view.apiKeyConfigured).toBe(true);
    expect(view.reasoningEffort).toBe('high');
    expect(JSON.stringify(view)).not.toContain('only-server-knows');
    expect(view).not.toHaveProperty('apiKey');
  });
  it('keeps damaged notification credentials repairable in views while sending rejects them', () => {
    const data = { encryptedCredentials: 'corrupt-ciphertext-never-render' };
    const view = notificationConfigView({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Telegram',
      provider: 'telegram',
      enabled: true,
      data,
    });
    expect(view.configured).toBe(false);
    expect(view.configOrigin).toBe('database');
    expect(view.chatId).toBe('');
    expect(view.botTokenConfigured).toBe(false);
    expect(view.webhookConfigured).toBe(false);
    expect(view.description).toContain('重新填写完整凭据');
    expect(JSON.stringify(view)).not.toContain('corrupt-ciphertext');
    expect(() => readNotificationConfig('telegram', data)).toThrow('无法解密');
  });
  it('exposes SMTP email configuration without revealing its password', () => {
    const encryptedCredentials = encryptIntegrationSecret(
      JSON.stringify({
        smtpHost: 'smtp.example.com',
        smtpPort: 2525,
        smtpSecurity: 'starttls',
        smtpUsername: 'alerts@example.com',
        smtpPassword: 'never-render-this',
        fromEmail: 'alerts@example.com',
        toEmails: ['admin@example.com'],
      }),
      'notification:email',
    );
    const view = notificationConfigView({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'SMTP 邮箱',
      provider: 'email',
      enabled: true,
      data: { encryptedCredentials },
    });
    expect(view).toMatchObject({
      provider: 'email',
      configured: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 2525,
      smtpSecurity: 'starttls',
      smtpUsername: 'alerts@example.com',
      smtpPasswordConfigured: true,
      fromEmail: 'alerts@example.com',
      toEmails: ['admin@example.com'],
    });
    expect(JSON.stringify(view)).not.toContain('never-render-this');
    expect(view).not.toHaveProperty('smtpPassword');
  });
});

describe('managed AI daily call limit storage', () => {
  const initialLimit = config.aiMaxDailyCalls;
  let stored: Record<string, unknown> | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    config.aiMaxDailyCalls = 37;
    stored = undefined;
    mocks.sql.begin.mockImplementation(
      async (transaction: (tx: typeof mocks.sql) => Promise<unknown>) => transaction(mocks.sql),
    );
    mocks.sql.mockImplementation(async (query, ...parameters) => {
      const text = (query as TemplateStringsArray).join('');
      if (text.includes('SELECT data FROM system_settings'))
        return stored ? [{ data: stored }] : [];
      if (text.includes('INSERT INTO system_settings'))
        stored = parameters.find(
          (value): value is Record<string, unknown> =>
            value !== null && typeof value === 'object' && 'encryptedApiKey' in value,
        );
      return [];
    });
  });
  afterEach(() => {
    config.aiMaxDailyCalls = initialLimit;
  });

  it('uses the server environment for absent storage and legacy records without the field', async () => {
    expect((await readAIConfig()).maxDailyCalls).toBe(37);
    stored = {
      name: 'Legacy relay',
      enabled: true,
      baseUrl: 'https://relay.example/v1',
      model: 'model-a',
      timeoutMs: 20000,
      jsonMode: true,
      dailyBudgetUsd: 1,
      maxCallCostUsd: 0.1,
      encryptedApiKey: encryptIntegrationSecret('legacy-test-key', 'integrations:ai'),
    };
    expect((await readAIConfig()).maxDailyCalls).toBe(37);
    expect((await saveAIConfig({ name: 'Renamed legacy relay' })).maxDailyCalls).toBe(37);
    expect(stored.maxDailyCalls).toBe(37);
  });

  it('persists zero and hot-reads edits without resetting the limit on unrelated PATCHes', async () => {
    expect((await saveAIConfig({ maxDailyCalls: 0 })).maxDailyCalls).toBe(0);
    expect((await readAIConfig()).maxDailyCalls).toBe(0);
    config.aiMaxDailyCalls = 80;
    expect((await saveAIConfig({ name: 'Renamed relay' })).maxDailyCalls).toBe(0);
    expect((await readAIConfig()).maxDailyCalls).toBe(0);
    expect((await saveAIConfig({ maxDailyCalls: 4 })).maxDailyCalls).toBe(4);
    expect((await readAIConfig()).maxDailyCalls).toBe(4);
  });
});
