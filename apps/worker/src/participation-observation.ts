import type { TransactionSql } from 'postgres';
import type { NormalizedEvent } from '@radar/connectors';
import type { ProjectObservation } from '@radar/signals';

export type ParticipationSnapshot = {
  observation: ProjectObservation;
  normalized: NormalizedEvent;
  nextObservationAt: string | null;
};

/** Select the newest known observation, including revocations. Never filter by
 * verification before choosing a row, or fall back to the mutable project DTO. */
export async function selectParticipationObservation(
  tx: TransactionSql,
  projectId: string,
  mode: 'fixture' | 'live',
  at: string,
  sourceIds?: readonly string[],
) {
  const rows = await tx`
    SELECT m.id,m.evidence_id,m.source_id,m.observed_at,m.available_at,m.data,p.asset_key
    FROM project_metrics m
    JOIN projects p ON p.id=m.project_id AND p.data->>'dataMode'=${mode}
    JOIN data_sources s ON s.id=m.source_id AND s.mode=${mode} AND s.enabled
    JOIN raw_items r ON r.id=m.evidence_id AND r.source_id=m.source_id
    WHERE m.project_id=${projectId} AND m.observed_at<=${at}::timestamptz
      AND m.available_at<=${at}::timestamptz
      AND (${sourceIds === undefined} OR m.source_id=ANY(${sourceIds ? [...sourceIds] : []}::text[]))
    ORDER BY m.observed_at DESC,m.source_id,m.id LIMIT 1`;
  const future = (
    await tx`
    SELECT min(greatest(m.observed_at,m.available_at)) AS available_at
    FROM project_metrics m JOIN data_sources s ON s.id=m.source_id AND s.mode=${mode} AND s.enabled
    WHERE m.project_id=${projectId} AND m.evidence_id IS NOT NULL AND m.available_at IS NOT NULL
      AND greatest(m.observed_at,m.available_at)>${at}::timestamptz
      AND (${sourceIds === undefined} OR m.source_id=ANY(${sourceIds ? [...sourceIds] : []}::text[]))`
  )[0];
  const nextObservationAt = future?.available_at
    ? new Date(future.available_at as string).toISOString()
    : null;
  const row = rows[0];
  if (!row) return { snapshot: null, observationId: null, nextObservationAt };
  const data = row.data as Record<string, unknown>;
  const metadata = (data.__observation ?? {}) as Record<string, unknown>;
  const normalized = metadata.event as NormalizedEvent | undefined;
  if (
    !normalized?.project ||
    normalized.dataMode !== mode ||
    normalized.sourceId !== row.source_id ||
    normalized.project.assetKey !== row.asset_key
  )
    return { snapshot: null, observationId: String(row.id), nextObservationAt };
  const observation: ProjectObservation = {
    evidenceId: String(row.evidence_id),
    sourceId: String(row.source_id),
    assetKey: String(row.asset_key),
    dataMode: mode,
    observedAt: new Date(row.observed_at as string).toISOString(),
    availableAt: new Date(row.available_at as string).toISOString(),
    metrics: normalized.metrics ?? {},
    stage: String(metadata.stage),
    verificationStatus: String(metadata.verificationStatus),
    confidence: Number(metadata.confidence),
    conditionsVerified: metadata.conditionsVerified === true,
    conditions: typeof metadata.conditions === 'string' ? metadata.conditions : null,
    startsAt: typeof metadata.startsAt === 'string' ? metadata.startsAt : null,
    endsAt: typeof metadata.endsAt === 'string' ? metadata.endsAt : null,
  };
  return {
    snapshot: { observation, normalized, nextObservationAt } satisfies ParticipationSnapshot,
    observationId: String(row.id),
    nextObservationAt,
  };
}
