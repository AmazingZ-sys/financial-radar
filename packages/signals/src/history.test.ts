import { describe, expect, it } from 'vitest';
import {
  detectHistoricalSignals,
  detectParticipationWindow,
  evaluateRule,
  scoreRisk,
  type ProjectObservation,
} from './index.js';

const base = (overrides: Partial<ProjectObservation> = {}): ProjectObservation => ({
  evidenceId: 'e0',
  sourceId: 'source-a',
  assetKey: 'asset-a',
  dataMode: 'fixture',
  observedAt: '2026-01-01T00:00:00.000Z',
  availableAt: '2026-01-01T00:00:01.000Z',
  metrics: {},
  stage: 'EARLY_STAGE',
  verificationStatus: 'VERIFIED',
  confidence: 0.9,
  conditionsVerified: true,
  conditions: 'allowlist',
  startsAt: null,
  endsAt: '2026-01-01T04:00:00.000Z',
  ...overrides,
});

describe('historical opportunity detection', () => {
  it('normalizes mint rates, requires three samples, and rejects max supply revisions', () => {
    const first = base({ evidenceId: 'e1', metrics: { mintProgress: 0, max: '1000' } });
    const second = base({
      evidenceId: 'e2',
      observedAt: '2026-01-01T01:00:00.000Z',
      availableAt: '2026-01-01T01:00:01.000Z',
      metrics: { mintProgress: 2, max: '1000' },
    });
    const current = base({
      evidenceId: 'e3',
      observedAt: '2026-01-01T02:00:00.000Z',
      availableAt: '2026-01-01T02:00:01.000Z',
      metrics: { mintProgress: 8, max: '1000' },
    });
    expect(
      detectHistoricalSignals(current, [first, second], '2026-01-01T02:00:02.000Z').map(
        (x) => x.type,
      ),
    ).toContain('MINT_PROGRESS_ACCELERATED');
    expect(
      detectHistoricalSignals(
        { ...current, metrics: { mintProgress: 8, max: '1100' } },
        [first, second],
        '2026-01-01T02:00:02.000Z',
      ),
    ).not.toContainEqual(expect.objectContaining({ type: 'MINT_PROGRESS_ACCELERATED' }));
    expect(
      detectHistoricalSignals(
        { ...current, metrics: { mintProgress: 8 } },
        [first, second],
        '2026-01-01T02:00:02.000Z',
      ),
    ).not.toContainEqual(expect.objectContaining({ type: 'MINT_PROGRESS_ACCELERATED' }));
  });

  it('does not mistake holder counts for unique participants', () => {
    const previous = base({ evidenceId: 'e1', metrics: { holders: 10 } });
    const current = base({
      evidenceId: 'e2',
      observedAt: '2026-01-01T01:00:00.000Z',
      availableAt: '2026-01-01T01:00:01.000Z',
      metrics: { holders: 100 },
    });
    expect(
      detectHistoricalSignals(current, [previous], '2026-01-01T01:00:02.000Z'),
    ).not.toContainEqual(expect.objectContaining({ type: 'UNIQUE_PARTICIPANTS_SPIKE' }));
    const positive = detectHistoricalSignals(
      { ...current, metrics: { uniqueParticipants: 100, holders: 1 } },
      [{ ...previous, metrics: { uniqueParticipants: 20, holders: 999 } }],
      '2026-01-01T01:00:02.000Z',
    );
    expect(
      positive.find((signal) => signal.type === 'UNIQUE_PARTICIPANTS_SPIKE')?.metrics
        .participantGrowthPct,
    ).toBe(400);
  });

  it('does not report acceleration when unequal intervals have the same rate', () => {
    const observations = [0, 1, 4].map((hour, index) =>
      base({
        evidenceId: `rate-${index}`,
        observedAt: `2026-01-01T0${hour}:00:00.000Z`,
        availableAt: `2026-01-01T0${hour}:00:01.000Z`,
        metrics: { mintProgress: hour * 2, max: '1000' },
      }),
    );
    expect(
      detectHistoricalSignals(
        observations[2]!,
        observations.slice(0, 2),
        '2026-01-01T04:00:02.000Z',
      ),
    ).not.toContainEqual(expect.objectContaining({ type: 'MINT_PROGRESS_ACCELERATED' }));
  });

  it('excludes future evidence, different sources/modes and late observations', () => {
    const previous = base({ metrics: { uniqueParticipants: 10 } });
    const current = base({
      evidenceId: 'new',
      observedAt: '2026-01-01T01:00:00.000Z',
      availableAt: '2026-01-01T01:00:01.000Z',
      metrics: { uniqueParticipants: 100 },
    });
    const at = '2026-01-01T01:00:02.000Z';
    for (const history of [
      [{ ...previous, sourceId: 'other' }],
      [{ ...previous, dataMode: 'live' as const }],
      [{ ...previous, availableAt: '2026-01-01T02:00:00.000Z' }],
      [{ ...previous, observedAt: current.observedAt, availableAt: current.availableAt }],
    ])
      expect(detectHistoricalSignals(current, history, at)).toEqual([]);
    expect(detectHistoricalSignals(current, [previous], '2026-01-01T00:30:00.000Z')).toEqual([]);
    expect(detectHistoricalSignals(previous, [current], at)).toEqual([]);
  });

  it('requires matching count windows and preserves critical liquidity risk', () => {
    const previous = base({
      metrics: {
        liquidityUsd: 20000,
        volumeUsd: 1000,
        volumeWindowSeconds: 3600,
        socialMentions: 20,
        socialWindowSeconds: 3600,
      },
    });
    const current = base({
      evidenceId: 'new',
      observedAt: '2026-01-01T01:00:00.000Z',
      availableAt: '2026-01-01T01:00:01.000Z',
      metrics: {
        liquidityUsd: 5000,
        volumeUsd: 10000,
        volumeWindowSeconds: 86400,
        socialMentions: 100,
        socialWindowSeconds: 86400,
      },
    });
    const signals = detectHistoricalSignals(current, [previous], '2026-01-01T01:00:02.000Z');
    expect(signals.map((signal) => signal.type)).toEqual(['LIQUIDITY_REMOVED']);
    expect(scoreRisk({}, signals[0]!.riskFlags).score).toBeGreaterThanOrEqual(85);
  });

  it('requires a non-empty, well formed participation interval and follows the clock', () => {
    const equal = base({ startsAt: '2026-01-01T04:00:00.000Z' });
    expect(detectParticipationWindow(equal, '2026-01-01T03:30:00.000Z')).toEqual([]);
    const expiring = base({ endsAt: '2026-01-01T03:30:00.000Z' });
    expect(detectParticipationWindow(expiring, '2026-01-01T03:00:00.000Z')[0]?.type).toBe(
      'PARTICIPATION_WINDOW_EXPIRING',
    );
    expect(detectParticipationWindow(expiring, '2026-01-01T03:31:00.000Z')[0]?.type).toBe(
      'PARTICIPATION_WINDOW_EXPIRED',
    );
    for (const observation of [
      base({ startsAt: 'malformed' }),
      base({ endsAt: 'malformed' }),
      base({ conditionsVerified: false }),
      base({ conditions: null }),
      base({ verificationStatus: 'UNVERIFIED' }),
    ])
      expect(detectParticipationWindow(observation, '2026-01-01T04:30:00.000Z')).toEqual([]);
  });

  it('matches rule source and rejects negative/future event ages', () => {
    const conditions = { sourceIds: ['source-a'], maxAgeSeconds: 60 };
    const event = {
      eventType: 'MINT_STARTED',
      sourceId: 'source-a',
      assets: [],
      categories: [],
      confidence: 1,
      opportunityScore: 1,
      riskScore: 1,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
    };
    expect(evaluateRule(conditions, event, Date.parse('2026-01-01T00:00:30.000Z')).matched).toBe(
      true,
    );
    expect(evaluateRule(conditions, event, Date.parse('2025-12-31T23:59:00.000Z')).matched).toBe(
      false,
    );
    expect(
      evaluateRule(
        { ...conditions, sourceIds: ['source-b'] },
        event,
        Date.parse('2026-01-01T00:00:30.000Z'),
      ).matched,
    ).toBe(false);
  });
});
