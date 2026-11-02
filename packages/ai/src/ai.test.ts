import { describe, expect, it } from 'vitest';
import { FixtureAIProvider, validateEvidence, analysisCacheKey } from './index.js';
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
  });
});
