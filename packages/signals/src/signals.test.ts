import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  canAggregate,
  scoreOpportunity,
  scoreRisk,
  evaluateNotificationAdmission,
  evaluateRule,
  replay,
  transitionStage,
  normalizeUrl,
} from './index.js';
const event = {
  eventType: 'MINT_PROGRESS_ACCELERATED',
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
  project: { stage: 'ACTIVE', conditions: '已核验的公开参与条件' },
  conditionsVerified: true,
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
        {
          minMintProgress: 20,
          maxMintProgress: 30,
          stages: ['ACTIVE'],
          verifiedOnly: true,
          includeRoutineEvents: true,
        },
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
describe('notification admission requires evidenced opportunities', () => {
  it.each([
    'PAIR_CREATED',
    'NEW_TRADING_PAIR',
    'TOKEN_DEPLOYED',
    'NEW_TOKEN_DEPLOYED',
    'MINT_CREATED',
    'MINT_STARTED',
    'TOKEN_STATE_SNAPSHOT',
    'LIQUIDITY_SNAPSHOT',
  ])('keeps %s as observation even with legacy opt-in and high verified scores', (eventType) => {
    const routine = { ...event, eventType };
    expect(evaluateRule({}, routine).matched).toBe(false);
    expect(evaluateRule({ includeRoutineEvents: false }, routine).matched).toBe(false);
    expect(evaluateRule({ eventTypes: [eventType] }, routine).matched).toBe(false);
    expect(evaluateRule({ includeRoutineEvents: true }, routine).matched).toBe(false);
    expect(evaluateNotificationAdmission(routine).matched).toBe(false);
  });
  it.each([
    { verificationStatus: 'UNVERIFIED' },
    { confidence: 0.799 },
    { opportunityScore: 64 },
    { riskScore: 61 },
    { confidence: NaN },
    { opportunityScore: NaN },
    { riskScore: NaN },
    { project: { stage: 'TRADING', conditions: '已核验' } },
    { conditionsVerified: false },
    { project: { stage: 'ACTIVE', conditions: '  ' } },
    { project: undefined },
  ])('rejects a chain growth signal missing a required opportunity condition: %j', (patch) => {
    expect(evaluateRule({ includeRoutineEvents: true }, { ...event, ...patch }).matched).toBe(
      false,
    );
  });
  it.each(['EARLY_STAGE', 'ACTIVE'])(
    'accepts qualifying opportunities in %s at the boundaries',
    (stage) => {
      const opportunity = {
        ...event,
        confidence: 0.8,
        opportunityScore: 65,
        riskScore: 60,
        project: { ...event.project, stage },
      };
      expect(evaluateNotificationAdmission(opportunity).matched).toBe(true);
      expect(evaluateRule({}, opportunity).matched).toBe(true);
      expect(evaluateRule({ minOpportunityScore: 70 }, opportunity).matched).toBe(false);
    },
  );
  it.each([
    { eventType: 'MINT_PROGRESS_ACCELERATED' },
    { eventType: 'LIQUIDITY_ADDED' },
    { eventType: 'VOLUME_SPIKE' },
    { eventType: 'PROJECT_LAUNCHED' },
    { eventType: 'PARTICIPATION_WINDOW_EXPIRING' },
    { eventType: 'OTHER', chain: 'Ethereum' },
    { eventType: 'OTHER', assetKey: 'bitcoin:brc20:test' },
    { eventType: 'OTHER', project: { stage: 'ACTIVE', conditions: '待核验' } },
  ])('recognizes chain opportunities without relying on a specific connector: %j', (identity) => {
    expect(
      evaluateNotificationAdmission({
        ...event,
        chain: undefined,
        assetKey: undefined,
        project: undefined,
        conditionsVerified: false,
        ...identity,
      }).matched,
    ).toBe(false);
  });
  it.each(['NEWS', 'OFFICIAL_ANNOUNCEMENT', 'PROTOCOL_RELEASE', 'X_HOT_TOPIC'])(
    'preserves the existing non-chain %s rules',
    (eventType) => {
      expect(
        evaluateRule(
          {},
          {
            ...event,
            eventType,
            chain: undefined,
            assetKey: undefined,
            project: undefined,
            conditionsVerified: false,
            verificationStatus: 'UNVERIFIED',
            confidence: 0.65,
            opportunityScore: 0,
          },
        ).matched,
      ).toBe(true);
    },
  );
  it('keeps market snapshot opt-in and rejects malformed rule values', () => {
    const market = {
      ...event,
      eventType: 'MARKET_SNAPSHOT',
      chain: undefined,
      assetKey: undefined,
      project: undefined,
    };
    expect(evaluateRule({}, market).matched).toBe(false);
    expect(evaluateRule({ includeRoutineEvents: true }, market).matched).toBe(true);
    expect(() => evaluateRule({ includeRoutineEvents: 'true' }, event)).toThrow();
  });
  it.each(['PHISHING', 'UNRESTRICTED_MINT', 'LIQUIDITY_REMOVAL'])(
    'keeps confirmed %s eligible through either persisted or live risk evidence',
    (flag) => {
      const critical = {
        ...event,
        eventType: 'TOKEN_STATE_SNAPSHOT',
        verificationStatus: 'UNVERIFIED',
        confidence: 0.1,
        opportunityScore: 0,
        riskScore: 90,
        conditionsVerified: false,
      };
      expect(evaluateNotificationAdmission({ ...critical, riskFlags: [flag] }).matched).toBe(true);
      expect(evaluateRule({}, { ...critical, riskFlags: [flag] }).matched).toBe(true);
      expect(
        evaluateRule({}, { ...critical, riskBreakdown: { critical: true, flags: [flag] } }).matched,
      ).toBe(true);
    },
  );
  it('does not infer confirmed critical risk from a high score or an unknown flag', () => {
    const raw = { ...event, eventType: 'PAIR_CREATED' };
    expect(evaluateRule({}, { ...raw, riskScore: 100 }).matched).toBe(false);
    expect(evaluateRule({}, { ...raw, riskFlags: ['MUTABLE_RULES'] }).matched).toBe(false);
    expect(
      evaluateRule({}, { ...raw, riskBreakdown: { critical: true, flags: ['UNKNOWN'] } }).matched,
    ).toBe(false);
  });
  it('applies every other rule condition after opting in or identifying critical risk', () => {
    expect(
      evaluateRule(
        { includeRoutineEvents: true, assets: ['OTHER'] },
        { ...event, riskFlags: ['PHISHING'] },
      ).matched,
    ).toBe(false);
    expect(
      evaluateRule({ maxRiskScore: 60 }, { ...event, riskScore: 90, riskFlags: ['PHISHING'] })
        .reasons,
    ).toContain('风险上限不满足');
    expect(evaluateRule({ includeRoutineEvents: true, minYieldChangeBps: 5 }, event).matched).toBe(
      false,
    );
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
