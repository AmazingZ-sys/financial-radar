import { createHash } from 'node:crypto';
import { z } from 'zod';
export function stableHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function normalizeUrl(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('非 HTTP 来源');
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (key.startsWith('utm_') || ['fbclid', 'gclid', 'ref'].includes(key))
      url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
export type EventIdentity = {
  eventType: string;
  originalUrl: string;
  chain?: string;
  assetKey?: string;
  assets?: string[];
  identity?: string;
  externalId?: string;
  sourceId?: string;
};
export function fingerprint(event: EventIdentity) {
  const assetIdentity = event.assetKey ?? [...(event.assets ?? [])].sort().join(',');
  return stableHash(
    [
      event.chain ?? '',
      assetIdentity,
      event.eventType,
      event.identity ?? normalizeUrl(event.originalUrl),
    ].join('|'),
  );
}
function tokens(value: string) {
  return new Set(
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}
export function similarity(a: string, b: string) {
  const x = tokens(a);
  const y = tokens(b);
  const intersection = [...x].filter((t) => y.has(t)).length;
  const union = new Set([...x, ...y]).size;
  return union ? intersection / union : 0;
}
export function canAggregate(
  a: EventIdentity & { title: string; sourcePublishedAt: string | null },
  b: EventIdentity & { title: string; sourcePublishedAt: string | null },
  windowMs = 3600_000,
) {
  if (
    a.chain !== b.chain ||
    a.assetKey !== b.assetKey ||
    a.eventType !== b.eventType ||
    [...(a.assets ?? [])].sort().join(',') !== [...(b.assets ?? [])].sort().join(',')
  )
    return false;
  if (a.identity && b.identity && a.identity !== b.identity) return false;
  if (
    !a.sourcePublishedAt ||
    !b.sourcePublishedAt ||
    Math.abs(Date.parse(a.sourcePublishedAt) - Date.parse(b.sourcePublishedAt)) > windowMs
  )
    return false;
  return (
    normalizeUrl(a.originalUrl) === normalizeUrl(b.originalUrl) ||
    similarity(a.title, b.title) >= 0.88
  );
}
const opportunityWeights = {
  sourceTrust: 25,
  stage: 20,
  freshness: 15,
  participantGrowth: 15,
  conditionTransparency: 10,
  independentConfirmation: 10,
  communityGrowth: 5,
};
const riskWeights = {
  unverifiedOfficial: 20,
  permissions: 15,
  liquidity: 15,
  concentration: 10,
  suspiciousActivity: 10,
  contractSafety: 10,
  phishing: 10,
  cost: 5,
  mutableRules: 5,
};
export type OpportunityInputs = Partial<Record<keyof typeof opportunityWeights, number | null>>;
export type RiskInputs = Partial<Record<keyof typeof riskWeights, number | null>>;
export type Score = {
  score: number;
  coverage: number;
  version: string;
  breakdown: { dimension: string; value: number | null; weight: number; contribution: number }[];
  unknowns: string[];
};
function weightedScore(
  weights: Record<string, number>,
  inputs: Record<string, number | null | undefined>,
  version: string,
  unknownPenalty: number,
): Score {
  const total = Object.values(weights).reduce((sum, n) => sum + n, 0);
  if (!(total > 0) || Object.values(weights).some((v) => !Number.isFinite(v) || v < 0))
    throw new Error('评分权重无效');
  const breakdown = Object.entries(weights).map(([dimension, weight]) => {
    const input = inputs[dimension];
    const value = input == null || !Number.isFinite(input) ? null : Math.max(0, Math.min(1, input));
    return {
      dimension,
      value,
      weight,
      contribution: (((value ?? unknownPenalty) * weight) / total) * 100,
    };
  });
  const knownWeight = breakdown.reduce((sum, d) => sum + (d.value === null ? 0 : d.weight), 0);
  return {
    score: Math.round(breakdown.reduce((sum, d) => sum + d.contribution, 0)),
    coverage: Math.round((knownWeight / total) * 100),
    version,
    breakdown,
    unknowns: breakdown.filter((d) => d.value === null).map((d) => d.dimension),
  };
}
export function scoreOpportunity(
  inputs: OpportunityInputs,
  config = { version: 'opportunity-v1', weights: opportunityWeights },
) {
  return weightedScore(config.weights, inputs, config.version, 0);
}
export function scoreRisk(
  inputs: RiskInputs,
  flags: string[] = [],
  config = { version: 'risk-v1', weights: riskWeights },
) {
  const score = weightedScore(config.weights, inputs, config.version, 0.5);
  return {
    ...score,
    score: flags.some((f) => ['PHISHING', 'UNRESTRICTED_MINT', 'LIQUIDITY_REMOVAL'].includes(f))
      ? Math.max(85, score.score)
      : score.score,
    flags,
    critical: flags.some((f) => ['PHISHING', 'UNRESTRICTED_MINT', 'LIQUIDITY_REMOVAL'].includes(f)),
  };
}
export function inputsForEvent(
  event: {
    confidence: number;
    verificationStatus: string;
    project?: { stage: string };
    sourcePublishedAt: string | null;
    conditionsVerified?: boolean;
    metrics?: Record<string, unknown>;
    riskFlags?: string[];
  },
  firstSeenAt: string,
) {
  const lag = event.sourcePublishedAt
    ? Date.parse(firstSeenAt) - Date.parse(event.sourcePublishedAt)
    : null;
  const growth =
    typeof event.metrics?.participantGrowthPct === 'number'
      ? event.metrics.participantGrowthPct
      : null;
  const stage = event.project?.stage;
  return {
    opportunity: {
      sourceTrust: event.confidence,
      stage: stage
        ? ({ EARLY_STAGE: 1, ACTIVE: 0.85, UNVERIFIED: 0.5, VERIFIED: 0.6, TRADING: 0.3 }[stage] ??
          0.2)
        : 0.1,
      freshness: lag === null || lag < 0 ? null : Math.max(0, 1 - lag / 3600_000),
      participantGrowth: growth === null ? null : Math.min(1, Math.max(0, growth / 200)),
      conditionTransparency: event.conditionsVerified ? 1 : null,
      independentConfirmation: null,
      communityGrowth: null,
    },
    risk: {
      unverifiedOfficial: event.verificationStatus === 'VERIFIED' ? 0 : 1,
      permissions: event.riskFlags?.includes('UNRESTRICTED_MINT') ? 1 : null,
      mutableRules: event.riskFlags?.includes('MUTABLE_RULES') ? 1 : null,
    },
  };
}
export { RuleConditionsSchema } from '@radar/shared';
import { RuleConditionsSchema } from '@radar/shared';
export type RuleConditions = z.infer<typeof RuleConditionsSchema>;
export type RuleEvent = {
  eventType: string;
  sourceId?: string;
  assets: string[];
  categories: string[];
  confidence: number;
  opportunityScore: number;
  riskScore: number;
  chain?: string;
  stage?: string;
  verificationStatus?: string;
  firstSeenAt: string;
  metrics?: Record<string, unknown>;
};
export function evaluateRule(conditions: unknown, event: RuleEvent, now = Date.now()) {
  const rule = RuleConditionsSchema.parse(conditions);
  const reasons: string[] = [];
  const age = now - Date.parse(event.firstSeenAt);
  const fields: [boolean, string][] = [
    [!rule.eventTypes?.length || rule.eventTypes.includes(event.eventType), '事件类型'],
    [!rule.sourceIds?.length || rule.sourceIds.includes(event.sourceId ?? ''), '数据源'],
    [!rule.assets?.length || rule.assets.some((asset) => event.assets.includes(asset)), '资产'],
    [!rule.categories?.length || rule.categories.some((c) => event.categories.includes(c)), '分类'],
    [!rule.chains?.length || rule.chains.includes(event.chain ?? ''), '公链'],
    [!rule.stages?.length || rule.stages.includes(event.stage as never), '阶段'],
    [!rule.verifiedOnly || event.verificationStatus === 'VERIFIED', '已验证来源'],
    [event.confidence >= (rule.minConfidence ?? 0), '置信度'],
    [event.opportunityScore >= (rule.minOpportunityScore ?? 0), '机会评分'],
    [event.riskScore <= (rule.maxRiskScore ?? 100), '风险上限'],
    [
      rule.windowSeconds === undefined ||
        (Number.isFinite(age) && age >= 0 && age <= rule.windowSeconds * 1000),
      '时间窗口',
    ],
    [
      rule.maxAgeSeconds === undefined ||
        (Number.isFinite(age) && age >= 0 && age <= rule.maxAgeSeconds * 1000),
      '最大事件年龄',
    ],
  ];
  for (const [test, label] of fields) if (!test) reasons.push(`${label}不满足`);
  for (const [condition, metric] of [
    ['minParticipantGrowthPct', 'participantGrowthPct'],
    ['minMintProgress', 'mintProgress'],
    ['minPriceChangePct', 'priceChangePct'],
    ['minYieldChangeBps', 'yieldChangeBps'],
  ] as const) {
    const threshold = rule[condition];
    const value = event.metrics?.[metric];
    if (
      threshold !== undefined &&
      (typeof value !== 'number' ||
        (metric === 'priceChangePct' || metric === 'yieldChangeBps' ? Math.abs(value) : value) <
          threshold)
    )
      reasons.push(`${metric}缺失或未达阈值`);
  }
  if (
    rule.maxMintProgress !== undefined &&
    (typeof event.metrics?.mintProgress !== 'number' ||
      event.metrics.mintProgress > rule.maxMintProgress)
  )
    reasons.push('铸造进度超过上限或未知');
  return {
    matched: reasons.length === 0,
    reasons: reasons.length ? reasons : ['全部配置条件满足'],
  };
}
export type ReplayEvidence = {
  id: string;
  availableAt: string;
  event: RuleEvent;
  label?: 'positive' | 'negative';
};
export function replay(evidence: ReplayEvidence[], conditions: unknown, at: string) {
  const clock = Date.parse(at);
  if (!Number.isFinite(clock)) throw new Error('回放时间无效');
  const available = evidence
    .filter(
      (item) =>
        Date.parse(item.availableAt) <= clock && Date.parse(item.event.firstSeenAt) <= clock,
    )
    .sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt));
  const results = available.map((item) => ({
    evidenceId: item.id,
    detectedAt: item.availableAt,
    ...evaluateRule(conditions, item.event, Date.parse(item.availableAt)),
  }));
  const labeled = available.filter((x) => x.label);
  return {
    at,
    fixture: true,
    results,
    excludedFutureEvidence: evidence.length - available.length,
    falsePositives: labeled.length
      ? results.filter(
          (r) => r.matched && available.find((x) => x.id === r.evidenceId)?.label === 'negative',
        ).length
      : null,
    falseNegatives: labeled.length
      ? results.filter(
          (r) => !r.matched && available.find((x) => x.id === r.evidenceId)?.label === 'positive',
        ).length
      : null,
    limitations: ['此结果只说明输入证据下的规则行为，不构成 ORDI 历史收益回测。'],
  };
}
export function transitionStage(from: string, to: string, evidenceIds: string[]) {
  if (!evidenceIds.length) throw new Error('阶段变更需要证据');
  const stages = [
    'DISCOVERED',
    'UNVERIFIED',
    'VERIFIED',
    'EARLY_STAGE',
    'ACTIVE',
    'COMPLETED',
    'TRADING',
    'INACTIVE',
  ];
  if (!stages.includes(from) || !stages.includes(to))
    throw new Error('风险/观察属性不能代替生命周期阶段');
  if (to === 'INACTIVE' || from === to) return true;
  const allowed: Record<string, string[]> = {
    DISCOVERED: ['UNVERIFIED', 'VERIFIED'],
    UNVERIFIED: ['VERIFIED'],
    VERIFIED: ['EARLY_STAGE', 'ACTIVE', 'TRADING'],
    EARLY_STAGE: ['ACTIVE', 'COMPLETED', 'TRADING'],
    ACTIVE: ['COMPLETED', 'TRADING'],
    COMPLETED: ['ACTIVE', 'TRADING'],
    TRADING: ['ACTIVE'],
    INACTIVE: ['UNVERIFIED', 'VERIFIED'],
  };
  if (!allowed[from]?.includes(to)) throw new Error('不允许的生命周期变化');
  return true;
}
export const DEFAULT_SCORING_CONFIG = {
  opportunity: { version: 'opportunity-v1', weights: opportunityWeights },
  risk: { version: 'risk-v1', weights: riskWeights },
};
const weight = z.number().finite().min(0).max(100);
export const ScoringConfigSchema = z
  .object({
    opportunity: z
      .object({
        version: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
        weights: z
          .object({
            sourceTrust: weight,
            stage: weight,
            freshness: weight,
            participantGrowth: weight,
            conditionTransparency: weight,
            independentConfirmation: weight,
            communityGrowth: weight,
          })
          .strict()
          .refine(
            (weights) => Object.values(weights).some((value) => value > 0),
            '至少一个权重大于零',
          ),
      })
      .strict(),
    risk: z
      .object({
        version: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
        weights: z
          .object({
            unverifiedOfficial: weight,
            permissions: weight,
            liquidity: weight,
            concentration: weight,
            suspiciousActivity: weight,
            contractSafety: weight,
            phishing: weight,
            cost: weight,
            mutableRules: weight,
          })
          .strict()
          .refine(
            (weights) => Object.values(weights).some((value) => value > 0),
            '至少一个权重大于零',
          ),
      })
      .strict(),
  })
  .strict();
export * from './history.js';
