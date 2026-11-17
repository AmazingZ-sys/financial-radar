import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Connector, NormalizedEvent, RawItem } from '../packages/connectors/src/index.js';
import { config } from '../packages/config/src/index.js';
import { sql, closeDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { persistEvent } from '../apps/worker/src/pipeline.js';
import { withSqlDeadline } from '../apps/worker/src/sql-deadline.js';
import {
  runParticipationTick,
  claimDuePlans,
  processClaimedPlan,
} from '../apps/worker/src/participation.js';

type TransactionSql = Parameters<typeof withSqlDeadline>[0];

/** All observations are synthetic Fixture facts in the real PostgreSQL pipeline.
 * No notification provider or AI endpoint is contacted by this acceptance. */
export async function verifyParticipationScheduler() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('Participation acceptance requires a non-production Fixture database');
  const suffix = randomUUID();
  const sources = [`window-a-${suffix}`, `window-b-${suffix}`];
  const assetPrefix = `fixture:window:${suffix}:`;
  const base = Date.now();
  const time = (seconds: number) => new Date(base + seconds * 1000).toISOString();
  const end = time(7200);
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  const originalMode = config.participationSchedulerMode;
  const repair = (await sql`SELECT * FROM participation_repair_state WHERE data_mode='fixture'`)[0];
  let checks = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    checks++;
  };
  function connector(sourceId: string): Connector {
    return {
      metadata: {
        id: sourceId,
        name: sourceId,
        officialUrl: 'https://example.org/window-fixture',
        transport: 'pull',
        mode: 'fixture',
        categories: ['history'],
        trust: 0.9,
        pollIntervalSeconds: 60,
        licenseStatus: 'internal-research-only',
      },
      capabilities: { history: true, checkpoint: true, scope: 'watchlist', sourceTimestamp: false },
      rateLimit: { maxRequests: 1, windowMs: 1000, respectRetryAfter: true },
      initialize: async () => {},
      fetch: async () => ({ items: [], cursor: {} }),
      healthCheck: async () => ({ status: 'healthy', detail: 'synthetic fixture' }),
      shutdown: async () => {},
      normalize: (item) => item.payload.normalized as NormalizedEvent,
    };
  }
  function normalized(name: string, changes: Partial<NormalizedEvent> = {}): NormalizedEvent {
    const assetKey = assetPrefix + name;
    return {
      sourceId: sources[0]!,
      externalId: randomUUID(),
      title: `Synthetic window ${name}`,
      description: 'Synthetic acceptance evidence; no investment conclusion',
      eventType: 'TOKEN_STATE_SNAPSHOT',
      originalUrl: 'https://example.org/window-fixture',
      sourcePublishedAt: null,
      eventOccurredAt: null,
      assets: [assetKey],
      categories: ['history'],
      chain: 'Fixture',
      assetKey,
      identity: randomUUID(),
      confidence: 0.95,
      severity: 'P2',
      verificationStatus: 'VERIFIED',
      dataMode: 'fixture',
      conditionsVerified: true,
      project: {
        assetKey,
        name: `Synthetic window ${name}`,
        chain: 'Fixture',
        protocol: 'Fixture',
        stage: 'ACTIVE',
        conditions: 'Verified synthetic terms',
        startsAt: time(-3600),
        endsAt: end,
      },
      metrics: { observedAt: time(-60) },
      ...changes,
    };
  }
  async function raw(event: NormalizedEvent) {
    const rawId = randomUUID();
    const item: RawItem = {
      externalId: event.externalId,
      publishedAt: null,
      payload: { normalized: event },
    };
    await sql`INSERT INTO raw_items(id,source_id,external_id,payload,published_at,first_seen_at,collected_at) VALUES(${rawId},${event.sourceId},${item.externalId},${json(item.payload)},null,${time(-10)},${time(-10)})`;
    return { rawId, item };
  }
  async function bootstrap(event: NormalizedEvent) {
    const { rawId, item } = await raw(event);
    await persistEvent(connector(event.sourceId), rawId, time(-10), item, time(0));
    await alignRefreshClock(event.project!.assetKey);
    const project = (
      await sql`SELECT id FROM projects WHERE asset_key=${event.project!.assetKey}`
    )[0];
    return { rawId, projectId: project ? String(project.id) : null };
  }
  async function append(projectId: string, event: NormalizedEvent, availableAt = time(0)) {
    const { rawId } = await raw(event);
    const id = randomUUID();
    availableAt = new Date(
      Math.max(Date.parse(availableAt), Date.parse(String(event.metrics!.observedAt))),
    ).toISOString();
    await sql`INSERT INTO project_metrics(id,project_id,source_id,observed_at,evidence_id,available_at,data)
      VALUES(${id},${projectId},${event.sourceId},${String(event.metrics!.observedAt)},${rawId},${availableAt},${json(
        {
          ...event.metrics,
          evidenceId: rawId,
          availableAt,
          __observation: {
            stage: event.project!.stage,
            verificationStatus: event.verificationStatus,
            confidence: event.confidence,
            conditionsVerified: event.conditionsVerified,
            conditions: event.project!.conditions,
            startsAt: event.project!.startsAt,
            endsAt: event.project!.endsAt,
            event,
          },
        },
      )})`;
    await alignRefreshClock(event.project!.assetKey);
    return rawId;
  }
  async function alignRefreshClock(assetKey: string) {
    // Metric triggers use PostgreSQL's real clock. These scenarios deliberately
    // move their synthetic detector clock backwards, independently of test speed.
    await sql`UPDATE participation_refresh_requests SET requested_at=${time(0)},next_attempt_at=${time(0)}
      WHERE data_mode='fixture' AND asset_key=${assetKey} AND attempts=0`;
  }
  async function plan(projectId: string) {
    return (
      await sql`SELECT * FROM participation_window_plans WHERE data_mode='fixture' AND project_id=${projectId}`
    )[0]!;
  }
  async function count(projectId: string, type: string) {
    return Number(
      (
        await sql`SELECT count(*)::int n FROM opportunity_signals WHERE project_id=${projectId} AND data->>'type'=${type}`
      )[0]!.n,
    );
  }
  async function tick(seconds: number) {
    return runParticipationTick({ at: time(seconds) });
  }
  async function claim(projectId: string, seconds: number) {
    const claims = await claimDuePlans(time(seconds), 25);
    const selected = claims.find((entry) => entry.project_id === projectId);
    for (const other of claims.filter((entry) => entry.project_id !== projectId))
      await sql`UPDATE participation_window_plans SET status='WAITING',claim_token=null,locked_until=null
        WHERE data_mode=${other.data_mode} AND project_id=${other.project_id} AND revision=${other.revision}
          AND claim_token=${other.claim_token} AND status='PROCESSING'`;
    assert.ok(selected, 'synthetic project was present in the bounded due batch');
    return selected;
  }
  async function refresh(seconds: number) {
    const drainDeadline = Date.now() + 30000;
    for (let pass = 0; pass < 100 && Date.now() < drainDeadline; pass++) {
      await tick(seconds);
      const pending = (
        await sql`SELECT
          EXISTS(SELECT 1 FROM participation_refresh_requests WHERE data_mode='fixture' AND asset_key LIKE ${assetPrefix + '%'}) OR
          EXISTS(SELECT 1 FROM participation_source_refreshes WHERE data_mode='fixture' AND source_id=ANY(${sources}::text[])) OR
          EXISTS(SELECT 1 FROM participation_deferred_observations WHERE data_mode='fixture' AND asset_key LIKE ${assetPrefix + '%'} AND available_at<=${time(seconds)}::timestamptz) OR
          EXISTS(SELECT 1 FROM participation_window_plans WHERE data_mode='fixture' AND asset_key LIKE ${assetPrefix + '%'} AND status='WAITING' AND next_check_at<=${time(seconds)}::timestamptz)
          AS pending`
      )[0]!.pending;
      if (!pending) return;
    }
    throw new Error(
      'Synthetic participation backlog did not drain within 100 bounded ticks or 30 seconds',
    );
  }
  try {
    config.participationSchedulerMode = 'due';
    for (const sourceId of sources)
      await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES(${sourceId},${sourceId},true,'fixture','{}')`;
    const initial = normalized('boundary');
    initial.project!.startsAt = time(5400);
    const first = await bootstrap(initial);
    const projectId = first.projectId!;
    check(projectId, 'ingestion established the synthetic project');
    const metric = (
      await sql`SELECT evidence_id,available_at FROM project_metrics WHERE project_id=${projectId}`
    )[0]!;
    check(
      metric.evidence_id === first.rawId && metric.available_at,
      'ingestion writes typed evidence and availability',
    );
    check(
      (
        await sql`SELECT 1 FROM participation_refresh_requests WHERE asset_key=${initial.project!.assetKey}`
      ).length === 1,
      'ingestion atomically leaves a durable refresh request',
    );
    await refresh(2);
    let current = await plan(projectId);
    check(
      current.status === 'WAITING' &&
        new Date(current.next_check_at as string).toISOString() === time(5400),
      'start after E-W postpones the earliest warning until the start gate',
    );
    // Suppress daily repair while observing an idle tick: normal polling must not
    // refresh plans merely because projects or immutable historical facts exist.
    await sql`UPDATE participation_repair_state SET next_run_at=${time(1000000)} WHERE data_mode='fixture'`;
    const idleRevision = current.revision;
    const idle = await tick(3);
    current = await plan(projectId);
    check(
      idle.processed === 0 && idle.refreshed === 0 && current.revision === idleRevision,
      'idle polling performs no per-project work and preserves the projection revision',
    );
    await tick(3601);
    check(
      (await count(projectId, 'PARTICIPATION_WINDOW_EXPIRING')) === 0,
      'warning cannot precede a later verified start',
    );
    await tick(5400);
    await tick(5401);
    check(
      (await count(projectId, 'PARTICIPATION_WINDOW_EXPIRING')) === 1,
      'clock crossing produces one expiring signal across retries',
    );
    const changedEvidence = normalized('boundary', {
      sourceId: sources[1]!,
      metrics: { observedAt: time(30) },
    });
    changedEvidence.project!.startsAt = time(5400);
    await append(projectId, changedEvidence);
    await refresh(5500);
    current = await plan(projectId);
    check(
      current.next_check_at && new Date(current.next_check_at as string).toISOString() === end,
      `same-end replacement keeps its expiration scheduled: ${JSON.stringify(current)}`,
    );
    check(
      (await count(projectId, 'PARTICIPATION_WINDOW_EXPIRING')) === 1,
      'new evidence and source with the same end keep the business stable key',
    );
    await tick(7201);
    await tick(7202);
    check(
      (await count(projectId, 'PARTICIPATION_WINDOW_EXPIRED')) === 1,
      'expiration is idempotent',
    );
    current = await plan(projectId);
    check(
      current.status === 'IDLE' && current.next_check_at === null,
      'completed expiration stops future polling of that plan',
    );
    check(
      (await sql`SELECT stage FROM projects WHERE id=${projectId}`)[0]!.stage === 'ACTIVE',
      'window expiration does not complete the project lifecycle',
    );

    const revokedEvent = normalized('revoked');
    const revoked = (await bootstrap(revokedEvent)).projectId!;
    await refresh(2);
    const oldRevision = (await plan(revoked)).revision;
    const revocation = normalized('revoked', {
      verificationStatus: 'UNVERIFIED',
      conditionsVerified: false,
      metrics: { observedAt: time(20) },
    });
    revocation.project!.conditions = null;
    await append(revoked, revocation);
    await refresh(3500);
    current = await plan(revoked);
    check(
      Number(current.revision) > Number(oldRevision) && current.next_check_at === null,
      'fresh unverified observation supersedes the older verified terms',
    );
    await tick(7300);
    check(
      (await count(revoked, 'PARTICIPATION_WINDOW_EXPIRED')) === 0,
      'revoked terms cannot emit the old expiration',
    );

    const retimedEvent = normalized('retimed');
    const retimed = (await bootstrap(retimedEvent)).projectId!;
    await refresh(2);
    const extended = normalized('retimed', { metrics: { observedAt: time(20) } });
    extended.project!.endsAt = time(10800);
    await append(retimed, extended);
    await refresh(3500);
    check(
      new Date((await plan(retimed)).next_check_at as string).toISOString() === time(7200),
      'extending the end replaces the old warning schedule',
    );
    await tick(3600);
    check(
      (await count(retimed, 'PARTICIPATION_WINDOW_EXPIRING')) === 0,
      'extended terms do not use the old threshold',
    );
    const shortened = normalized('retimed', { metrics: { observedAt: time(30) } });
    shortened.project!.endsAt = time(4500);
    await append(retimed, shortened);
    await refresh(3601);
    check(
      (await count(retimed, 'PARTICIPATION_WINDOW_EXPIRING')) === 1,
      'shortening the end into the warning interval triggers immediately',
    );
    await tick(4501);
    check(
      (await count(retimed, 'PARTICIPATION_WINDOW_EXPIRED')) === 1,
      'shortened window expires at its replacement deadline',
    );

    const fallbackEvent = normalized('source-fallback');
    const fallback = (await bootstrap(fallbackEvent)).projectId!;
    const recent = normalized('source-fallback', {
      sourceId: sources[1]!,
      conditionsVerified: false,
      metrics: { observedAt: time(20) },
    });
    await append(fallback, recent);
    await refresh(100);
    check(
      (await plan(fallback)).source_id === sources[1],
      'latest available source wins even when it revokes eligibility',
    );
    await sql`UPDATE data_sources SET enabled=false WHERE id=${sources[1]!}`;
    await refresh(101);
    check(
      (await plan(fallback)).source_id === sources[0] && (await plan(fallback)).next_check_at,
      'disabling the latest source durably refreshes and falls back to the enabled source',
    );
    await sql`UPDATE data_sources SET enabled=true WHERE id=${sources[1]!}`;
    await refresh(102);
    check(
      (await plan(fallback)).source_id === sources[1] &&
        (await plan(fallback)).next_check_at === null,
      're-enabling the source restores the newer revocation',
    );
    const late = normalized('source-fallback', { metrics: { observedAt: time(-600) } });
    await append(fallback, late);
    await refresh(103);
    check(
      (await plan(fallback)).source_id === sources[1],
      'historical backfill cannot roll current selection backward',
    );

    const futureEvent = normalized('future-first', { metrics: { observedAt: time(300) } });
    const future = await bootstrap(futureEvent);
    check(
      future.projectId === null,
      'a future first observation cannot establish a current project',
    );
    check(
      (
        await sql`SELECT 1 FROM participation_deferred_observations WHERE raw_item_id=${future.rawId}`
      ).length === 1,
      'future first observation has a durable availability wakeup',
    );
    await tick(299);
    check(
      (await sql`SELECT id FROM projects WHERE asset_key=${futureEvent.project!.assetKey}`)
        .length === 0,
      'wakeups never use future facts early',
    );
    await refresh(301);
    const awakened = (
      await sql`SELECT id FROM projects WHERE asset_key=${futureEvent.project!.assetKey}`
    )[0];
    check(
      awakened,
      'availability wakeup restores the project without an in-memory connector registration',
    );
    check(
      (
        await sql`SELECT 1 FROM participation_deferred_observations WHERE raw_item_id=${future.rawId}`
      ).length === 0,
      'successful availability replay removes the durable deferred input',
    );

    const futureKnown = normalized('future-existing');
    const futureKnownId = (await bootstrap(futureKnown)).projectId!;
    const futureRevocation = normalized('future-existing', {
      conditionsVerified: false,
      metrics: { observedAt: time(400) },
    });
    await append(futureKnownId, futureRevocation, time(500));
    await refresh(350);
    check(
      (await plan(futureKnownId)).evidence_id !==
        (
          await sql`SELECT evidence_id FROM project_metrics WHERE project_id=${futureKnownId} ORDER BY observed_at DESC LIMIT 1`
        )[0]!.evidence_id,
      'future availability cannot overwrite the current projection',
    );
    await refresh(501);
    check(
      (await plan(futureKnownId)).next_check_at === null,
      'future newer revocation is reconsidered when it naturally becomes available',
    );

    const onlyFutureEvent = normalized('future-only-projection');
    const onlyFutureId = (await bootstrap(onlyFutureEvent)).projectId!;
    const onlyFuture = normalized('future-only-projection', {
      sourceId: sources[1]!,
      metrics: { observedAt: time(1000) },
    });
    await append(onlyFutureId, onlyFuture, time(1000));
    await sql`UPDATE data_sources SET enabled=false WHERE id=${sources[0]!}`;
    await refresh(900);
    current = await plan(onlyFutureId);
    check(
      current.observation_snapshot === null &&
        new Date(current.next_check_at as string).toISOString() === time(1000),
      'a project with no current enabled observation retains the future availability schedule',
    );
    await refresh(1001);
    check(
      (await plan(onlyFutureId)).source_id === sources[1] &&
        (await plan(onlyFutureId)).observation_snapshot,
      'future availability refreshes a previously empty projection',
    );
    await sql`UPDATE data_sources SET enabled=true WHERE id=${sources[0]!}`;
    await refresh(1002);

    const missedEvent = normalized('downtime');
    const missed = (await bootstrap(missedEvent)).projectId!;
    await refresh(8000);
    check(
      (await count(missed, 'PARTICIPATION_WINDOW_EXPIRING')) === 0 &&
        (await count(missed, 'PARTICIPATION_WINDOW_EXPIRED')) === 1,
      'recovery across the full window emits expiration without manufacturing a missed warning',
    );
    const expired = (
      await sql`SELECT e.data FROM events e JOIN opportunity_signals s ON s.event_id=e.id WHERE s.project_id=${missed} AND s.data->>'type'='PARTICIPATION_WINDOW_EXPIRED'`
    )[0]!.data;
    check(
      expired.firstSeenAt === time(8000) && expired.detectedAt === time(8000),
      'recovery records the actual processing clock',
    );

    const leasedEvent = normalized('lease');
    const leased = (await bootstrap(leasedEvent)).projectId!;
    await refresh(2);
    const claimed = await claim(leased, 3600);
    check(claimed, 'due work can be durably claimed independently of Redis');
    const wrongMode = await processClaimedPlan({ ...claimed, data_mode: 'live' }, time(3601));
    check(
      wrongMode.stale && (await count(leased, 'PARTICIPATION_WINDOW_EXPIRING')) === 0,
      'a claim from another data mode cannot operate on a Fixture plan',
    );
    const fencedEvent = normalized('lease', {
      conditionsVerified: false,
      metrics: { observedAt: time(40) },
    });
    await append(leased, fencedEvent);
    await refresh(3601);
    const stale = await processClaimedPlan(claimed, time(3602));
    check(
      stale.stale && (await count(leased, 'PARTICIPATION_WINDOW_EXPIRING')) === 0,
      'stale claimed revision cannot emit a signal after new terms revoke it',
    );
    // Abandoned claims are deliberately expired in PostgreSQL, as after a worker
    // crash. No Redis job is required to discover or recover them.
    const recoverEvent = normalized('lease-recovery');
    const recover = (await bootstrap(recoverEvent)).projectId!;
    await refresh(2);
    const abandoned = await claim(recover, 3600);
    check(abandoned, 'crash scenario holds a processing lease');
    await sql`UPDATE participation_window_plans SET locked_until=${time(3601)} WHERE project_id=${recover}`;
    await tick(3602);
    await tick(3603);
    check(
      (await count(recover, 'PARTICIPATION_WINDOW_EXPIRING')) === 1,
      'expired lease is recovered and delivered exactly once',
    );
    await processClaimedPlan(abandoned, time(3604));
    check(
      (await count(recover, 'PARTICIPATION_WINDOW_EXPIRING')) === 1,
      'an old token cannot duplicate or replace a recovered claim',
    );

    const paused = normalized('paused');
    const pausedId = (await bootstrap(paused)).projectId!;
    config.participationSchedulerMode = 'paused';
    await tick(8000);
    check(
      (await count(pausedId, 'PARTICIPATION_WINDOW_EXPIRED')) === 0 &&
        (
          await sql`SELECT 1 FROM participation_refresh_requests WHERE asset_key=${paused.project!.assetKey}`
        ).length === 1,
      'paused mode retains durable work without window side effects',
    );
    config.participationSchedulerMode = 'due';
    await refresh(8001);
    check(
      (await count(pausedId, 'PARTICIPATION_WINDOW_EXPIRED')) === 1,
      'resuming processes the retained durable backlog',
    );
    const cancelled = normalized('cancelled-batch');
    const cancelledId = (await bootstrap(cancelled)).projectId!;
    await refresh(2);
    let stopChecks = 0;
    const cancelledTick = await runParticipationTick({
      at: time(3600),
      shouldStop: () => ++stopChecks >= 3,
    });
    current = await plan(cancelledId);
    check(
      cancelledTick.claimed > 0 &&
        cancelledTick.processed === 0 &&
        current.status === 'WAITING' &&
        current.claim_token === null &&
        current.locked_until === null,
      'shutdown after claiming releases unstarted batch items immediately',
    );
    await tick(3601);
    check(
      (await count(cancelledId, 'PARTICIPATION_WINDOW_EXPIRING')) === 1,
      'released work runs on the next tick without waiting for lease expiry',
    );

    const timed = normalized('preflight-timeout');
    const timedRaw = await raw(timed);
    let unlock: (() => void) | undefined;
    let signalLocked: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const blocker = sql.begin(async (tx) => {
      await tx`LOCK TABLE system_settings IN ACCESS EXCLUSIVE MODE`;
      signalLocked!();
      await held;
    });
    await locked;
    const timeoutStarted = Date.now();
    try {
      await assert.rejects(
        persistEvent(
          connector(timed.sourceId),
          timedRaw.rawId,
          time(-10),
          timedRaw.item,
          time(0),
          Date.now() + 100,
        ),
        (error: unknown) => ['57014', '55P03'].includes(String((error as { code?: string }).code)),
        'ingestion preflight table locks obey the same SQL deadline as project processing',
      );
      checks++;
    } finally {
      unlock!();
      await blocker;
    }
    check(
      Date.now() - timeoutStarted < 1000,
      'a blocked preflight read cannot run past the bounded transaction deadline',
    );
    check(
      (
        await sql`SELECT 1 FROM events WHERE source_id=${timed.sourceId} AND external_id=${timed.externalId}`
      ).length === 0 &&
        (await sql`SELECT 1 FROM projects WHERE asset_key=${timed.project!.assetKey}`).length === 0,
      'preflight timeout leaves no partial event or project facts',
    );
    const bounded = await sql.reserve();
    try {
      const backendPid = Number((await bounded`SELECT pg_backend_pid() AS pid`)[0]!.pid);
      await bounded`CREATE TEMP TABLE radar_sql_deadline_fixture(value integer)`;
      await bounded`BEGIN`;
      let completedSleeps = 0;
      try {
        await assert.rejects(
          withSqlDeadline(bounded as unknown as TransactionSql, Date.now() + 250, async (tx) => {
            await tx`INSERT INTO radar_sql_deadline_fixture VALUES(1)`;
            for (let i = 0; i < 3; i++) {
              await tx`SELECT pg_sleep(0.1)`;
              completedSleeps++;
            }
          }),
          (error: unknown) => (error as { code?: string }).code === '57014',
          'several individually short statements share one absolute deadline',
        );
        checks++;
      } finally {
        // Rollback uses the original connection and is allowed after the budget.
        await bounded`ROLLBACK`;
      }
      check(
        completedSleeps > 0 && completedSleeps < 3,
        'the total SQL budget expires after successful earlier statements',
      );
      check(
        Number((await bounded`SELECT pg_backend_pid() AS pid`)[0]!.pid) === backendPid &&
          Number((await bounded`SELECT count(*)::int n FROM radar_sql_deadline_fixture`)[0]!.n) ===
            0,
        'budget cancellation rolls back all writes and preserves the same backend session',
      );
      await bounded`BEGIN`;
      try {
        await withSqlDeadline(
          bounded as unknown as TransactionSql,
          Date.now() + 1000,
          async (tx) => {
            const fragment = tx`20 + 22`;
            const rows = await tx`SELECT (${fragment})::integer AS answer`.values();
            check(
              rows[0]?.[0] === 42,
              'bounded queries preserve lazy fragments and result modifiers',
            );
            await tx`INSERT INTO radar_sql_deadline_fixture VALUES(2)`;
          },
        );
        await bounded`COMMIT`;
      } catch (error) {
        await bounded`ROLLBACK`;
        throw error;
      }
      check(
        Number((await bounded`SELECT count(*)::int n FROM radar_sql_deadline_fixture`)[0]!.n) ===
          1 && Number((await bounded`SELECT pg_backend_pid() AS pid`)[0]!.pid) === backendPid,
        'a transaction inside the budget commits normally on the preserved session',
      );
    } finally {
      bounded.release();
    }
    config.participationSchedulerMode = 'shadow';
    const shadowEvent = normalized('shadow-switch');
    const shadowId = (await bootstrap(shadowEvent)).projectId!;
    await refresh(8000);
    check(
      (await count(shadowId, 'PARTICIPATION_WINDOW_EXPIRED')) === 0 &&
        (await plan(shadowId)).status === 'IDLE',
      'shadow evaluates and advances plans without emitting business signals',
    );
    config.participationSchedulerMode = 'due';
    await refresh(8001);
    check(
      (await count(shadowId, 'PARTICIPATION_WINDOW_EXPIRED')) === 1,
      'switching shadow to due rebuilds consumed plans and preserves the missed expiration',
    );

    const mutex = await sql.reserve();
    await mutex`SELECT pg_advisory_lock(734862902,hashtext('fixture'))`;
    try {
      const competing = await tick(8002);
      check(
        competing.skipped && competing.claimed === 0 && competing.refreshed === 0,
        'another PostgreSQL session holding the mode mutex prevents a concurrent scheduler replica',
      );
    } finally {
      await mutex`SELECT pg_advisory_unlock(734862902,hashtext('fixture'))`;
      mutex.release();
    }
    check(
      (
        await sql`SELECT count(*)::int n FROM notifications WHERE data->>'dataMode'='fixture' AND status='SENT' AND event_id IN (SELECT id FROM events WHERE source_id=ANY(${sources}::text[]))`
      )[0]!.n === 0,
      'fixture scheduling never claims that a real notification provider accepted a message',
    );
    return { checks, dataMode: 'fixture', sources: sources.length };
  } finally {
    config.participationSchedulerMode = originalMode;
    if (repair)
      await sql`UPDATE participation_repair_state SET cursor=${repair.cursor as string | null},detector_version=${String(repair.detector_version)},next_run_at=${new Date(repair.next_run_at as string).toISOString()} WHERE data_mode='fixture'`;
    else await sql`DELETE FROM participation_repair_state WHERE data_mode='fixture'`;
    await sql.begin(async (tx) => {
      await tx`DELETE FROM outbox_jobs WHERE entity_id IN (SELECT id FROM notifications WHERE event_id IN (SELECT id FROM events WHERE source_id=ANY(${sources}::text[]))) OR entity_id IN (SELECT id FROM events WHERE source_id=ANY(${sources}::text[]))`;
      await tx`DELETE FROM notification_attempts WHERE notification_id IN (SELECT id FROM notifications WHERE event_id IN (SELECT id FROM events WHERE source_id=ANY(${sources}::text[])))`;
      await tx`DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE source_id=ANY(${sources}::text[]))`;
      await tx`DELETE FROM alert_triggers WHERE event_id IN (SELECT id FROM events WHERE source_id=ANY(${sources}::text[]))`;
      await tx`DELETE FROM opportunity_signals WHERE project_id IN (SELECT id FROM projects WHERE asset_key LIKE ${assetPrefix + '%'})`;
      await tx`DELETE FROM risk_assessments WHERE project_id IN (SELECT id FROM projects WHERE asset_key LIKE ${assetPrefix + '%'}) OR event_id IN (SELECT id FROM events WHERE source_id=ANY(${sources}::text[]))`;
      await tx`DELETE FROM project_lifecycle_events WHERE project_id IN (SELECT id FROM projects WHERE asset_key LIKE ${assetPrefix + '%'})`;
      await tx`DELETE FROM participation_window_plans WHERE project_id IN (SELECT id FROM projects WHERE asset_key LIKE ${assetPrefix + '%'})`;
      await tx`DELETE FROM project_metrics WHERE project_id IN (SELECT id FROM projects WHERE asset_key LIKE ${assetPrefix + '%'})`;
      await tx`DELETE FROM projects WHERE asset_key LIKE ${assetPrefix + '%'}`;
      await tx`DELETE FROM ai_analysis_runs WHERE event_id IN (SELECT id FROM events WHERE source_id=ANY(${sources}::text[]))`;
      await tx`DELETE FROM event_sources WHERE source_id=ANY(${sources}::text[])`;
      await tx`DELETE FROM events WHERE source_id=ANY(${sources}::text[])`;
      await tx`DELETE FROM participation_deferred_observations WHERE source_id=ANY(${sources}::text[])`;
      await tx`DELETE FROM raw_items WHERE source_id=ANY(${sources}::text[])`;
      await tx`DELETE FROM participation_source_refreshes WHERE source_id=ANY(${sources}::text[])`;
      await tx`DELETE FROM participation_refresh_requests WHERE asset_key LIKE ${assetPrefix + '%'}`;
      await tx`DELETE FROM data_sources WHERE id=ANY(${sources}::text[])`;
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrate();
    console.log(JSON.stringify(await verifyParticipationScheduler()));
  } finally {
    await closeDatabase();
  }
}
