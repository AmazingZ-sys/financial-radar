import { describe, expect, it } from 'vitest';
import type { Evidence } from '@radar/ai';
import {
  ANALYSIS_POLICY_VERSION,
  analysisCooldownKey,
  evaluateAnalysisCandidate,
  truncateAnalysisEvidence,
} from './analysis-policy.js';

const now = Date.parse('2026-11-05T10:00:00.000Z');
const candidate = {
  dataMode: 'live',
  eventType: 'OFFICIAL_ANNOUNCEMENT',
  verificationStatus: 'VERIFIED',
  confidence: 0.8,
  firstSeenAt: '2026-11-05T09:30:00.000Z',
  sourcePublishedAt: '2026-11-05T09:00:00.000Z',
};

describe('automatic analysis admission', () => {
  it('versions the policy and preserves the explicit synthetic provider path', () => {
    expect(ANALYSIS_POLICY_VERSION).toBe('candidate-first-v1');
    expect(evaluateAnalysisCandidate({ dataMode: 'fixture' }, now)).toEqual({
      eligible: true,
      reason: 'FIXTURE',
    });
  });

  it.each(['OFFICIAL_ANNOUNCEMENT', 'PROTOCOL_RELEASE', 'EXCHANGE_LISTING'])(
    'admits a verified %s at the confidence and freshness boundaries',
    (eventType) => {
      expect(evaluateAnalysisCandidate({ ...candidate, eventType }, now).eligible).toBe(true);
      expect(
        evaluateAnalysisCandidate({ ...candidate, firstSeenAt: '2026-11-05T09:00:00.000Z' }, now)
          .eligible,
      ).toBe(true);
    },
  );

  it.each([
    'PAIR_CREATED',
    'NEW_TOKEN_DEPLOYED',
    'MINT_CREATED',
    'MINT_STARTED',
    'TOKEN_STATE_SNAPSHOT',
    'MARKET_SNAPSHOT',
    'NEWS',
    'SOCIAL_MOMENTUM',
  ])('does not turn a routine %s observation into a paid opportunity', (eventType) => {
    expect(evaluateAnalysisCandidate({ ...candidate, eventType }, now)).toEqual({
      eligible: false,
      reason: 'UNSUPPORTED_EVENT_TYPE',
    });
  });

  it.each([undefined, null, 'LIVE', 'unknown'])(
    'rejects an absent or invalid mode (%s)',
    (dataMode) => {
      expect(evaluateAnalysisCandidate({ ...candidate, dataMode }, now).reason).toBe(
        'INVALID_DATA_MODE',
      );
    },
  );

  it.each(['UNVERIFIED', 'DISPUTED', undefined])(
    'requires confirmed official identity (%s)',
    (verificationStatus) => {
      expect(evaluateAnalysisCandidate({ ...candidate, verificationStatus }, now).eligible).toBe(
        false,
      );
    },
  );

  it.each([0.799999, -1, 1.1, NaN, Infinity, '0.9', undefined])(
    'rejects insufficient or invalid confidence (%s)',
    (confidence) => {
      expect(evaluateAnalysisCandidate({ ...candidate, confidence }, now).eligible).toBe(false);
    },
  );

  it.each(['firstSeenAt', 'sourcePublishedAt'])(
    'checks stale, future, and invalid %s before analysis',
    (field) => {
      for (const value of [
        '2026-11-05T08:59:59.999Z',
        '2026-11-05T10:00:00.001Z',
        'invalid-time',
        '',
        now,
      ])
        expect(evaluateAnalysisCandidate({ ...candidate, [field]: value }, now).eligible).toBe(
          false,
        );
    },
  );

  it('requires a discovery time while retaining unknown source publication time', () => {
    for (const value of [undefined, null]) {
      expect(evaluateAnalysisCandidate({ ...candidate, firstSeenAt: value }, now).eligible).toBe(
        false,
      );
      expect(
        evaluateAnalysisCandidate({ ...candidate, sourcePublishedAt: value }, now).eligible,
      ).toBe(true);
    }
    expect(evaluateAnalysisCandidate(candidate, NaN).eligible).toBe(false);
  });

  it.each(['PHISHING', 'UNRESTRICTED_MINT', 'LIQUIDITY_REMOVAL'])(
    'keeps the structured severe-risk pathway independent of opportunity verification (%s)',
    (flag) => {
      const risk = {
        ...candidate,
        eventType: 'TOKEN_STATE_SNAPSHOT',
        confidence: 0.1,
        verificationStatus: 'UNVERIFIED',
        riskFlags: [flag],
      };
      expect(evaluateAnalysisCandidate(risk, now)).toEqual({
        eligible: true,
        reason: 'CRITICAL_RISK',
      });
      expect(
        evaluateAnalysisCandidate({ ...risk, firstSeenAt: '2026-11-05T08:59:59.999Z' }, now)
          .eligible,
      ).toBe(false);
    },
  );

  it('recognizes persisted risk assessments without inferring confirmed risk from scores', () => {
    const routine = { ...candidate, eventType: 'PAIR_CREATED' };
    expect(
      evaluateAnalysisCandidate(
        { ...routine, riskBreakdown: { flags: ['LIQUIDITY_REMOVAL'] } },
        now,
      ).eligible,
    ).toBe(true);
    for (const data of [
      { riskScore: 100 },
      { riskWarnings: ['PHISHING'] },
      { riskFlags: ['UNKNOWN_CONTRACT_RISK', 'UNVERIFIED_OFFICIAL'] },
      { riskFlags: 'PHISHING' },
      { riskBreakdown: { critical: true } },
    ])
      expect(evaluateAnalysisCandidate({ ...routine, ...data }, now).eligible).toBe(false);
  });
});

