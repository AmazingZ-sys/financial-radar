import { createHash } from 'node:crypto';
/** Every observation carries both measurement time and the earliest time it was
 * available to this system. Comparing occurredAt/deployment times is forbidden. */
export type ProjectObservation = {
  evidenceId: string;
  sourceId: string;
  assetKey: string;
  dataMode: 'fixture' | 'live';
  observedAt: string;
  availableAt: string;
  metrics: Record<string, unknown>;
  stage: string;
  verificationStatus: string;
  confidence: number;
  conditionsVerified: boolean;
  conditions: string | null;
  startsAt: string | null;
  endsAt: string | null;
};
export type HistoricalSignalType =
  | 'NEW_TOKEN_DEPLOYED'
  | 'MINT_STARTED'
  | 'MINT_PROGRESS_ACCELERATED'
  | 'UNIQUE_PARTICIPANTS_SPIKE'
  | 'LIQUIDITY_ADDED'
  | 'LIQUIDITY_REMOVED'
  | 'VOLUME_SPIKE'
  | 'SOCIAL_MOMENTUM'
  | 'PROJECT_LAUNCHED'
  | 'PROJECT_TRUST_CHANGED'
  | 'PARTICIPATION_WINDOW_EXPIRING'
  | 'PARTICIPATION_WINDOW_EXPIRED';
export type HistoricalSignal = {
  type: HistoricalSignalType;
  stableKey: string;
  reason: string;
  evidenceIds: string[];
  metrics: Record<string, number | string | null>;
  riskFlags: string[];
  severity: 'P1' | 'P2';
  algorithmVersion: string;
};
export const DEFAULT_HISTORY_DETECTION = {
  version: 'history-v1',
  minIntervalSeconds: 60,
  maxGapSeconds: 21600,
  minMintDeltaPp: 1,
  mintAccelerationRatio: 2,
  minMintRateIncreasePpPerHour: 1,
  participantMinBaseline: 10,
  participantMinAbsoluteGrowth: 20,
  participantGrowthPct: 50,
  liquidityMinAbsoluteUsd: 5000,
  liquidityGrowthPct: 20,
  liquidityRemovalPct: 30,
  volumeMinBaselineUsd: 1000,
  volumeMinAbsoluteGrowthUsd: 5000,
  volumeGrowthPct: 200,
  socialMinBaseline: 20,
  socialMinAbsoluteGrowth: 50,
  socialGrowthPct: 100,
  trustConfidenceDelta: 0.15,
  windowEndingSeconds: 3600,
};
export type HistoryDetectionConfig = typeof DEFAULT_HISTORY_DETECTION;
function validTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function participants(o: ProjectObservation): number | null {
  // A connector may explicitly supply either name for genuine unique participants.
  // Holder counts are a different metric and are never used here.
  const value = number(o.metrics.uniqueParticipants) ?? number(o.metrics.participants);
  return value !== null && Number.isInteger(value) ? value : null;
}
function mint(o: ProjectObservation) {
  const value = number(o.metrics.mintProgress);
  return value !== null && value <= 100 ? value : null;
}
function decimal(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [integer = '0', fraction = ''] = text.split('.');
  return `${integer.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '') || '0'}`;
}
/** A max supply revision changes the denominator of mintProgress. When any
 * sample exposes it, every sample in the comparison must expose the same
 * canonical decimal value; otherwise no mint signal is emitted. */
function compatibleSupply(samples: ProjectObservation[]): boolean {
  const supplied = samples.map(
    (sample) =>
      Object.prototype.hasOwnProperty.call(sample.metrics, 'max') &&
      sample.metrics.max !== null &&
      sample.metrics.max !== undefined,
  );
  if (!supplied.some(Boolean)) return true;
  const values = samples.map((sample) => decimal(sample.metrics.max));
  return values.every((value) => value !== null && value === values[0]);
}
/** Change-only observations omit flat polls. Use the last confirmed time of
 * each linked prior state so a quiet period cannot manufacture acceleration. */
