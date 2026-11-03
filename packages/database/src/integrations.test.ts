import { afterAll, describe, expect, it } from 'vitest';
import {
  encryptIntegrationSecret,
  decryptIntegrationSecret,
  aiConfigView,
  notificationConfigView,
  readNotificationConfig,
} from './integrations.js';
import { closeDatabase } from './index.js';
afterAll(closeDatabase);
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
      timeoutMs: 20000,
      jsonMode: true,
      dailyBudgetUsd: 1,
      maxCallCostUsd: 0.1,
      configOrigin: 'database',
      hasOverride: true,
    });
    expect(view.apiKeyConfigured).toBe(true);
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
});
