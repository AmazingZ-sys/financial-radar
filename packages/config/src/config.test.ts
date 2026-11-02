import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';
describe('configuration security', () => {
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
});