describe('asset analysis cooldown identity', () => {
  it('prefers the stable asset key over ticker lists and normalizes chain casing', () => {
    const event = { chain: 'Solana', assetKey: 'solana:mint:AbCd', assets: ['TICKER'] };
    expect(analysisCooldownKey(event)).toBe(
      analysisCooldownKey({ ...event, chain: 'solana', assets: ['OTHER'] }),
    );
    expect(analysisCooldownKey(event)).not.toBe(
      analysisCooldownKey({ ...event, assetKey: 'solana:mint:abcd' }),
    );
    expect(analysisCooldownKey(event)).not.toBe(
      analysisCooldownKey({ ...event, chain: 'Ethereum' }),
    );
  });

  it('uses the project asset key when the top-level key is absent', () => {
    expect(
      analysisCooldownKey({ chain: 'Bitcoin', project: { assetKey: 'bitcoin:brc20:test' } }),
    ).toBe(analysisCooldownKey({ chain: 'Bitcoin', assetKey: 'bitcoin:brc20:test' }));
    expect(analysisCooldownKey({ assetKey: 'top', project: { assetKey: 'nested' } })).toBe(
      analysisCooldownKey({ assetKey: 'top' }),
    );
  });

  it('sorts and deduplicates fallback assets without ticker or separator collisions', () => {
    expect(analysisCooldownKey({ chain: 'Ethereum', assets: ['B', 'A', 'A'] })).toBe(
      analysisCooldownKey({ chain: 'ethereum', assets: ['A', 'B'] }),
    );
    expect(analysisCooldownKey({ assets: ['A,B'] })).not.toBe(
      analysisCooldownKey({ assets: ['A', 'B'] }),
    );
    expect(analysisCooldownKey({ chain: 'Ethereum', assets: [] })).toBeNull();
    expect(analysisCooldownKey({ assets: ['', ' ', null, 1] })).toBeNull();
    expect(analysisCooldownKey({ project: null })).toBeNull();
  });
});