function mintRateIntervals(
  earlier: ProjectObservation,
  previous: ProjectObservation,
  current: ProjectObservation,
  at: number,
): { previousSeconds: number; currentSeconds: number } | null {
  const samples = [earlier, previous, current];
  const stateChanges = samples.some((sample) => sample.metrics.samplingMode === 'state-changes');
  if (
    stateChanges &&
    !samples.every(
      (sample) =>
        sample.metrics.samplingMode === 'state-changes' &&
        typeof sample.metrics.stateFingerprint === 'string' &&
        sample.metrics.stateFingerprint.length > 0,
    )
  )
    return null;
  const interval = (prior: ProjectObservation, next: ProjectObservation): number | null => {
    const nextAt = Date.parse(next.observedAt);
    let baselineAt = Date.parse(prior.observedAt);
    if (stateChanges) {
      if (
        next.metrics.previousStateFingerprint !== prior.metrics.stateFingerprint ||
        typeof next.metrics.previousStateObservedAt !== 'string'
      )
        return null;
      const confirmedAt = validTime(next.metrics.previousStateObservedAt);
      if (
        confirmedAt === null ||
        confirmedAt < baselineAt ||
        confirmedAt >= nextAt ||
        confirmedAt > at
      )
        return null;
      baselineAt = confirmedAt;
    }
    return (nextAt - baselineAt) / 1000;
  };
  const previousSeconds = interval(earlier, previous);
  const currentSeconds = interval(previous, current);
  return previousSeconds === null || currentSeconds === null
    ? null
    : { previousSeconds, currentSeconds };
}
function knows(o: ProjectObservation, at: number) {
  const observed = validTime(o.observedAt),
    available = validTime(o.availableAt);
  return (
    observed !== null &&
    available !== null &&
    observed <= at &&
    available <= at &&
    available >= observed
  );
}
function sameScope(a: ProjectObservation, b: ProjectObservation) {
  return a.sourceId === b.sourceId && a.assetKey === b.assetKey && a.dataMode === b.dataMode;
}
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function signal(
  current: ProjectObservation,
  type: HistoricalSignalType,
  evidence: ProjectObservation[],
  reason: string,
  metrics: HistoricalSignal['metrics'],
  config: HistoryDetectionConfig,
  riskFlags: string[] = [],
  severity: 'P1' | 'P2' = 'P2',
): HistoricalSignal {
  const evidenceIds = [...new Set(evidence.map((o) => o.evidenceId))];
  return {
    type,
    stableKey: hash([
      config.version,
      current.dataMode,
      current.sourceId,
      current.assetKey,
      type,
      evidenceIds,
    ]),
    reason,
    evidenceIds,
    metrics,
    riskFlags,
    severity,
    algorithmVersion: config.version,
  };
}
/** Deterministic history detection. Only the latest observable sample may emit;
 * late historical imports are retained but cannot roll state backwards. */
