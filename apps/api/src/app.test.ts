import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { redis } from './security.js';
import { closeDatabase, hashPassword, verifyPassword } from '@radar/database';
import { RuleInputSchema, SettingsSchema, SourceIdSchema } from '@radar/shared';
import { loadConfig } from '@radar/config';
import { GitHubReleasesConnector } from '../../../packages/connectors/src/live.js';
const app = createApp();
afterAll(async () => {
  redis.disconnect();
  await closeDatabase();
});
describe('HTTP trust boundary', () => {
  it('protects event reads and rule writes without session credentials', async () => {
    for (const [path, method] of [
      ['/api/v1/events', 'GET'],
      ['/api/v1/integrations/ai', 'GET'],
      ['/api/v1/integrations/ai', 'PATCH'],
      ['/api/v1/integrations/ai/test', 'POST'],
      ['/api/v1/sources/catalog', 'GET'],
      ['/api/v1/integrations/sources', 'GET'],
      ['/api/v1/integrations/sources', 'PATCH'],
      ['/api/v1/sources', 'POST'],
      ['/api/v1/notification-channels', 'GET'],
      ['/api/v1/alert-rules', 'POST'],
      ['/api/v1/notifications/00000000-0000-4000-8000-000000000000/retry', 'POST'],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.requestId).toBeTruthy();
      expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    }
  });
  it('rejects a forged cross origin login before password verification', async () => {
    const response = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
      body: JSON.stringify({ email: 'admin@radar.local', password: 'password-does-not-matter' }),
    });
    expect(response.status).toBe(403);
  });
  it('exposes a health endpoint with security headers and no secrets', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.json();
    expect(body.data.status).toBe('ok');
    expect(JSON.stringify(body)).not.toMatch(/password|token|databaseUrl/i);
  });
  it('generates paths and parameter schemas from the actual routes', async () => {
    const response = await app.request('/openapi.json');
    const spec = await response.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/api/v1/projects/{id}'].get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]),
    );
    expect(spec.paths['/api/v1/alert-rules'].post.requestBody.required).toBe(true);
  });
});
describe('declarative configuration and password storage', () => {
  it('accepts a configured GitHub source ID longer than 150 characters in source routes and rules', () => {
    const repository = `${'a'.repeat(39)}/${'b'.repeat(100)}`;
    const config = loadConfig({ GITHUB_REPOSITORIES: repository });
    const sourceId = new GitHubReleasesConnector(undefined, config.githubRepositories[0]).metadata
      .id;
    expect(sourceId.length).toBeGreaterThan(150);
    expect(SourceIdSchema.parse(sourceId)).toBe(sourceId);
    expect(
      RuleInputSchema.parse({ name: 'long-source', conditions: { sourceIds: [sourceId] } })
        .conditions.sourceIds,
    ).toEqual([sourceId]);
    expect(SourceIdSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });
  it('rejects executable, out of range and unrecognized rule conditions', () => {
    expect(
      RuleInputSchema.safeParse({ name: 'invalid', conditions: { expression: 'process.exit()' } })
        .success,
    ).toBe(false);
    expect(
      RuleInputSchema.safeParse({ name: 'invalid', conditions: { minConfidence: 2 } }).success,
    ).toBe(false);
    expect(SettingsSchema.safeParse({ timezone: 'not-a-timezone' }).success).toBe(false);
  });
  it('uses independently salted password hashes and rejects wrong passwords', async () => {
    const one = await hashPassword('correct-password-123');
    const two = await hashPassword('correct-password-123');
    expect(one).not.toBe(two);
    expect(one).not.toContain('correct-password');
    expect(await verifyPassword('correct-password-123', one)).toBe(true);
    expect(await verifyPassword('wrong-password', one)).toBe(false);
    expect(await verifyPassword('anything', 'broken')).toBe(false);
  });
});
