import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';
describe('configuration security', () => {
  it('bounds the paid analysis daily call limit, including the stop value', () => {
    expect(loadConfig({}).aiMaxDailyCalls).toBe(20);
    expect(loadConfig({ AI_MAX_DAILY_CALLS: '0' }).aiMaxDailyCalls).toBe(0);
    for (const value of ['-1', '501', '1.5', 'NaN'])
      expect(() => loadConfig({ AI_MAX_DAILY_CALLS: value })).toThrow();
  });
  it('keeps the free X collector internal and disabled until a server secret is configured', () => {
    expect(loadConfig({}).xCollectorUrl).toBe('http://x-collector:8080');
    expect(loadConfig({}).xCollectorSecret).toBe('');
    for (const url of [
      'http://x-collector:8080',
      'http://127.0.0.1:8080',
      'https://collector.internal',
      'http://10.0.0.3:8080',
      'http://172.16.0.3:8080',
      'http://192.168.1.3:8080',
      'http://[::1]:8080',
      'http://[fd00::3]:8080',
    ])
      expect(loadConfig({ X_COLLECTOR_URL: url }).xCollectorUrl).toBe(url);
    for (const url of [
      'https://api.x.com',
      'https://api.twitter.com',
      'https://collector.example.com',
      'http://8.8.8.8:8080',
      'http://172.32.0.3:8080',
      'http://[2001:4860:4860::8888]:8080',
      'http://user:secret@x-collector:8080',
      'http://x-collector:8080/v1/search',
      'http://x-collector:8080/?session=secret',
      'http://x-collector:8080/#secret',
      'file:///tmp/collector',
    ])
      expect(() => loadConfig({ X_COLLECTOR_URL: url })).toThrow();
    expect(
      loadConfig({ X_COLLECTOR_SECRET: 'synthetic-collector-secret-32-characters' })
        .xCollectorSecret,
    ).toBe('synthetic-collector-secret-32-characters');
    for (const secret of ['short', `${'a'.repeat(32)}\n`, 'x'.repeat(513)])
      expect(() => loadConfig({ X_COLLECTOR_SECRET: secret })).toThrow();
  });
  it('rejects insecure production settings and invalid cookie combinations', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/Production/);
    expect(() => loadConfig({ COOKIE_SAME_SITE: 'None', SECURE_COOKIE: 'false' })).toThrow(
      /Secure/,
    );
    expect(() => loadConfig({ POLL_INTERVAL_SECONDS: '0' })).toThrow();
  });
  it('parses secure production configuration and disables absent providers', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://radar:random-production-password@db/radar',
      ADMIN_PASSWORD: 'production-unique-password',
      SESSION_SECRET: 'x'.repeat(64),
      WEB_ORIGIN: 'https://app.example.com',
      SECURE_COOKIE: 'true',
      DATA_MODE: 'live',
    });
    expect(c.secureCookie).toBe(true);
    expect(c.aiApiKey).toBe('');
    expect(c.dataMode).toBe('live');
  });
  it('parses and bounds repository and known-token scopes', () => {
    const c = loadConfig({
      GITHUB_REPOSITORIES: 'ORDINALS/ORD, unisat-wallet/Unisat, ordinals/ord',
      DEX_CHAIN: 'ethereum',
      DEX_TOKEN_ADDRESSES:
        '0x0000000000000000000000000000000000000001, 0x0000000000000000000000000000000000000001',
    });
    expect(c.githubRepositories).toEqual(['ordinals/ord', 'unisat-wallet/unisat']);
    expect(c.dexChain).toBe('ethereum');
    expect(c.dexTokenAddresses).toEqual(['0x0000000000000000000000000000000000000001']);
    expect(() => loadConfig({ GITHUB_REPOSITORIES: 'invalid' })).toThrow();
    expect(() =>
      loadConfig({ DEX_CHAIN: 'ethereum', DEX_TOKEN_ADDRESSES: 'not-an-address' }),
    ).toThrow();
    expect(() => loadConfig({ DEX_TOKEN_ADDRESSES: '0OIl' })).toThrow();
  });
  it('defaults to XHigh and validates configured AI reasoning effort', () => {
    expect(loadConfig({}).aiReasoningEffort).toBe('xhigh');
    for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh'])
      expect(loadConfig({ AI_REASONING_EFFORT: reasoningEffort }).aiReasoningEffort).toBe(
        reasoningEffort,
      );
    expect(() => loadConfig({ AI_REASONING_EFFORT: 'invalid' })).toThrow();
  });
});
