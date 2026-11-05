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
const minuteAt = (minute: number) =>
  new Date(Date.parse('2026-01-01T00:00:00.000Z') + minute * 60_000).toISOString();
function stateChange(
  minute: number,
  mintProgress: number,
  stateFingerprint: string,
  previousStateFingerprint: string | null,
  previousStateMinute: number | null,
): ProjectObservation {
  return base({
    evidenceId: `change-${minute}`,
    observedAt: minuteAt(minute),
    availableAt: new Date(Date.parse(minuteAt(minute)) + 1000).toISOString(),
    metrics: {
      mintProgress,
      max: '1000',
      samplingMode: 'state-changes',
      stateFingerprint,
      previousStateFingerprint,
      previousStateObservedAt: previousStateMinute === null ? null : minuteAt(previousStateMinute),
    },
  });
}

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

  it('does not manufacture acceleration when unchanged mint observations are omitted', () => {
    const first = stateChange(0, 0, 'zero', null, null);
    const second = stateChange(11, 10, 'ten', 'zero', 10);
    const current = stateChange(12, 20, 'twenty', 'ten', 11);
    const flat = base({
      evidenceId: 'flat',
      observedAt: minuteAt(10),
      availableAt: minuteAt(10),
      metrics: { mintProgress: 0, max: '1000' },
    });
    const fullPolls = [first, flat, second, current].map((sample) => ({
      ...sample,
      metrics: { mintProgress: sample.metrics.mintProgress, max: '1000' },
    }));
    expect(
      detectHistoricalSignals(fullPolls[3]!, fullPolls.slice(0, 3), minuteAt(13)),
    ).not.toContainEqual(expect.objectContaining({ type: 'MINT_PROGRESS_ACCELERATED' }));
    expect(detectHistoricalSignals(current, [first, second], minuteAt(13))).not.toContainEqual(
      expect.objectContaining({ type: 'MINT_PROGRESS_ACCELERATED' }),
    );
  });

  it('detects genuine acceleration from linked last-confirmed unchanged baselines', () => {
    const first = stateChange(0, 0, 'zero', null, null);
    const second = stateChange(11, 2, 'two', 'zero', 10);
    const current = stateChange(12, 8, 'eight', 'two', 11);
    const acceleration = detectHistoricalSignals(current, [first, second], minuteAt(13)).find(
      (signal) => signal.type === 'MINT_PROGRESS_ACCELERATED',
    );
    expect(acceleration?.metrics).toMatchObject({
      previousRatePpPerHour: 120,
      currentRatePpPerHour: 360,
      accelerationRatio: 3,
      windowSeconds: 60,
    });
    expect(acceleration?.evidenceIds).toEqual(['change-0', 'change-11', 'change-12']);
  });

  it.each([
    { name: 'missing prior fingerprint', target: 2, metrics: { previousStateFingerprint: null } },
    {
      name: 'mismatched prior fingerprint',
      target: 2,
      metrics: { previousStateFingerprint: 'other' },
    },
    {
      name: 'mismatched earlier fingerprint',
      target: 1,
      metrics: { previousStateFingerprint: 'other' },
    },
    { name: 'missing baseline time', target: 2, metrics: { previousStateObservedAt: null } },
    { name: 'malformed baseline time', target: 2, metrics: { previousStateObservedAt: 'invalid' } },
    { name: 'future baseline', target: 2, metrics: { previousStateObservedAt: minuteAt(14) } },
    {
      name: 'baseline equal to target',
      target: 2,
      metrics: { previousStateObservedAt: minuteAt(12) },
    },
    {
      name: 'baseline before prior observation',
      target: 2,
      metrics: { previousStateObservedAt: minuteAt(10) },
    },
    {
      name: 'earlier baseline before prior observation',
      target: 1,
      metrics: { previousStateObservedAt: minuteAt(-1) },
    },
    {
      name: 'current interval below minimum',
      target: 2,
      metrics: { previousStateObservedAt: minuteAt(11.5) },
    },
    {
      name: 'previous interval below minimum',
      target: 1,
      metrics: { previousStateObservedAt: minuteAt(10.5) },
    },
    { name: 'mixed legacy sampling', target: 0, metrics: { samplingMode: null } },
    { name: 'missing state fingerprint', target: 1, metrics: { stateFingerprint: null } },
  ])('rejects change-only acceleration with $name', ({ target, metrics }) => {
    const samples = [
      stateChange(0, 0, 'zero', null, null),
      stateChange(11, 2, 'two', 'zero', 10),
      stateChange(12, 8, 'eight', 'two', 11),
    ].map((sample, index) =>
      index === target ? { ...sample, metrics: { ...sample.metrics, ...metrics } } : sample,
    );
    expect(
      detectHistoricalSignals(samples[2]!, samples.slice(0, 2), minuteAt(15)),
    ).not.toContainEqual(expect.objectContaining({ type: 'MINT_PROGRESS_ACCELERATED' }));
  });

  it('rejects change-only acceleration when a confirmed baseline exceeds the maximum gap', () => {
    const first = stateChange(0, 0, 'zero', null, null);
    const second = stateChange(420, 2, 'two', 'zero', 0);
    const current = stateChange(421, 8, 'eight', 'two', 420);
    expect(detectHistoricalSignals(current, [first, second], minuteAt(422))).not.toContainEqual(
      expect.objectContaining({ type: 'MINT_PROGRESS_ACCELERATED' }),
    );
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
    const conditions = {
      sourceIds: ['source-a'],
      maxAgeSeconds: 60,
      includeRoutineEvents: true,
    };
    const event = {
      eventType: 'NEWS',
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
