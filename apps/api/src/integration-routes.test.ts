import { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from './http.js';

const mocks = vi.hoisted(() => ({
  config: { dataMode: 'live' as 'live' | 'fixture' },
  fetchPublicHttpsStream: vi.fn(),
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
  fetchPublicHttpsStream: mocks.fetchPublicHttpsStream,
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

function streamResponse(content = '{"ok":true}', finishReason = 'stop', done = true) {
  const frames = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    {
      choices: [
        { index: 0, delta: { reasoning_content: 'synthetic reasoning' }, finish_reason: null },
      ],
    },
    { choices: [{ index: 0, delta: { content: content.slice(0, 5) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: content.slice(5) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const bytes = new TextEncoder().encode(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') +
      (done ? 'data: [DONE]\r\n\r\n' : ''),
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 13)
          controller.enqueue(bytes.slice(offset, offset + 13));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

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
  maxDailyCalls: 20,
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

describe('AI connection test streaming and reasoning effort', () => {
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
    mocks.fetchPublicHttpsStream.mockImplementation(async () => streamResponse());
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
    expect(mocks.fetchPublicHttpsStream).toHaveBeenCalledTimes(1);
    const [url, request] = mocks.fetchPublicHttpsStream.mock.calls[0]!;
    expect(url).toBe('https://relay.example/v1/chat/completions');
    expect(JSON.parse(request.body)).toMatchObject({
      model: effective.model,
      reasoning_effort: 'low',
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
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
    expect(mocks.fetchPublicHttpsStream).not.toHaveBeenCalled();
    expect(mocks.sql.begin).not.toHaveBeenCalled();
    expect(mocks.saveAIConfig).not.toHaveBeenCalled();
  });

  it.each([
    { maxDailyCalls: 0, calls: 0 },
    { maxDailyCalls: 2, calls: 2 },
  ])(
    'stops connection tests at the saved daily cap ($maxDailyCalls)',
    async ({ maxDailyCalls, calls }) => {
      mocks.readAIConfig.mockResolvedValue({ ...effective, maxDailyCalls });
      mocks.sql.mockImplementation(async (query) =>
        (query as TemplateStringsArray).join('').includes('coalesce(sum')
          ? [{ cost: 0, calls }]
          : [],
      );
      const response = await createTestApp().request('/api/v1/integrations/ai/test', {
        method: 'POST',
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('每日预算或调用额度不足');
      expect(mocks.fetchPublicHttpsStream).not.toHaveBeenCalled();
      expect(
        mocks.sql.mock.calls.some((call) =>
          (call[0] as TemplateStringsArray).join('').includes('INSERT INTO ai_analysis_runs'),
        ),
      ).toBe(false);
    },
  );

  it('hot-reads a raised limit and reserves the next connection test against the same UTC budget', async () => {
    mocks.readAIConfig.mockResolvedValueOnce({ ...effective, maxDailyCalls: 2 });
    mocks.readAIConfig.mockResolvedValueOnce({ ...effective, maxDailyCalls: 3 });
    mocks.sql.mockImplementation(async (query) =>
      (query as TemplateStringsArray).join('').includes('coalesce(sum')
        ? [{ cost: 0, calls: 2 }]
        : [],
    );
    const app = createTestApp();
    expect((await app.request('/api/v1/integrations/ai/test', { method: 'POST' })).status).toBe(
      409,
    );
    expect((await app.request('/api/v1/integrations/ai/test', { method: 'POST' })).status).toBe(
      200,
    );
    expect(mocks.fetchPublicHttpsStream).toHaveBeenCalledTimes(1);
    expect(
      mocks.sql.mock.calls.some((call) =>
        (call[0] as TemplateStringsArray)
          .join('')
          .includes("date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"),
      ),
    ).toBe(true);
  });

  it('surfaces an unsupported effort error without retrying another setting', async () => {
    mocks.fetchPublicHttpsStream.mockImplementation(
      async () => new Response('unsupported', { status: 400 }),
    );
    const response = await createTestApp().request('/api/v1/integrations/ai/test', {
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('HTTP 400');
    expect(mocks.fetchPublicHttpsStream).toHaveBeenCalledTimes(1);
    expect(mocks.saveAIConfig).not.toHaveBeenCalled();
  });

  it('reports exhausted output tokens without claiming a successful connection', async () => {
    mocks.fetchPublicHttpsStream.mockImplementation(async () =>
      streamResponse('{"ok":true}', 'length'),
    );
    const response = await createTestApp().request('/api/v1/integrations/ai/test', {
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('AI 服务测试输出达到 token 上限，请检查模型兼容性');
    expect(mocks.fetchPublicHttpsStream).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.saveAIConfig).not.toHaveBeenCalled();
  });

  it('rejects a disconnected stream even when its content is valid JSON', async () => {
    mocks.fetchPublicHttpsStream.mockImplementation(async () =>
      streamResponse('{"ok":true}', 'stop', false),
    );
    const response = await createTestApp().request('/api/v1/integrations/ai/test', {
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('AI 服务流式响应中断，未收到完整测试结果');
    expect(mocks.fetchPublicHttpsStream).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(
      mocks.sql.mock.calls.some((call) =>
        (call[0] as TemplateStringsArray).join('').includes("status='COMPLETED'"),
      ),
    ).toBe(false);
  });

  it('redacts stream error payloads from the response and recorded error', async () => {
    const secret = 'untrusted-upstream-secret';
    mocks.fetchPublicHttpsStream.mockImplementation(
      async () =>
        new Response(`data: ${JSON.stringify({ error: { message: secret } })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    const response = await createTestApp().request('/api/v1/integrations/ai/test', {
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(secret);
    expect(JSON.stringify(mocks.sql.mock.calls)).not.toContain(secret);
    expect(mocks.fetchPublicHttpsStream).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
