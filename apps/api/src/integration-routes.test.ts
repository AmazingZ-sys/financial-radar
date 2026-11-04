import { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from './http.js';

const mocks = vi.hoisted(() => ({
  config: { dataMode: 'live' as 'live' | 'fixture' },
  fetchPublicHttps: vi.fn(),
  readAIConfig: vi.fn(),
  saveAIConfig: vi.fn(),
  audit: vi.fn(),
  rateLimit: vi.fn(),
  sql: Object.assign(vi.fn<(...args: unknown[]) => Promise<unknown[]>>(), {
    begin: vi.fn(),
    json: (value: unknown) => value,
  }),
}));
vi.mock('@radar/config', () => ({
  config: mocks.config,
  fetchPublicHttps: mocks.fetchPublicHttps,
  assertPublicHttpsUrl: vi.fn(),
}));
vi.mock('@radar/database', () => ({
  sql: mocks.sql,
  readAIConfig: mocks.readAIConfig,
  saveAIConfig: mocks.saveAIConfig,
  aiConfigView: vi.fn(),
}));
vi.mock('./security.js', () => ({
  audit: mocks.audit,
  rateLimit: mocks.rateLimit,
}));
import { integrationRoutes } from './integration-routes.js';

const effective = {
  name: 'Synthetic relay',
  enabled: true,
  baseUrl: 'https://relay.example/v1',
  apiKey: 'synthetic-test-key',
  model: 'synthetic-model',
  timeoutMs: 1000,
  jsonMode: true,
  reasoningEffort: 'xhigh',
  dailyBudgetUsd: 2,
  maxCallCostUsd: 0.05,
  configOrigin: 'database',
  hasOverride: true,
};

function createTestApp() {
  const app = new OpenAPIHono<ApiEnv>();
  app.use('*', async (c, next) => {
    // Authentication/CSRF are covered separately; this app isolates the connection test handler.
    c.set('actor', { id: 'actor', email: 'admin@example.com', role: 'admin', csrfToken: 'test' });
    await next();
  });
  integrationRoutes(app);
  return app;
}

describe('AI connection test reasoning effort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.dataMode = 'live';
    mocks.readAIConfig.mockResolvedValue({ ...effective });
    mocks.sql.mockImplementation(async (query) =>
      (query as TemplateStringsArray).join('').includes('coalesce(sum')
        ? [{ cost: 0, calls: 0 }]
        : [],
    );
    mocks.sql.begin.mockImplementation(
      async (transaction: (tx: typeof mocks.sql) => Promise<unknown>) => transaction(mocks.sql),
    );
    mocks.fetchPublicHttps.mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
    );
  });

  it('uses Low for an XHigh configuration without changing saved analysis settings', async () => {
    const response = await createTestApp().request('/api/v1/integrations/ai/test', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      status: 'connected',
      model: effective.model,
      reasoningEffort: 'low',
    });
    expect(mocks.fetchPublicHttps).toHaveBeenCalledTimes(1);
    const [url, request] = mocks.fetchPublicHttps.mock.calls[0]!;
    expect(url).toBe('https://relay.example/v1/chat/completions');
    expect(JSON.parse(request.body)).toMatchObject({
      model: effective.model,
      reasoning_effort: 'low',
      max_tokens: 512,
    });
    expect(
      mocks.sql.mock.calls.some((call) =>
        call.some(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            'reasoningEffort' in value &&
            value.reasoningEffort === 'low',
        ),
      ),
    ).toBe(true);
    expect((await mocks.readAIConfig()).reasoningEffort).toBe('xhigh');
    expect(mocks.saveAIConfig).not.toHaveBeenCalled();
  });

  it('skips Fixture transport while reporting Low as the test setting', async () => {
    mocks.config.dataMode = 'fixture';
    const response = await createTestApp().request('/api/v1/integrations/ai/test', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      status: 'skipped',
      reasoningEffort: 'low',
    });
    expect(mocks.fetchPublicHttps).not.toHaveBeenCalled();
    expect(mocks.sql.begin).not.toHaveBeenCalled();
    expect(mocks.saveAIConfig).not.toHaveBeenCalled();
  });

  it('surfaces an unsupported effort error without retrying another setting', async () => {
    mocks.fetchPublicHttps.mockImplementation(
      async () => new Response('unsupported', { status: 400 }),
    );
    const response = await createTestApp().request('/api/v1/integrations/ai/test', {
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('HTTP 400');
    expect(mocks.fetchPublicHttps).toHaveBeenCalledTimes(1);
    expect(mocks.saveAIConfig).not.toHaveBeenCalled();
  });

  it('reports exhausted output tokens without claiming a successful connection', async () => {
    mocks.fetchPublicHttps.mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    );
    const response = await createTestApp().request('/api/v1/integrations/ai/test', {
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('AI 服务测试输出达到 token 上限，请检查模型兼容性');
    expect(mocks.fetchPublicHttps).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.saveAIConfig).not.toHaveBeenCalled();
  });
});
