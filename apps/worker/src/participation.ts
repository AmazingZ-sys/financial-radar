import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';
import type { TransactionSql, ReservedSql } from 'postgres';
import { sql } from '@radar/database';
import { config } from '@radar/config';
import type { Connector, NormalizedEvent } from '@radar/connectors';
import { createLogger, percentiles } from '@radar/observability';
import {
  DEFAULT_HISTORY_DETECTION,
  DEFAULT_SCORING_CONFIG,
  ScoringConfigSchema,
  detectParticipationWindow,
} from '@radar/signals';
import { persistEvent, persistHistoricalSignal } from './pipeline.js';
import {
  selectParticipationObservation,
  type ParticipationSnapshot,
} from './participation-observation.js';
import { earliestCheck, nextParticipationCheck } from './participation-planner.js';

const log = createLogger('worker.participation');
const BATCH = 25;
const BUDGET_MS = 2000;
const connectionContext = new AsyncLocalStorage<{ connection: ReservedSql; backendPid: number }>();
const mode = config.dataMode;
const json = (value: unknown) => sql.json(value as postgres.JSONValue);
const version = () =>
  `${DEFAULT_HISTORY_DETECTION.version}:${DEFAULT_HISTORY_DETECTION.windowEndingSeconds}:${config.participationSchedulerMode}`;
const iso = (value: unknown) => new Date(value as string).toISOString();
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,60}$/.test(code)
    ? code
    : 'PARTICIPATION_PROCESSING_FAILED';
};

