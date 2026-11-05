import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql, saveAIConfig, readAIConfig } from '../packages/database/src/index.js';
import {
  enqueueAnalysis,
  initialAnalysisState,
  MAX_PENDING_ANALYSES,
  skipAnalysis,
} from '../apps/worker/src/analysis-admission.js';
import {
  analyzeEvent,
  claimOutboxJobs,
  reconcileAnalysisBacklog,
  DeferredWorkError,
} from '../apps/worker/src/jobs.js';

/** Real PostgreSQL admission/recovery checks with explicitly synthetic evidence.
 * Temporarily uses live mode to exercise paid-call guards, but never contacts an AI provider. */
export async function verifyAnalysisCandidates() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('AI candidate integration requires a non-production Fixture database');
  const sourceId = `ai-candidate-synthetic-${randomUUID()}`;
  const savedMode = config.dataMode;
  const savedCalls = config.aiMaxDailyCalls;
  const savedAI = (await sql`SELECT data FROM system_settings WHERE key='integrations:ai'`)[0];
  const noticeId = randomUUID();
  const noticeOutboxId = randomUUID();
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  let checks = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    checks++;
  };
  async function event(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const data: Record<string, unknown> = {
      id,
      sourceId,
      externalId: id,
      title: 'Synthetic AI admission evidence',
      description: 'Integration evidence only; no real opportunity or market observation',
      eventType: 'OFFICIAL_ANNOUNCEMENT',
      dataMode: 'live',
      syntheticTestEvidence: true,
      assets: [],
      categories: ['test'],
      firstSeenAt: now,
      sourcePublishedAt: now,
      confidence: 0.9,
      verificationStatus: 'VERIFIED',
      analysisStatus: 'PENDING',
      ...overrides,
    };
    await sql`INSERT INTO events(id,fingerprint,source_id,external_id,title,event_type,severity,first_seen_at,data) VALUES(${id},${id},${sourceId},${id},${String(data.title)},${String(data.eventType)},'P2',${now},${json(data)})`;
    return data;
  }
  async function legacyOutbox(data: Record<string, unknown>, kind = 'ANALYZE') {
    const id = randomUUID();
    await sql`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id,created_at) VALUES(${id},${id},${kind},${String(data.id)},'2000-01-01')`;
    return id;
  }
  async function stored(data: Record<string, unknown>) {
    return (await sql`SELECT data FROM events WHERE id=${String(data.id)}`)[0]!.data as Record<
      string,
      unknown
    >;
  }
  try {
    await sql`INSERT INTO data_sources(id,name,mode,enabled,data) VALUES(${sourceId},'Synthetic AI candidate guard integration','live',false,'{"syntheticTestEvidence":true}')`;
    config.dataMode = 'live';
    const routine = await event({ eventType: 'PAIR_CREATED' });
    const routineState = await initialAnalysisState(routine);
    check(routineState.analysisStatus === 'SKIPPED', 'A bare new pair is not an AI candidate');
    const routineOutbox = await legacyOutbox(routine);
    await analyzeEvent(String(routine.id));
    check(
      (await stored(routine)).analysisStatus === 'SKIPPED',
      'Legacy Redis consumers reject routine events before loading a provider',
    );
    check(
      (await sql`SELECT status FROM outbox_jobs WHERE id=${routineOutbox}`)[0]?.status ===
        'COMPLETED',
      'A rejected legacy task retires its durable outbox without deleting the fact',
    );
    const stale = await event({
      sourcePublishedAt: new Date(Date.now() - 7_200_000).toISOString(),
    });
    await legacyOutbox(stale, 'ANALYSIS');
    const completed = await event({
      eventType: 'TOKEN_STATE_SNAPSHOT',
      analysisStatus: 'COMPLETED',
      analysis: { summary: 'Preserved synthetic historical result' },
    });
    await legacyOutbox(completed);
    const running = await event({ eventType: 'TOKEN_STATE_SNAPSHOT' });
    const runningOutbox = await legacyOutbox(running);
    const runningRunId = randomUUID();
    await sql`INSERT INTO ai_analysis_runs(id,event_id,status,provider,model,prompt_version,cache_key,data) VALUES(${runningRunId},${String(running.id)},'RUNNING','synthetic-no-transport','synthetic','synthetic',${runningRunId},'{"syntheticTestEvidence":true}')`;
    await reconcileAnalysisBacklog();
    check((await stored(stale)).analysisStatus === 'SKIPPED', 'Expired candidates are retired');
    check(
      (await stored(completed)).analysisStatus === 'COMPLETED' &&
        JSON.stringify((await stored(completed)).analysis) === JSON.stringify(completed.analysis),
      'Backlog cleanup preserves completed historical analysis',
    );
    check(
      (await sql`SELECT status FROM ai_analysis_runs WHERE id=${runningRunId}`)[0]?.status ===
        'RUNNING' &&
        (await sql`SELECT status FROM outbox_jobs WHERE id=${runningOutbox}`)[0]?.status ===
          'PENDING',
      'Cleanup leaves a running call and its outbox intact',
    );
    await sql`UPDATE ai_analysis_runs SET status='FAILED' WHERE id=${runningRunId}`;
    await reconcileAnalysisBacklog();
    check(
      (await stored(running)).analysisStatus === 'SKIPPED',
      'An abandoned routine candidate can be retired after its run is no longer active',
    );

    const sameAsset = await Promise.all(
      Array.from({ length: 4 }, () =>
        event({ chain: 'ethereum', assetKey: `synthetic:${sourceId}:shared` }),
      ),
    );
    await Promise.all(sameAsset.map((data) => sql.begin((tx) => enqueueAnalysis(tx, data))));
    const sameAssetStates = await Promise.all(sameAsset.map(stored));
    check(
      sameAssetStates.filter((data) => data.analysisStatus === 'PENDING').length === 1,
      'Concurrent replicas admit only one candidate per asset cooldown',
    );
    check(
      sameAssetStates.filter((data) => data.analysisStatus === 'SKIPPED').length === 3,
      'Other same-asset candidates retain an explicit skipped state',
    );
    const admitted = sameAssetStates.find((data) => data.analysisStatus === 'PENDING')!;
    const beforeSkip = admitted.analysisDecision as Record<string, unknown>;
    await sql.begin((tx) => skipAnalysis(tx, String(admitted.id), 'SYNTHETIC_BUDGET_SKIP'));
    const afterSkip = (await stored(admitted)).analysisDecision as Record<string, unknown>;
    check(
      afterSkip.admittedAt === beforeSkip.admittedAt &&
        afterSkip.cooldownKey === beforeSkip.cooldownKey,
      'Skipping an admitted candidate preserves its asset admission timestamp and cooldown key',
    );
    const afterSkippedAsset = await event({
      chain: 'ethereum',
      assetKey: `synthetic:${sourceId}:shared`,
    });
    await sql.begin((tx) => enqueueAnalysis(tx, afterSkippedAsset));
    const afterSkippedAssetState = await stored(afterSkippedAsset);
    check(
      afterSkippedAssetState.analysisStatus === 'SKIPPED' &&
        (afterSkippedAssetState.analysisDecision as Record<string, unknown>).reason ===
          'ASSET_COOLDOWN',
      'A skipped admission still prevents another candidate for the same asset within six hours',
    );
    await sql`UPDATE outbox_jobs SET status='COMPLETED' WHERE entity_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;

    const capacity = await Promise.all(
      Array.from({ length: MAX_PENDING_ANALYSES + 5 }, (_, index) =>
        event({ assetKey: `synthetic:${sourceId}:${index}` }),
      ),
    );
    await Promise.all(capacity.map((data) => sql.begin((tx) => enqueueAnalysis(tx, data))));
    const capacityStates = await Promise.all(capacity.map(stored));
    check(
      capacityStates.filter((data) => data.analysisStatus === 'PENDING').length ===
        MAX_PENDING_ANALYSES,
      'Concurrent admission respects the durable candidate capacity',
    );
    check(
      capacityStates.filter((data) => data.analysisStatus === 'SKIPPED').length === 5,
      'Overflow candidates are skipped rather than added to an unbounded backlog',
    );

    for (let index = 0; index < 105; index++) {
      const raw = await event({ eventType: 'TOKEN_STATE_SNAPSHOT' });
      await legacyOutbox(raw, index % 2 ? 'ANALYSIS' : 'ANALYZE');
    }
    const channel = (
      await sql`SELECT id FROM notification_channels ORDER BY created_at LIMIT 1`
    )[0];
    assert.ok(channel, 'Seeded notification channel required');
    await sql`INSERT INTO notifications(id,dedup_key,channel_id,data) VALUES(${noticeId},${noticeId},${String(channel.id)},'{"dataMode":"fixture","syntheticTestEvidence":true}')`;
    await sql`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) VALUES(${noticeOutboxId},${noticeOutboxId},'NOTIFY',${noticeId})`;
    const claimed = await claimOutboxJobs();
    check(
      claimed.some((row) => row.id === noticeOutboxId),
      'More than one hundred older AI jobs cannot starve a new deterministic notification',
    );
    check(
      claimed.filter((row) => ['ANALYZE', 'ANALYSIS'].includes(String(row.kind).toUpperCase()))
        .length <= 2,
      'The first dispatch fills at most two live AI slots',
    );
    const next = await Promise.all([claimOutboxJobs(), claimOutboxJobs()]);
    check(
      next.flat().every((row) => !['ANALYZE', 'ANALYSIS'].includes(String(row.kind).toUpperCase())),
      'Concurrent reconcilers cannot dispatch additional AI work while both slots are queued',
    );
    check(
      Number(
        (
          await sql`SELECT count(*)::int AS count FROM events WHERE source_id=${sourceId} AND event_type='TOKEN_STATE_SNAPSHOT' AND data->>'analysisStatus'='SKIPPED'`
        )[0]!.count,
      ) >= 106,
      'Legacy snapshots are retired in bulk, preserving their stored evidence',
    );
    check(
      (
        await sql`SELECT id FROM ai_analysis_runs WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId}) AND id<>${runningRunId}`
      ).length === 0,
      'All screening and backlog operations above make zero provider calls',
    );

    const budget = await event();
    const rawId = randomUUID();
    await sql`INSERT INTO raw_items(id,source_id,external_id,payload,first_seen_at,collected_at) VALUES(${rawId},${sourceId},${rawId},'{"title":"Synthetic budget evidence","syntheticTestEvidence":true}',now(),now())`;
    await sql`INSERT INTO event_sources(id,event_id,source_id,raw_item_id,url,data) VALUES(${randomUUID()},${String(budget.id)},${sourceId},${rawId},'https://example.invalid/synthetic-budget','{"title":"Synthetic budget evidence"}')`;
    await legacyOutbox(budget);
    await saveAIConfig({
      enabled: true,
      apiKey: 'synthetic-placeholder-not-a-real-key',
      model: 'synthetic-never-called',
      baseUrl: 'https://example.invalid/v1',
      dailyBudgetUsd: 1,
      maxCallCostUsd: 0.1,
      maxDailyCalls: 0,
    });
    config.aiMaxDailyCalls = 0;
    await analyzeEvent(String(budget.id));
    check(
      (await stored(budget)).analysisStatus === 'SKIPPED',
      'Daily call cap zero terminates the candidate without postponing it to tomorrow',
    );
    check(
      (await sql`SELECT id FROM ai_analysis_runs WHERE event_id=${String(budget.id)}`).length === 0,
      'Exhausted budget does not reserve a run or attempt an external request',
    );

    const freshCompleted = await event({
      analysisStatus: 'COMPLETED',
      analysis: { summary: 'Preserve this fresh synthetic completed result' },
    });
    const freshCompletedOutbox = await legacyOutbox(freshCompleted);
    await saveAIConfig({ model: 'synthetic-config-changed-after-completion' });
    const savedEncryptionKey = config.integrationEncryptionKey;
    try {
      config.integrationEncryptionKey = `wrong-synthetic-key-${randomUUID()}`;
      await assert.rejects(() => readAIConfig());
      checks++;
      await analyzeEvent(String(freshCompleted.id));
    } finally {
      config.integrationEncryptionKey = savedEncryptionKey;
    }
    const preservedCompleted = await stored(freshCompleted);
    check(
      preservedCompleted.analysisStatus === 'COMPLETED' &&
        JSON.stringify(preservedCompleted.analysis) === JSON.stringify(freshCompleted.analysis),
      'Fresh completed analysis is preserved even when reading changed provider configuration would fail',
    );
    check(
      (await sql`SELECT id FROM ai_analysis_runs WHERE event_id=${String(freshCompleted.id)}`)
        .length === 0 &&
        (await sql`SELECT status FROM outbox_jobs WHERE id=${freshCompletedOutbox}`)[0]?.status ===
          'COMPLETED',
      'A completed legacy task retires without creating another analysis run',
    );

    const anotherCache = await event();
    await sql`INSERT INTO event_sources(id,event_id,source_id,raw_item_id,url,data) VALUES(${randomUUID()},${String(anotherCache.id)},${sourceId},${rawId},'https://example.invalid/synthetic-running-cache','{"title":"Synthetic running-cache evidence"}')`;
    const anotherCacheRun = randomUUID();
    await sql`INSERT INTO ai_analysis_runs(id,event_id,status,provider,model,prompt_version,cache_key,data) VALUES(${anotherCacheRun},${String(anotherCache.id)},'RUNNING','synthetic-no-transport','synthetic-previous-config','synthetic',${anotherCacheRun},'{"syntheticTestEvidence":true}')`;
    await assert.rejects(
      () => analyzeEvent(String(anotherCache.id)),
      (error: unknown) => error instanceof DeferredWorkError,
    );
    checks++;
    check(
      (await sql`SELECT id FROM ai_analysis_runs WHERE event_id=${String(anotherCache.id)}`)
        .length === 1 && (await stored(anotherCache)).analysisStatus === 'PENDING',
      'A running analysis under a different cache identity prevents a second reservation',
    );

    const raced = await event();
    const racedOutbox = await legacyOutbox(raced);
    const racedRun = randomUUID();
    let releaseReservation!: () => void;
    let signalLock!: () => void;
    let signalCleanupPid!: (pid: number) => void;
    const reservationReleased = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const reservationLocked = new Promise<void>((resolve) => {
      signalLock = resolve;
    });
    const cleanupPidReady = new Promise<number>((resolve) => {
      signalCleanupPid = resolve;
    });
    const reservation = sql.begin(async (tx) => {
      await tx`SELECT id FROM events WHERE id=${String(raced.id)} FOR UPDATE`;
      signalLock();
      await reservationReleased;
      await tx`INSERT INTO ai_analysis_runs(id,event_id,status,provider,model,prompt_version,cache_key,data) VALUES(${racedRun},${String(raced.id)},'RUNNING','synthetic-no-transport','synthetic','synthetic',${racedRun},'{"syntheticTestEvidence":true}')`;
    });
    await reservationLocked;
    const cleanup = sql.begin(async (tx) => {
      const pid = (await tx`SELECT pg_backend_pid()::int AS pid`)[0]!.pid as number;
      signalCleanupPid(pid);
      await skipAnalysis(tx, String(raced.id), 'SYNTHETIC_RACING_CLEANUP');
    });
    try {
      const pid = await cleanupPidReady;
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = Boolean(
          (
            await sql`SELECT pid FROM pg_stat_activity WHERE pid=${pid} AND wait_event_type='Lock'`
          )[0],
        );
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      check(blocked, 'Cleanup waits for the event row held by an uncommitted reservation');
    } finally {
      releaseReservation();
      await reservation;
      await cleanup;
    }
    check(
      (await stored(raced)).analysisStatus === 'PENDING' &&
        (await sql`SELECT status FROM ai_analysis_runs WHERE id=${racedRun}`)[0]?.status ===
          'RUNNING' &&
        (await sql`SELECT status FROM outbox_jobs WHERE id=${racedOutbox}`)[0]?.status ===
          'PENDING',
      'After the reservation commits, cleanup sees its RUNNING call and preserves the event and outbox',
    );
    console.log(`AI candidate admission integration: ${checks} checks passed`);
    return checks;
  } finally {
    config.dataMode = savedMode;
    config.aiMaxDailyCalls = savedCalls;
    await sql.begin(async (tx) => {
      await tx`DELETE FROM outbox_jobs WHERE entity_id IN (SELECT id FROM events WHERE source_id=${sourceId}) OR id=${noticeOutboxId}`;
      await tx`DELETE FROM notifications WHERE id=${noticeId}`;
      await tx`DELETE FROM ai_analysis_runs WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM event_sources WHERE source_id=${sourceId}`;
      await tx`DELETE FROM events WHERE source_id=${sourceId}`;
      await tx`DELETE FROM raw_items WHERE source_id=${sourceId}`;
      await tx`DELETE FROM data_sources WHERE id=${sourceId}`;
      if (savedAI)
        await tx`INSERT INTO system_settings(key,data) VALUES('integrations:ai',${json(savedAI.data)}) ON CONFLICT(key) DO UPDATE SET data=excluded.data`;
      else await tx`DELETE FROM system_settings WHERE key='integrations:ai'`;
    });
  }
}
