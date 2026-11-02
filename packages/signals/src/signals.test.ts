import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  canAggregate,
  scoreOpportunity,
  scoreRisk,
  evaluateRule,
  replay,
  transitionStage,
  normalizeUrl,
} from './index.js';
const event = {
  eventType: 'MINT_STARTED',
  title: 'Protocol open mint',
  originalUrl: 'https://example.com/mint?utm_source=test',
  assetKey: 'ethereum:token:0x01',
  chain: 'Ethereum',
  assets: ['TEST'],
  categories: ['protocol'],
  confidence: 0.9,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  sourcePublishedAt: '2026-01-01T00:00:00.000Z',
  opportunityScore: 75,
  riskScore: 25,
  verificationStatus: 'VERIFIED',
  stage: 'ACTIVE',
  metrics: { mintProgress: 28, participantGrowthPct: 50 },
};
describe('deterministic event identity and independent scores', () => {
  it('canonicalizes tracking without erasing meaningful query parameters', () => {
    expect(normalizeUrl('https://EXAMPLE.com:443/Case?id=1&utm_source=a#section')).toBe(
      'https://example.com/Case?id=1',
    );
  });
  it('never merges same titles from distinct contracts', () => {
    const second = { ...event, assetKey: 'ethereum:token:0x02' };
    expect(fingerprint(event)).not.toBe(fingerprint(second));
    expect(canAggregate(event, second)).toBe(false);
  });
  it('allows matching URLs with tracking parameters to contribute additional evidence', () => {
    expect(canAggregate(event, { ...event, originalUrl: 'https://example.com/mint' })).toBe(true);
  });
  it('does not erase severe risk with opportunity growth', () => {
    expect(
      scoreOpportunity({
        sourceTrust: 1,
        stage: 1,
        freshness: 1,
        participantGrowth: 1,
        conditionTransparency: 1,
        independentConfirmation: 1,
        communityGrowth: 1,
      }).score,
    ).toBe(100);
    expect(scoreRisk({}, ['UNRESTRICTED_MINT']).score).toBeGreaterThanOrEqual(85);
    expect(scoreRisk({}).unknowns).toContain('contractSafety');
  });
  it('does not turn missing inputs into full opportunity scores', () => {
    expect(scoreOpportunity({}).score).toBe(0);
    expect(scoreOpportunity({}).coverage).toBe(0);
    expect(scoreRisk({}).score).toBe(50);
  });
  it('validates percentages, stage, known source, window, and missing metrics', () => {
    expect(
      evaluateRule(
        { minMintProgress: 20, maxMintProgress: 30, stages: ['ACTIVE'], verifiedOnly: true },
        event,
      ).matched,
    ).toBe(true);
    expect(evaluateRule({ maxMintProgress: 20 }, event).matched).toBe(false);
    expect(evaluateRule({ minYieldChangeBps: 5 }, event).matched).toBe(false);
    expect(() => evaluateRule({ expression: 'eval(1)' }, event)).toThrow();
  });
  it('requires evidence for lifecycle and keeps risk separate', () => {
    expect(() => transitionStage('ACTIVE', 'RISK_FLAGGED', ['evidence'])).toThrow();
    expect(() => transitionStage('VERIFIED', 'ACTIVE', [])).toThrow();
    expect(transitionStage('VERIFIED', 'TRADING', ['evidence'])).toBe(true);
  });
});
describe('historical replay does not see future evidence', () => {
  it('filters unavailable inputs and preserves deterministic output', () => {
    const records = [
      { id: 'early', availableAt: '2026-01-01T00:00:00.000Z', event },
      {
        id: 'future',
        availableAt: '2026-02-01T00:00:00.000Z',
        event: { ...event, opportunityScore: 100 },
      },
    ];
    const result = replay(records, { minOpportunityScore: 70 }, '2026-01-02T00:00:00.000Z');
    expect(result.results).toHaveLength(1);
    expect(result.excludedFutureEvidence).toBe(1);
    expect(result.falsePositives).toBeNull();
    expect(result).toEqual(
      replay(records, { minOpportunityScore: 70 }, '2026-01-02T00:00:00.000Z'),
    );
  });
  it('excludes imported records first observed after the replay clock', () => {
    const result = replay(
      [
        {
          id: 'imported',
          availableAt: '2025-01-01T00:00:00Z',
          event: { ...event, firstSeenAt: '2026-06-01T00:00:00Z' },
        },
      ],
      {},
      '2026-01-02T00:00:00Z',
    );
    expect(result.results).toHaveLength(0);
  });
});