async function transaction<T>(
  deadline: number,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const execute = async (tx: TransactionSql) => {
    const remaining = Math.max(1, deadline - Date.now());
    await tx`SELECT set_config('statement_timeout',${`${remaining}ms`},true),set_config('lock_timeout',${`${Math.min(100, remaining)}ms`},true),set_config('transaction_timeout',${`${remaining}ms`},true)`;
    return run(tx);
  };
  const context = connectionContext.getStore();
  if (!context) return sql.begin(execute) as Promise<T>;
  const { connection, backendPid } = context;
  // The global mutex and all work use the same physical session. Losing the
  // mutex connection therefore aborts its in-flight transaction as well.
  const session = (await connection`SELECT pg_backend_pid() AS pid`)[0];
  if (Number(session?.pid) !== backendPid) throw new Error('PARTICIPATION_LOCK_SESSION_LOST');
  await connection`BEGIN`;
  try {
    const result = await execute(connection as unknown as TransactionSql);
    await connection`COMMIT`;
    return result;
  } catch (error) {
    await connection`ROLLBACK`.catch(() => undefined);
    throw error;
  }
}
async function projectLock(tx: TransactionSql, assetKey: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`project:${mode}:${assetKey}`}))`;
}

/** All callers hold the same project lock as ingestion. A refresh invalidates
 * old claims; it never changes the project's lifecycle or historical facts. */
async function refreshProject(tx: TransactionSql, projectId: string, assetKey: string, at: string) {
  // Establish a commit order against source enable/disable transactions.
  await tx`SELECT s.id FROM data_sources s WHERE s.id IN (SELECT source_id FROM project_metrics WHERE project_id=${projectId}) ORDER BY s.id FOR SHARE`;
  const selected = await selectParticipationObservation(tx, projectId, mode, at);
  const snapshot = selected.snapshot;
  let check = nextParticipationCheck(snapshot?.observation ?? null, at);
  if (snapshot && check === at) {
    const candidate = detectParticipationWindow(snapshot.observation, at)[0];
    const exists =
      candidate &&
      (await tx`SELECT 1 FROM opportunity_signals WHERE dedup_key=${candidate.stableKey}`).length >
        0;
    if (exists) check = nextParticipationCheck(snapshot.observation, at, true);
  }
  check = earliestCheck(check, selected.nextObservationAt);
  await tx`INSERT INTO participation_window_plans(data_mode,project_id,asset_key,source_id,observation_id,evidence_id,observation_snapshot,revision,detector_version,next_check_at,status,updated_at)
    VALUES(${mode},${projectId},${assetKey},${snapshot?.observation.sourceId ?? null},${selected.observationId},${snapshot?.observation.evidenceId ?? null},${json(snapshot)},1,${version()},${check},${check ? 'WAITING' : 'IDLE'},${at})
    ON CONFLICT(data_mode,project_id) DO UPDATE SET asset_key=excluded.asset_key,source_id=excluded.source_id,observation_id=excluded.observation_id,evidence_id=excluded.evidence_id,observation_snapshot=excluded.observation_snapshot,revision=participation_window_plans.revision+1,detector_version=excluded.detector_version,next_check_at=excluded.next_check_at,status=excluded.status,claim_token=null,locked_until=null,attempts=0,last_error_code=null,updated_at=excluded.updated_at`;
  await tx`DELETE FROM participation_refresh_requests WHERE data_mode=${mode} AND asset_key=${assetKey}`;
}

export type ClaimedPlan = {
  data_mode: string;
  project_id: string;
  asset_key: string;
  revision: number;
  claim_token: string;
  locked_until: Date | string;
  next_check_at: Date | string;
};
export async function claimDuePlans(
  at: string,
  limit = BATCH,
  deadline = Date.now() + BUDGET_MS,
): Promise<ClaimedPlan[]> {
  const token = randomUUID();
  return transaction(
    deadline,
    async (tx) =>
      await tx<ClaimedPlan[]>`
    WITH due AS (SELECT data_mode,project_id FROM participation_window_plans
      WHERE data_mode=${mode} AND status='WAITING' AND next_check_at<=${at}::timestamptz
      ORDER BY next_check_at,project_id LIMIT ${Math.max(0, Math.min(BATCH, limit))} FOR UPDATE SKIP LOCKED)
    UPDATE participation_window_plans p SET status='PROCESSING',claim_token=${token},locked_until=${at}::timestamptz+interval '60 seconds',updated_at=${at}
    FROM due WHERE p.data_mode=due.data_mode AND p.project_id=due.project_id RETURNING p.*`,
  );
}

export async function processClaimedPlan(
  plan: ClaimedPlan,
  at: string,
  options: { deadline?: number } = {},
) {
  return transaction(options.deadline ?? Date.now() + BUDGET_MS, async (tx) => {
    await projectLock(tx, plan.asset_key);
    const row = (
      await tx`SELECT * FROM participation_window_plans WHERE data_mode=${mode} AND project_id=${plan.project_id} FOR UPDATE`
    )[0];
    const empty = { detected: 0, stale: true, refreshed: false };
    if (
      plan.data_mode !== mode ||
      !row ||
      row.status !== 'PROCESSING' ||
      row.revision !== plan.revision ||
      row.claim_token !== plan.claim_token ||
      Date.parse(iso(row.locked_until)) <= Date.parse(at)
    )
      return empty;
    // Lock every candidate source, so a newly enabled alternative cannot race
    // the latest-observation decision. Locks precede request deletion.
    await tx`SELECT s.id FROM data_sources s WHERE s.id IN (SELECT source_id FROM project_metrics WHERE project_id=${plan.project_id}) ORDER BY s.id FOR SHARE`;
    const dirty = (
      await tx`SELECT
      EXISTS(SELECT 1 FROM participation_refresh_requests WHERE data_mode=${mode} AND asset_key=${plan.asset_key}) OR
      EXISTS(SELECT 1 FROM participation_source_refreshes s WHERE s.data_mode=${mode} AND EXISTS(SELECT 1 FROM project_metrics m WHERE m.project_id=${plan.project_id} AND m.source_id=s.source_id)) AS dirty`
    )[0]!.dirty;
    let snapshot = row.observation_snapshot as ParticipationSnapshot | null;
    if (
      dirty ||
      !snapshot ||
      row.detector_version !== version() ||
      (snapshot.nextObservationAt && Date.parse(snapshot.nextObservationAt) <= Date.parse(at))
    ) {
      await refreshProject(tx, plan.project_id, plan.asset_key, at);
      return { detected: 0, stale: true, refreshed: true };
    }
    if (config.participationSchedulerMode === 'legacy')
      snapshot = (await selectParticipationObservation(tx, plan.project_id, mode, at)).snapshot;
    const saved = (await tx`SELECT data FROM system_settings WHERE key='scoring-config'`)[0];
    const scoring = saved ? ScoringConfigSchema.parse(saved.data) : DEFAULT_SCORING_CONFIG;
    let detected = 0;
    for (const signal of snapshot ? detectParticipationWindow(snapshot.observation, at) : []) {
      if (
        config.participationSchedulerMode === 'due' ||
        config.participationSchedulerMode === 'legacy'
      ) {
        if (
          await persistHistoricalSignal(
            tx,
            snapshot!.normalized,
            plan.project_id,
            signal,
            at,
            scoring,
          )
        )
          detected++;
      }
    }
    const next = earliestCheck(
      nextParticipationCheck(snapshot?.observation ?? null, at, true),
      snapshot?.nextObservationAt ?? null,
    );
    await tx`UPDATE participation_window_plans SET status=${next ? 'WAITING' : 'IDLE'},next_check_at=${next},claim_token=null,locked_until=null,attempts=0,last_error_code=null,updated_at=${at}
      WHERE data_mode=${mode} AND project_id=${plan.project_id} AND revision=${plan.revision} AND claim_token=${plan.claim_token} AND status='PROCESSING'`;
    return { detected, stale: false, refreshed: false };
  });
}
async function releaseClaims(plans: ClaimedPlan[]) {
  if (!plans.length) return;
  await transaction(Date.now() + 250, async (tx) => {
    await tx`UPDATE participation_window_plans p SET status='WAITING',claim_token=null,locked_until=null
      FROM unnest(${plans.map((p) => p.project_id)}::uuid[],${plans.map((p) => p.revision)}::int[]) r(project_id,revision)
      WHERE p.data_mode=${mode} AND p.project_id=r.project_id AND p.revision=r.revision AND p.claim_token=${plans[0]!.claim_token} AND p.status='PROCESSING'`;
  });
}
async function failClaim(plan: ClaimedPlan, at: string, error: unknown) {
  const rows = await transaction(
    Date.now() + 250,
    async (tx) =>
      await tx`UPDATE participation_window_plans SET status=CASE WHEN attempts+1>=5 THEN 'FAILED' ELSE 'WAITING' END,
    attempts=attempts+1,last_error_code=${errorCode(error)},next_check_at=${at}::timestamptz+least(900,5*power(2,least(attempts,8)))*interval '1 second',claim_token=null,locked_until=null,updated_at=${at}
    WHERE data_mode=${mode} AND project_id=${plan.project_id} AND revision=${plan.revision} AND claim_token=${plan.claim_token} AND status='PROCESSING' RETURNING status`,
  );
  if (rows[0]?.status === 'FAILED')
    log.error(
      { code: errorCode(error) },
      'participation plan retained in FAILED; inspect and request refresh to retry',
    );
}

async function expandSourceRefresh(at: string, deadline: number) {
  return transaction(deadline, async (tx) => {
    const request = (
      await tx`SELECT * FROM participation_source_refreshes WHERE data_mode=${mode} ORDER BY requested_at,source_id LIMIT 1 FOR UPDATE SKIP LOCKED`
    )[0];
    if (!request) return 0;
    const projects =
      request.cursor === null
        ? await tx`SELECT DISTINCT m.project_id FROM project_metrics m JOIN projects p ON p.id=m.project_id AND p.data->>'dataMode'=${mode}
          WHERE m.source_id=${String(request.source_id)} ORDER BY m.project_id LIMIT 50`
        : await tx`SELECT DISTINCT m.project_id FROM project_metrics m JOIN projects p ON p.id=m.project_id AND p.data->>'dataMode'=${mode}
          WHERE m.source_id=${String(request.source_id)} AND m.project_id>${String(request.cursor)}::uuid ORDER BY m.project_id LIMIT 50`;
    if (projects.length) {
      const ids = projects.map((row) => String(row.project_id));
      await tx`INSERT INTO participation_refresh_requests(data_mode,asset_key,requested_at,next_attempt_at)
        SELECT ${mode},asset_key,${at}::timestamptz,${at}::timestamptz FROM projects WHERE id=ANY(${ids}::uuid[])
        ON CONFLICT(data_mode,asset_key) DO UPDATE SET requested_at=excluded.requested_at,next_attempt_at=excluded.next_attempt_at,attempts=0,last_error_code=null`;
    }
    if (projects.length < 50)
      await tx`DELETE FROM participation_source_refreshes WHERE data_mode=${mode} AND source_id=${String(request.source_id)}`;
    else
      await tx`UPDATE participation_source_refreshes SET cursor=${String(projects.at(-1)!.project_id)} WHERE data_mode=${mode} AND source_id=${String(request.source_id)}`;
    return projects.length;
  });
}

async function refreshPending(at: string, deadline: number, shouldStop: () => boolean) {
  const requests = await transaction(
    deadline,
    async (tx) =>
      await tx`SELECT asset_key,requested_at::text AS requested_at_token FROM participation_refresh_requests WHERE data_mode=${mode} AND attempts<5 AND next_attempt_at<=${at}::timestamptz ORDER BY next_attempt_at,asset_key LIMIT ${BATCH}`,
  );
  let refreshed = 0;
  for (const request of requests) {
    if (shouldStop() || Date.now() >= deadline) break;
    const asset = String(request.asset_key);
    try {
      await transaction(deadline, async (tx) => {
        await projectLock(tx, asset);
        const p = (
          await tx`SELECT id FROM projects WHERE asset_key=${asset} AND data->>'dataMode'=${mode}`
        )[0];
        if (p) await refreshProject(tx, String(p.id), asset, at);
        else
          await tx`DELETE FROM participation_refresh_requests WHERE data_mode=${mode} AND asset_key=${asset}`;
      });
      refreshed++;
    } catch (error) {
      // A concurrent new request resets the failure count; never poison it with
      // an older attempt after releasing the project lock.
      await transaction(Date.now() + 250, async (tx) => {
        await tx`UPDATE participation_refresh_requests SET attempts=attempts+1,last_error_code=${errorCode(error)},next_attempt_at=${at}::timestamptz+least(900,5*power(2,least(attempts,8)))*interval '1 second' WHERE data_mode=${mode} AND asset_key=${asset} AND requested_at=${String(request.requested_at_token)}::timestamptz`;
      }).catch(() => log.warn('participation refresh retry metadata remains pending'));
      log.warn({ code: errorCode(error) }, 'participation refresh deferred');
    }
  }
  return refreshed;
}

async function replayDeferred(at: string, deadline: number, shouldStop: () => boolean) {
  const rows = await transaction(
    deadline,
    async (tx) =>
      await tx`SELECT d.*,r.external_id FROM participation_deferred_observations d JOIN raw_items r ON r.id=d.raw_item_id
    JOIN data_sources s ON s.id=d.source_id AND s.enabled AND s.mode=${mode}
    WHERE d.data_mode=${mode} AND d.attempts<5 AND d.available_at<=${at}::timestamptz AND d.next_attempt_at<=${at}::timestamptz ORDER BY d.next_attempt_at,d.raw_item_id LIMIT ${BATCH}`,
  );
  let replayed = 0;
  for (const row of rows) {
    if (shouldStop() || Date.now() >= deadline) break;
    try {
      const normalized = row.payload as NormalizedEvent;
      if (
        normalized.dataMode !== mode ||
        normalized.sourceId !== row.source_id ||
        normalized.project?.assetKey !== row.asset_key
      )
        throw new Error('invalid deferred observation');
      const connector: Connector = {
        metadata: {
          id: String(row.source_id),
          name: 'Persisted observation',
          officialUrl: normalized.originalUrl,
          mode,
          transport: 'pull',
          categories: [],
          trust: normalized.confidence,
          pollIntervalSeconds: 60,
          licenseStatus: 'internal-research-only',
        },
        capabilities: {
          history: true,
          checkpoint: true,
          scope: 'watchlist',
          sourceTimestamp: false,
        },
        rateLimit: { maxRequests: 1, windowMs: 1000, respectRetryAfter: true },
        initialize: async () => {},
        fetch: async () => ({ items: [], cursor: {} }),
        shutdown: async () => {},
        healthCheck: async () => ({ status: 'healthy', detail: 'persisted evidence' }),
        normalize: () => normalized,
      };
      await transaction(
        deadline,
        async (tx) =>
          await persistEvent(
            connector,
            String(row.raw_item_id),
            iso(row.first_seen_at),
            {
              externalId: String(row.external_id),
              payload: {},
              publishedAt: normalized.sourcePublishedAt,
            },
            at,
            deadline,
            { transaction: tx, requireEnabledSource: true },
          ),
      );
      await transaction(Date.now() + 250, async (tx) => {
        await tx`DELETE FROM participation_deferred_observations d USING project_metrics m,projects p WHERE d.raw_item_id=${String(row.raw_item_id)} AND d.data_mode=${mode} AND m.evidence_id=d.raw_item_id AND p.id=m.project_id AND p.data->>'dataMode'=${mode}`;
      });
      replayed++;
    } catch (error) {
      await transaction(Date.now() + 250, async (tx) => {
        await tx`UPDATE participation_deferred_observations SET attempts=attempts+1,last_error_code=${errorCode(error)},next_attempt_at=${at}::timestamptz+least(900,5*power(2,least(attempts,8)))*interval '1 second' WHERE raw_item_id=${String(row.raw_item_id)} AND data_mode=${mode}`;
      });
      log.warn({ code: errorCode(error) }, 'future participation observation retained for retry');
    }
  }
  return replayed;
}

/** Bounded, restartable keyset repair. New projects behind the UUID cursor are
 * captured by the metric trigger, rather than relying on UUID insertion order. */
async function repairPlans(at: string, deadline: number, shouldStop: () => boolean) {
  const projects = await transaction(deadline, async (tx) => {
    await tx`INSERT INTO participation_repair_state(data_mode,cursor,next_run_at,detector_version) VALUES(${mode},null,${at},${version()}) ON CONFLICT(data_mode) DO NOTHING`;
    await tx`UPDATE participation_repair_state SET cursor=null,next_run_at=${at},detector_version=${version()} WHERE data_mode=${mode} AND detector_version<>${version()}`;
    const state = (
      await tx`SELECT * FROM participation_repair_state WHERE data_mode=${mode} AND next_run_at<=${at}::timestamptz`
    )[0];
    if (!state) return null;
    return state.cursor === null
      ? await tx`SELECT id,asset_key FROM projects WHERE data->>'dataMode'=${mode} ORDER BY id LIMIT 50`
      : await tx`SELECT id,asset_key FROM projects WHERE data->>'dataMode'=${mode} AND id>${String(state.cursor)}::uuid ORDER BY id LIMIT 50`;
  });
  if (!projects) return 0;
  let repaired = 0;
  for (const project of projects) {
    if (shouldStop() || Date.now() >= deadline) break;
    const id = String(project.id);
    await transaction(deadline, async (tx) => {
      await projectLock(tx, String(project.asset_key));
      // Enqueue only. A bad observation is isolated by the refresh retry path,
      // and the cursor can advance without overwriting a newer projection.
      await tx`INSERT INTO participation_refresh_requests(data_mode,asset_key,requested_at,next_attempt_at) VALUES(${mode},${String(project.asset_key)},${at},${at}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE participation_repair_state SET cursor=${id} WHERE data_mode=${mode}`;
    });
    repaired++;
  }
  if (repaired === projects.length && projects.length < 50)
    await transaction(deadline, async (tx) => {
      await tx`UPDATE participation_repair_state SET cursor=null,next_run_at=${at}::timestamptz+interval '1 day' WHERE data_mode=${mode}`;
    });
  return repaired;
}

export async function runParticipationTick(
  options: { at?: string; shouldStop?: () => boolean } = {},
) {
  const at = options.at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error('窗口检测时钟无效');
  const shouldStop = options.shouldStop ?? (() => false);
  const started = Date.now();
  const stats = {
    processed: 0,
    detected: 0,
    refreshed: 0,
    recovered: 0,
    stale: 0,
    failed: 0,
    replayed: 0,
    repaired: 0,
    expanded: 0,
    claimed: 0,
    skipped: false,
  };
  if (config.participationSchedulerMode === 'paused' || shouldStop()) return stats;
  const connection = await sql.reserve();
  let locked = false;
  try {
    // Session lock spans short transactions without holding a long transaction
    // or relying on Redis. Every replica shares the same per-mode concurrency 1.
    const session = (
      await connection`SELECT pg_try_advisory_lock(734862902,hashtext(${mode})) AS locked,pg_backend_pid() AS pid`
    )[0]!;
    locked = Boolean(session.locked);
    if (!locked) return { ...stats, skipped: true };
    return await connectionContext.run(
      { connection, backendPid: Number(session.pid) },
      async () => {
        const deadline = Date.now() + BUDGET_MS;
        const recovered = await transaction(
          deadline,
          async (tx) =>
            await tx`WITH expired AS (SELECT project_id FROM participation_window_plans WHERE data_mode=${mode} AND status='PROCESSING' AND locked_until<=${at}::timestamptz ORDER BY locked_until,project_id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      UPDATE participation_window_plans p SET status=CASE WHEN attempts+1>=5 THEN 'FAILED' ELSE 'WAITING' END,attempts=attempts+1,claim_token=null,locked_until=null,last_error_code='LEASE_EXPIRED',updated_at=${at}
      FROM expired e WHERE p.data_mode=${mode} AND p.project_id=e.project_id RETURNING p.project_id`,
        );
        stats.recovered = recovered.length;
        // Reserve time for both due alerts and incoming changes. A continuous
        // refresh stream must not starve already scheduled deadlines (or vice versa).
        const dueDeadline = Math.min(deadline, Date.now() + 1500);
        const delays: number[] = [];
        const durations: number[] = [];
        const processDueBatch = async (batchDeadline: number) => {
          if (Date.now() >= batchDeadline || shouldStop() || stats.claimed >= BATCH) return;
          const plans = await claimDuePlans(at, BATCH - stats.claimed, batchDeadline);
          stats.claimed += plans.length;
          try {
            for (const plan of plans) {
              if (shouldStop() || Date.now() >= batchDeadline) break;
              const projectStarted = Date.now();
              try {
                const result = await processClaimedPlan(plan, at, { deadline: batchDeadline });
                stats.processed++;
                stats.detected += result.detected;
                stats.stale += Number(result.stale);
                stats.refreshed += Number(result.refreshed);
                delays.push(Math.max(0, Date.parse(at) - Date.parse(iso(plan.next_check_at))));
              } catch (error) {
                stats.failed++;
                await failClaim(plan, at, error);
              }
              durations.push(Date.now() - projectStarted);
            }
          } finally {
            await releaseClaims(plans);
          }
        };
        await processDueBatch(dueDeadline);
        if (!shouldStop() && Date.now() < deadline)
          stats.expanded = await expandSourceRefresh(at, deadline);
        if (!shouldStop() && Date.now() < deadline)
          stats.refreshed += await refreshPending(at, deadline, shouldStop);
        if (!shouldStop() && Date.now() < deadline)
          stats.replayed = await replayDeferred(at, deadline, shouldStop);
        // Fresh observations can require an immediate check. Use remaining budget
        // so --once and newly entered windows do not require another timer turn.
        await processDueBatch(deadline);
        if (!shouldStop())
          stats.repaired = await repairPlans(at, Date.now() + BUDGET_MS, shouldStop);
        const { oldest, refreshBacklog } = await transaction(Date.now() + 250, async (tx) => {
          const oldest = (
            await tx`SELECT next_check_at FROM participation_window_plans WHERE data_mode=${mode} AND status='WAITING' AND next_check_at<=${at}::timestamptz ORDER BY next_check_at,project_id LIMIT 1`
          )[0];
          const refreshBacklog = (
            await tx`SELECT count(*)::int AS n FROM (SELECT 1 FROM participation_refresh_requests WHERE data_mode=${mode} LIMIT 1001) q`
          )[0]!.n;
          return { oldest, refreshBacklog };
        });
        log.info(
          {
            ...stats,
            mode,
            schedulerMode: config.participationSchedulerMode,
            durationMs: Date.now() - started,
            dueWaitMs: percentiles(delays),
            projectSqlMs: percentiles(durations),
            oldestDueAgeMs: oldest
              ? Math.max(0, Date.parse(at) - Date.parse(iso(oldest.next_check_at)))
              : 0,
            refreshBacklogCapped: Number(refreshBacklog),
          },
          'participation tick',
        );
        return stats;
      },
    );
  } finally {
    try {
      if (locked) await connection`SELECT pg_advisory_unlock(734862902,hashtext(${mode}))`;
    } finally {
      connection.release();
    }
  }
}
