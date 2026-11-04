import { describe, expect, it } from 'vitest';
import {
  CompatibleAIProvider,
  FixtureAIProvider,
  validateEvidence,
  analysisCacheKey,
  compatibleAIProviderIdentity,
} from './index.js';
const input = {
  eventId: 'event',
  assets: ['BTC'],
  evidence: [
    {
      id: 'e1',
      title: 'Evidence',
      text: 'Source verified this release.',
      url: 'https://example.com/release',
      availableAt: '2026-01-01T00:00:00Z',
    },
  ],
};
describe('AI evidence contract', () => {
  it('ties fixture facts to actual evidence IDs', async () => {
    const result = await new FixtureAIProvider().analyze(input);
    expect(result.result.evidenceIds).toEqual(['e1']);
    expect(result.provider).toBe('fixture');
  });
  it('rejects unknown evidence IDs and fabricated links', async () => {
    const { result } = await new FixtureAIProvider().analyze(input);
    expect(() => validateEvidence({ ...result, evidenceIds: ['imaginary'] }, input)).toThrow(
      '证据',
    );
    expect(() =>
      validateEvidence({ ...result, summary: '参见 https://evil.example/claim' }, input),
    ).toThrow('链接');
    expect(() =>
      validateEvidence(
        { ...result, keyFacts: [{ text: 'invented', kind: 'fact', evidenceIds: [] }] },
        input,
      ),
    ).toThrow('缺少证据');
  });
  it('cache keys change with evidence/model while staying deterministic', () => {
    expect(analysisCacheKey(input, 'model-a')).not.toBe(analysisCacheKey(input, 'model-b'));
    expect(analysisCacheKey(input, 'model-a')).toBe(analysisCacheKey(input, 'model-a'));
    expect(analysisCacheKey(input, 'model-a', 'relay-a')).not.toBe(
      analysisCacheKey(input, 'model-a', 'relay-b'),
    );
  });
  it('isolates cached results by reasoning effort without exposing credentials', () => {
    const config = {
      baseUrl: 'https://relay.example/v1',
      apiKey: 'synthetic-test-key',
      jsonMode: true,
      reasoningEffort: 'xhigh' as const,
    };
    const identity = compatibleAIProviderIdentity(config);
    const key = analysisCacheKey(input, 'relay-model', identity);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(identity).not.toContain(config.apiKey);
    expect(compatibleAIProviderIdentity({ ...config })).toBe(identity);
    for (const changed of [
      { reasoningEffort: 'low' as const },
      { baseUrl: 'https://another-relay.example/v1' },
      { apiKey: 'another-synthetic-test-key' },
      { jsonMode: false },
    ])
      expect(
        analysisCacheKey(
          input,
          'relay-model',
          compatibleAIProviderIdentity({ ...config, ...changed }),
        ),
      ).not.toBe(key);
  });
  it('uses a configured relay root/model and can omit unsupported JSON mode', async () => {
    const output = (await new FixtureAIProvider().analyze(input)).result;
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (url, options) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(options?.body));
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer relay-test-secret');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }),
      );
    };
    const result = await new CompatibleAIProvider(
      'https://relay.example/custom/v1/',
      'relay-test-secret',
      'relay-model',
      fetcher,
      1000,
      false,
    ).analyze(input);
    expect(requestUrl).toBe('https://relay.example/custom/v1/chat/completions');
    expect(requestBody.model).toBe('relay-model');
    expect(requestBody.reasoning_effort).toBe('xhigh');
    expect(requestBody).not.toHaveProperty('response_format');
    expect(result.model).toBe('relay-model');
  });
  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'sends the configured %s reasoning effort to the analysis provider',
    async (reasoningEffort) => {
      const output = (await new FixtureAIProvider().analyze(input)).result;
      let requestBody: Record<string, unknown> = {};
      const fetcher: typeof fetch = async (_url, options) => {
        requestBody = JSON.parse(String(options?.body));
        return Response.json({
          choices: [{ message: { content: JSON.stringify(output) } }],
        });
      };
      await new CompatibleAIProvider(
        'https://relay.example/v1',
        'synthetic-test-key',
        'relay-model',
        fetcher,
        1000,
        true,
        reasoningEffort,
      ).analyze(input);
      expect(requestBody.reasoning_effort).toBe(reasoningEffort);
      expect(requestBody.response_format).toEqual({ type: 'json_object' });
    },
  );
  it('keeps untrusted malformed completion bodies out of persisted error messages', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'untrusted-body-containing-a-secret' } }],
        }),
      );
    await expect(
      new CompatibleAIProvider(
        'https://relay.example/v1',
        'test-key',
        'relay-model',
        fetcher,
      ).analyze(input),
    ).rejects.toThrow('AI completion 未返回有效 JSON');
  });
});
