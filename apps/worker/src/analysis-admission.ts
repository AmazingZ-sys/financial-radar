import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { sql, readAIConfig } from '@radar/database';
import { config } from '@radar/config';
import { randomUUID } from 'node:crypto';
import {
  ANALYSIS_POLICY_VERSION,
  analysisCooldownKey,
  evaluateAnalysisCandidate,
} from './analysis-policy.js';

export const MAX_PENDING_ANALYSES = 20;
const json = (data: unknown) => sql.json(data as postgres.JSONValue);

export function analysisDecision(reason: string, at = new Date().toISOString()) {
  return { version: ANALYSIS_POLICY_VERSION, reason, decidedAt: at };
}

export async function initialAnalysisState(event: Record<string, unknown>) {
  const decision = evaluateAnalysisCandidate(event);
  if (!decision.eligible)
    return {
      analysisStatus: 'SKIPPED' as const,
      analysisDecision: analysisDecision(decision.reason),
    };
  if (config.dataMode === 'fixture') return { analysisStatus: 'PENDING' as const };
  try {
    const ai = await readAIConfig();
    return {
      analysisStatus:
        ai.enabled && ai.apiKey && ai.model ? ('PENDING' as const) : ('DISABLED' as const),
    };
  } catch {
    // A broken AI configuration must never prevent deterministic event persistence.
    return { analysisStatus: 'DISABLED' as const };
  }
}

export async function skipAnalysis(tx: TransactionSql, id: string, reason: string) {
  // Lock first, then read RUNNING in a new statement snapshot after any reservation commits.
  await tx`SELECT id FROM events WHERE id=${id} FOR UPDATE`;
  // Keep successful historical research and its usage ledger intact.
  await tx`UPDATE events SET data=jsonb_set(data || '{"analysisStatus":"SKIPPED"}'::jsonb,'{analysisDecision}',coalesce(data->'analysisDecision','{}'::jsonb) || ${json(analysisDecision(reason))}::jsonb) WHERE id=${id} AND coalesce(data->>'analysisStatus','')<>'COMPLETED' AND NOT EXISTS(SELECT 1 FROM ai_analysis_runs r WHERE r.event_id=events.id AND r.status='RUNNING')`;
  await tx`UPDATE outbox_jobs SET status='COMPLETED',locked_until=null WHERE entity_id=${id} AND upper(kind) IN ('ANALYZE','ANALYSIS') AND status IN ('PENDING','QUEUED') AND NOT EXISTS(SELECT 1 FROM ai_analysis_runs r WHERE r.event_id=${id} AND r.status='RUNNING')`;
}

export async function enqueueAnalysis(tx: TransactionSql, event: Record<string, unknown>) {
  if (event.analysisStatus !== 'PENDING') return;
  const id = String(event.id);
  if (event.dataMode === 'live') {
    // Serialize admission, capacity and cooldown across all worker replicas.
    await tx`SELECT pg_advisory_xact_lock(hashtext('financial-radar-ai-admission'))`;
    const pending = (
      await tx`SELECT count(*)::int AS count FROM outbox_jobs o JOIN events e ON e.id=o.entity_id WHERE upper(o.kind) IN ('ANALYZE','ANALYSIS') AND o.status IN ('PENDING','QUEUED') AND e.data->>'dataMode'='live'`
    )[0]!;
    if (Number(pending.count) >= MAX_PENDING_ANALYSES) {
      await skipAnalysis(tx, id, 'CANDIDATE_CAPACITY');
      return;
    }
    const key = analysisCooldownKey(event);
    if (key) {
      const recent =
        await tx`SELECT id FROM events WHERE id<>${id} AND data->>'dataMode'='live' AND data->'analysisDecision'->>'cooldownKey'=${key} AND (data->'analysisDecision'->>'admittedAt')::timestamptz>now()-interval '6 hours' LIMIT 1`;
      if (recent.length) {
        await skipAnalysis(tx, id, 'ASSET_COOLDOWN');
        return;
      }
    }
    await tx`UPDATE events SET data=data || ${json({ analysisDecision: { ...analysisDecision('SELECTED'), cooldownKey: key, admittedAt: new Date().toISOString() } })}::jsonb WHERE id=${id}`;
  }
  await tx`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) VALUES(${randomUUID()},${'analyze:' + id},'ANALYZE',${id}) ON CONFLICT DO NOTHING`;
}