export function detectHistoricalSignals(
  current: ProjectObservation,
  history: ProjectObservation[],
  at: string,
  config: HistoryDetectionConfig = DEFAULT_HISTORY_DETECTION,
): HistoricalSignal[] {
  const clock = validTime(at);
  if (clock === null) throw new Error('历史检测时钟无效');
  if (!knows(current, clock)) return [];
  const scoped = history.filter(
    (o) => sameScope(current, o) && knows(o, clock) && o.evidenceId !== current.evidenceId,
  );
  if (scoped.some((o) => Date.parse(o.observedAt) >= Date.parse(current.observedAt))) return [];
  const seen = new Set<string>();
  const sorted = scoped
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    .filter((o) => {
      const key = o.observedAt;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const previous = sorted.at(-1);
  if (!previous) return [];
  const seconds = (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) / 1000;
  if (seconds < config.minIntervalSeconds || seconds > config.maxGapSeconds) return [];
  const result: HistoricalSignal[] = [];
  const currentMint = mint(current),
    previousMint = mint(previous);
  if (
    previousMint === 0 &&
    currentMint !== null &&
    currentMint > 0 &&
    compatibleSupply([previous, current])
  ) {
    result.push(
      signal(
        current,
        'MINT_STARTED',
        [previous, current],
        `已观测铸造进度从 0% 变为 ${currentMint}%；只能确认两次采样之间开始，真实首笔时间未知。`,
        { mintProgress: currentMint, windowSeconds: seconds },
        config,
      ),
    );
  }
  const earlier = sorted.at(-2);
  if (earlier && currentMint !== null && previousMint !== null) {
    const earlierMint = mint(earlier);
    const intervals = mintRateIntervals(earlier, previous, current, clock);
    if (
      earlierMint !== null &&
      intervals !== null &&
      intervals.previousSeconds >= config.minIntervalSeconds &&
      intervals.previousSeconds <= config.maxGapSeconds &&
      intervals.currentSeconds >= config.minIntervalSeconds &&
      intervals.currentSeconds <= config.maxGapSeconds &&
      compatibleSupply([earlier, previous, current])
    ) {
      const beforeDelta = previousMint - earlierMint,
        afterDelta = currentMint - previousMint;
      const beforeRate = (beforeDelta / intervals.previousSeconds) * 3600,
        afterRate = (afterDelta / intervals.currentSeconds) * 3600;
      if (
        beforeDelta > 0 &&
        afterDelta >= config.minMintDeltaPp &&
        afterRate >= beforeRate * config.mintAccelerationRatio &&
        afterRate - beforeRate >= config.minMintRateIncreasePpPerHour
      ) {
        result.push(
          signal(
            current,
            'MINT_PROGRESS_ACCELERATED',
            [earlier, previous, current],
            `三次可知采样的铸造速度由 ${beforeRate.toFixed(2)} 提升至 ${afterRate.toFixed(2)} 百分点/小时，已按不同采样间隔归一化。`,
            {
              mintProgress: currentMint,
              previousRatePpPerHour: beforeRate,
              currentRatePpPerHour: afterRate,
              accelerationRatio: afterRate / beforeRate,
              windowSeconds: intervals.currentSeconds,
            },
            config,
          ),
        );
      }
    }
  }
  const oldParticipants = participants(previous),
    newParticipants = participants(current);
  if (
    oldParticipants !== null &&
    newParticipants !== null &&
    oldParticipants >= config.participantMinBaseline
  ) {
    const delta = newParticipants - oldParticipants;
    const pct = (delta / oldParticipants) * 100;
    if (delta >= config.participantMinAbsoluteGrowth && pct >= config.participantGrowthPct)
      result.push(
        signal(
          current,
          'UNIQUE_PARTICIPANTS_SPIKE',
          [previous, current],
          `来源明确的独立参与者从 ${oldParticipants} 增至 ${newParticipants}（+${pct.toFixed(1)}%）；持币地址数未用于此判断。`,
          {
            participants: newParticipants,
            uniqueParticipants: newParticipants,
            participantGrowthPct: pct,
            windowSeconds: seconds,
          },
          config,
        ),
      );
  }
  const oldLiquidity = number(previous.metrics.liquidityUsd),
    newLiquidity = number(current.metrics.liquidityUsd);
  if (oldLiquidity !== null && newLiquidity !== null && oldLiquidity > 0) {
    const delta = newLiquidity - oldLiquidity,
      pct = (delta / oldLiquidity) * 100;
    if (delta >= config.liquidityMinAbsoluteUsd && pct >= config.liquidityGrowthPct)
      result.push(
        signal(
          current,
          'LIQUIDITY_ADDED',
          [previous, current],
          `同一来源/项目流动性从 ${oldLiquidity} 增至 ${newLiquidity} USD（+${pct.toFixed(1)}%）。`,
          { liquidityUsd: newLiquidity, liquidityChangePct: pct, windowSeconds: seconds },
          config,
        ),
      );
    if (-delta >= config.liquidityMinAbsoluteUsd && -pct >= config.liquidityRemovalPct)
      result.push(
        signal(
          current,
          'LIQUIDITY_REMOVED',
          [previous, current],
          `同一来源/项目流动性减少 ${(-pct).toFixed(1)}%，存在撤出风险；高机会分不能抵消此风险。`,
          { liquidityUsd: newLiquidity, liquidityChangePct: pct, windowSeconds: seconds },
          config,
          ['LIQUIDITY_REMOVAL'],
          'P1',
        ),
      );
  }
  const oldVolume = number(previous.metrics.volumeUsd),
    newVolume = number(current.metrics.volumeUsd),
    volumeWindow = number(current.metrics.volumeWindowSeconds);
  if (
    oldVolume !== null &&
    newVolume !== null &&
    oldVolume >= config.volumeMinBaselineUsd &&
    volumeWindow !== null &&
    volumeWindow > 0 &&
    volumeWindow === number(previous.metrics.volumeWindowSeconds)
  ) {
    const delta = newVolume - oldVolume,
      pct = (delta / oldVolume) * 100;
    if (delta >= config.volumeMinAbsoluteGrowthUsd && pct >= config.volumeGrowthPct)
      result.push(
        signal(
          current,
          'VOLUME_SPIKE',
          [previous, current],
          `相同 ${volumeWindow} 秒统计口径下，成交量从 ${oldVolume} 增至 ${newVolume} USD（+${pct.toFixed(1)}%）；不是累计量差。`,
          {
            volumeUsd: newVolume,
            volumeWindowSeconds: volumeWindow,
            volumeGrowthPct: pct,
            windowSeconds: seconds,
          },
          config,
        ),
      );
  }
  const oldSocial = number(previous.metrics.socialMentions),
    newSocial = number(current.metrics.socialMentions),
    socialWindow = number(current.metrics.socialWindowSeconds);
  if (
    oldSocial !== null &&
    newSocial !== null &&
    oldSocial >= config.socialMinBaseline &&
    socialWindow !== null &&
    socialWindow > 0 &&
    socialWindow === number(previous.metrics.socialWindowSeconds)
  ) {
    const delta = newSocial - oldSocial,
      pct = (delta / oldSocial) * 100;
    if (delta >= config.socialMinAbsoluteGrowth && pct >= config.socialGrowthPct)
      result.push(
        signal(
          current,
          'SOCIAL_MOMENTUM',
          [previous, current],
          `同来源、相同 ${socialWindow} 秒口径的可靠社区计数增长 ${pct.toFixed(1)}%；社交信号单独不产生高可信机会。`,
          { socialMentions: newSocial, socialGrowthPct: pct, socialWindowSeconds: socialWindow },
          config,
        ),
      );
  }
  if (
    ['VERIFIED', 'EARLY_STAGE'].includes(previous.stage) &&
    current.stage === 'ACTIVE' &&
    current.verificationStatus === 'VERIFIED' &&
    current.conditionsVerified
  )
    result.push(
      signal(
        current,
        'PROJECT_LAUNCHED',
        [previous, current],
        '已验证证据显示项目从准备/早期阶段进入正式开放活动；具体条件仍以来源为准。',
        {},
        config,
        [],
        'P1',
      ),
    );
  const verificationChanged = previous.verificationStatus !== current.verificationStatus;
  const confidenceChanged =
    Number.isFinite(previous.confidence) &&
    Number.isFinite(current.confidence) &&
    Math.abs(current.confidence - previous.confidence) >= config.trustConfidenceDelta;
  if (verificationChanged || confidenceChanged)
    result.push(
      signal(
        current,
        'PROJECT_TRUST_CHANGED',
        [previous, current],
        `可信状态由 ${previous.verificationStatus}/${previous.confidence} 变为 ${current.verificationStatus}/${current.confidence}；这是来源验证变化，不是投资安全保证。`,
        {
          previousConfidence: previous.confidence,
          currentConfidence: current.confidence,
          previousVerification: previous.verificationStatus,
          currentVerification: current.verificationStatus,
        },
        config,
      ),
    );
  return result;
}
/** Clock-driven window evaluation requires persisted, explicit verified terms.
 * Activity expiration does not automatically complete the entire project. */
export function detectParticipationWindow(
  observation: ProjectObservation,
  at: string,
  config: HistoryDetectionConfig = DEFAULT_HISTORY_DETECTION,
): HistoricalSignal[] {
  const clock = validTime(at);
  if (clock === null) throw new Error('窗口检测时钟无效');
  if (
    !knows(observation, clock) ||
    observation.verificationStatus !== 'VERIFIED' ||
    !observation.conditionsVerified ||
    !observation.conditions?.trim() ||
    !observation.endsAt
  )
    return [];
  const end = validTime(observation.endsAt);
  const start = observation.startsAt ? validTime(observation.startsAt) : null;
  if (
    end === null ||
    (observation.startsAt && start === null) ||
    (start !== null && (start >= end || clock < start))
  )
    return [];
  const remainingSeconds = (end - clock) / 1000;
  if (remainingSeconds > config.windowEndingSeconds) return [];
  const type =
    remainingSeconds > 0 ? 'PARTICIPATION_WINDOW_EXPIRING' : 'PARTICIPATION_WINDOW_EXPIRED';
  const result = signal(
    observation,
    type,
    [observation],
    remainingSeconds > 0
      ? `已核验的参与窗口将在 ${Math.ceil(remainingSeconds / 60)} 分钟内结束；费用或参与资格仍须逐项确认。`
      : '已核验的本次参与窗口到期；此信号不代表整个项目已完成。',
    { endsAt: observation.endsAt, remainingSeconds, windowConditionsVerified: 1 },
    config,
  );
  return [
    {
      ...result,
      stableKey: hash([
        config.version,
        observation.dataMode,
        observation.assetKey,
        observation.endsAt,
        type,
      ]),
    },
  ];
}
