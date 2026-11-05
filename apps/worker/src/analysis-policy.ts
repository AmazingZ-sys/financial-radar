import type { Evidence } from '@radar/ai';

export const ANALYSIS_POLICY_VERSION = 'candidate-first-v1';
const MAX_CANDIDATE_AGE_MS = 60 * 60 * 1000;
const candidateTypes = new Set(['OFFICIAL_ANNOUNCEMENT', 'PROTOCOL_RELEASE', 'EXCHANGE_LISTING']);
const criticalFlags = new Set(['PHISHING', 'UNRESTRICTED_MINT', 'LIQUIDITY_REMOVAL']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timeRejection(value: unknown, field: string, now: number): string | null {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return `INVALID_${field}`;
  if (timestamp > now) return `FUTURE_${field}`;
  if (now - timestamp > MAX_CANDIDATE_AGE_MS) return `STALE_${field}`;
  return null;
}

/** The same free admission check runs before enqueue and again before any paid request. */
export function evaluateAnalysisCandidate(
  event: Record<string, unknown>,
  now = Date.now(),
): { eligible: boolean; reason: string } {
  if (event.dataMode === 'fixture') return { eligible: true, reason: 'FIXTURE' };
  if (event.dataMode !== 'live') return { eligible: false, reason: 'INVALID_DATA_MODE' };
  if (!Number.isFinite(now)) return { eligible: false, reason: 'INVALID_CLOCK' };

  const firstSeenRejection = timeRejection(event.firstSeenAt, 'FIRST_SEEN_AT', now);
  if (firstSeenRejection) return { eligible: false, reason: firstSeenRejection };
  if (event.sourcePublishedAt !== undefined && event.sourcePublishedAt !== null) {
    const sourceRejection = timeRejection(event.sourcePublishedAt, 'SOURCE_PUBLISHED_AT', now);
    if (sourceRejection) return { eligible: false, reason: sourceRejection };
  }

  // Only structured, known risk flags qualify. Free-text warnings and high scores alone do not.
  const flags = [event.riskFlags, record(event.riskBreakdown)?.flags, event.criticalRiskFlags]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value): value is string => typeof value === 'string');
  if (flags.some((flag) => criticalFlags.has(flag)))
    return { eligible: true, reason: 'CRITICAL_RISK' };

  if (event.eventType === 'X_HOT_TOPIC' && event.sourceId === 'x-search') {
    const metrics = record(event.metrics);
    const minimum = metrics?.minimumAuthors;
    const authors = metrics?.uniqueAuthors;
    const posts = metrics?.originalPostCount;
    if (
      typeof minimum === 'number' &&
      Number.isInteger(minimum) &&
      minimum >= 2 &&
      minimum <= 20 &&
      typeof authors === 'number' &&
      Number.isInteger(authors) &&
      authors >= minimum &&
      typeof posts === 'number' &&
      Number.isInteger(posts) &&
      posts >= authors &&
      typeof metrics?.topicKey === 'string' &&
      /^(keyword|hashtag|cashtag):\S.{0,199}$/u.test(metrics.topicKey) &&
      typeof metrics.windowMinutes === 'number' &&
      Number.isInteger(metrics.windowMinutes) &&
      metrics.windowMinutes >= 15 &&
      metrics.windowMinutes <= 60 &&
      Array.isArray(event.evidenceIds) &&
      event.evidenceIds.every(
        (id) =>
          typeof id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      ) &&
      new Set(event.evidenceIds).size >= posts
    )
      return { eligible: true, reason: 'X_DISCUSSION_CANDIDATE' };
    return { eligible: false, reason: 'INSUFFICIENT_DISCUSSION_EVIDENCE' };
  }

  if (typeof event.eventType !== 'string' || !candidateTypes.has(event.eventType))
    return { eligible: false, reason: 'UNSUPPORTED_EVENT_TYPE' };
  if (event.verificationStatus !== 'VERIFIED')
    return { eligible: false, reason: 'UNVERIFIED_EVENT' };
  if (
    typeof event.confidence !== 'number' ||
    !Number.isFinite(event.confidence) ||
    event.confidence < 0.8 ||
    event.confidence > 1
  )
    return { eligible: false, reason: 'LOW_CONFIDENCE' };
  return { eligible: true, reason: 'VERIFIED_CANDIDATE' };
}

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Preserve case-sensitive asset identities, including Solana addresses. */
export function analysisCooldownKey(event: Record<string, unknown>): string | null {
  if (
    event.eventType === 'X_HOT_TOPIC' &&
    event.sourceId === 'x-search' &&
    typeof record(event.metrics)?.topicKey === 'string'
  )
    return `x-topic:${record(event.metrics)!.topicKey}`;
  const chain = nonemptyString(event.chain)?.toLowerCase() ?? '';
  const assetKey =
    nonemptyString(event.assetKey) ?? nonemptyString(record(event.project)?.assetKey);
  if (assetKey) return `asset:${JSON.stringify([chain, assetKey])}`;
  const assets = Array.isArray(event.assets)
    ? [...new Set(event.assets.map(nonemptyString).filter((value) => value !== null))].sort()
    : [];
  if (!assets.length) return null;
  return `assets:${JSON.stringify([chain, assets])}`;
}

/** Keep deterministic evidence order while bounding the model's total source text. */
export function truncateAnalysisEvidence(evidence: Evidence[]): Evidence[] {
  let remaining = 8000;
  return evidence.slice(0, 5).map((item) => {
    const text = item.text.slice(0, Math.min(2400, remaining));
    remaining -= text.length;
    return { ...item, text };
  });
}