describe('X discussion analysis admission', () => {
  const evidenceIds = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
  ];
  const topic = {
    ...candidate,
    sourceId: 'x-search',
    eventType: 'X_HOT_TOPIC',
    verificationStatus: 'UNVERIFIED',
    confidence: 0.65,
    opportunityScore: 100,
    metrics: {
      topicKey: 'hashtag:radar',
      minimumAuthors: 3,
      uniqueAuthors: 3,
      originalPostCount: 3,
      windowMinutes: 60,
    },
    evidenceIds,
  };

  it('admits a recent evidence-backed multi-account discussion without claiming verification', () => {
    expect(evaluateAnalysisCandidate(topic, now)).toEqual({
      eligible: true,
      reason: 'X_DISCUSSION_CANDIDATE',
    });
    expect(topic.verificationStatus).toBe('UNVERIFIED');
  });

  it.each(['SOCIAL_POST', 'NEWS', 'SOCIAL_MOMENTUM'])(
    'keeps a single %s out of paid analysis regardless of copied scores or counts',
    (eventType) => {
      expect(evaluateAnalysisCandidate({ ...topic, eventType }, now).eligible).toBe(false);
    },
  );

  it.each(['custom-rss-social', 'other', '', undefined])(
    'does not grant discussion admission to an unrelated source (%s)',
    (sourceId) => {
      expect(evaluateAnalysisCandidate({ ...topic, sourceId }, now).eligible).toBe(false);
    },
  );

  it.each([
    { minimumAuthors: 1 },
    { minimumAuthors: 21 },
    { minimumAuthors: 3.5 },
    { minimumAuthors: '3' },
    { uniqueAuthors: 2 },
    { uniqueAuthors: 3.5 },
    { uniqueAuthors: NaN },
    { originalPostCount: 2 },
    { originalPostCount: 3.5 },
    { originalPostCount: 4 },
    { windowMinutes: 14 },
    { windowMinutes: 61 },
    { windowMinutes: 30.5 },
    { windowMinutes: '60' },
  ])('requires actual bounded integer counts and sufficient evidence (%j)', (metrics) => {
    expect(
      evaluateAnalysisCandidate({ ...topic, metrics: { ...topic.metrics, ...metrics } }, now)
        .eligible,
    ).toBe(false);
  });

  it.each(
    [
      undefined,
      [],
      evidenceIds.slice(0, 2),
      [evidenceIds[0], evidenceIds[0], evidenceIds[1]],
      ['', ' ', evidenceIds[2]],
      [1, 2, 3],
      ['raw-post-1', 'raw-post-2', 'raw-post-3'],
    ].map((evidenceIds) => ({ evidenceIds })),
  )('requires enough distinct meaningful evidence IDs ($evidenceIds)', ({ evidenceIds }) => {
    expect(evaluateAnalysisCandidate({ ...topic, evidenceIds }, now).eligible).toBe(false);
  });

  it.each(['', 'radar', 'asset:radar', 'hashtag:', 'hashtag:   '])(
    'rejects an absent or unsupported topic identity (%s)',
    (topicKey) => {
      expect(
        evaluateAnalysisCandidate({ ...topic, metrics: { ...topic.metrics, topicKey } }, now)
          .eligible,
      ).toBe(false);
    },
  );

  it('keeps topic namespaces distinct for the six-hour cooldown', () => {
    const keys = ['hashtag:radar', 'cashtag:radar', 'keyword:radar'].map((topicKey) =>
      analysisCooldownKey({ ...topic, metrics: { ...topic.metrics, topicKey } }),
    );
    expect(keys).toEqual([
      'x-topic:hashtag:radar',
      'x-topic:cashtag:radar',
      'x-topic:keyword:radar',
    ]);
    expect(new Set(keys).size).toBe(3);
    expect(analysisCooldownKey({ ...topic, sourceId: 'other' })).toBeNull();
  });

  it('continues checking the real evidence clocks for discussion candidates', () => {
    expect(
      evaluateAnalysisCandidate({ ...topic, sourcePublishedAt: '2026-11-05T08:59:59.999Z' }, now)
        .eligible,
    ).toBe(false);
    expect(
      evaluateAnalysisCandidate({ ...topic, firstSeenAt: '2026-11-05T10:00:00.001Z' }, now)
        .eligible,
    ).toBe(false);
  });
});

describe('bounded analysis evidence', () => {
  const evidence = (id: string, text: string): Evidence => ({
    id,
    title: `Evidence ${id}`,
    text,
    url: `https://example.invalid/${id}`,
    availableAt: '2026-11-05T09:00:00.000Z',
  });

  it('caps source count, each body, and combined text deterministically without mutation', () => {
    const input = Array.from({ length: 7 }, (_, index) =>
      evidence(String(index), 'x'.repeat(9000)),
    );
    const output = truncateAnalysisEvidence(input);
    expect(output.map((item) => item.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(output.map((item) => item.text.length)).toEqual([2400, 2400, 2400, 800, 0]);
    expect(output.reduce((total, item) => total + item.text.length, 0)).toBe(8000);
    expect(output[0]).toEqual({ ...input[0], text: 'x'.repeat(2400) });
    expect(input[0]!.text.length).toBe(9000);
    expect(output).toEqual(truncateAnalysisEvidence(input));
  });

  it('retains short evidence text and its attribution exactly', () => {
    const input = [evidence('first', 'Short source'), evidence('second', '')];
    expect(truncateAnalysisEvidence(input)).toEqual(input);
    expect(truncateAnalysisEvidence([])).toEqual([]);
  });
});
