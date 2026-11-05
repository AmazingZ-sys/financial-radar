import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { config } from '../packages/config/src/index.js';
import {
  sql,
  readXConfig,
  readXConfigView,
  readXPollState,
  saveXConfig,
  reserveXRequest,
  deferXRequestsUntil,
  XRequestDeferredError,
} from '../packages/database/src/index.js';
import type { createApp } from '../apps/api/src/app.js';
import { synchronizeXSchedule } from '../apps/worker/src/x-scheduling.js';

/** Actual PostgreSQL/Redis scheduling checks; synthetic credentials never reach a collector. */
export async function verifyXScheduling(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
) {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('X scheduling integration requires a non-production Fixture database');
  const savedMode = config.dataMode;
  const savedCollectorSecret = config.xCollectorSecret;
  const day = new Date().toISOString().slice(0, 10);
  const usageKey = `x:usage:${day}`;
  const keys = ['integrations:x', 'x:poll-state', 'x:last-test', usageKey];
  const saved = await sql`SELECT key,data FROM system_settings WHERE key=ANY(${keys}::text[])`;
  const savedSource = (await sql`SELECT * FROM data_sources WHERE id='x-search'`)[0];
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  let checks = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    checks++;
  };
  // Resolve the worker's existing dependency without adding a second root dependency.
  type WorkQueue = Parameters<typeof synchronizeXSchedule>[0];
  const { Queue } = createRequire(new URL('../apps/worker/package.json', import.meta.url))(
    'bullmq',
  ) as {
    Queue: new (
      name: string,
      options: {
        connection: {
          host: string;
          port: number;
          db: number;
          username?: string;
          password?: string;
        };
      },
    ) => WorkQueue;
  };
  const redisUrl = new URL(config.redisUrl);
  const queueName = `x-interval-acceptance-${randomUUID()}`;
  const newQueue = () =>
    new Queue(queueName, {
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
        db: Number(redisUrl.pathname.slice(1) || 0),
        ...(redisUrl.username ? { username: decodeURIComponent(redisUrl.username) } : {}),
        ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
      },
    });
  let queue = newQueue();
  const jobs = () => queue.getJobs(['wait', 'delayed', 'active']);
  // Advance only this test's synthetic gate; no wall-clock waiting or network is used.
  const makeDue = async () => {
    await sql`UPDATE system_settings SET data=jsonb_set(data,'{nextRequestAt}',${json(new Date(Date.now() - 1_000).toISOString())}::jsonb) WHERE key='x:poll-state'`;
  };
  try {
    config.xCollectorSecret = 'synthetic-collector-secret-at-least-32-characters';
    await sql`DELETE FROM system_settings WHERE key=ANY(${keys}::text[])`;
    await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES('x-search','Synthetic X scheduling acceptance',true,'live','{}') ON CONFLICT(id) DO UPDATE SET enabled=true,mode='live',data=data_sources.data-'cooldownUntil'`;
    await saveXConfig({
      enabled: true,
      sessionCookies: 'auth_token=synthetic_interval_auth; ct0=synthetic_interval_csrf',
      usernames: ['intervalsample'],
      keywords: [],
      dailyRequestLimit: 500,
    });
    await assert.rejects(() => reserveXRequest());
    checks++;
    check(
      (await readXPollState()).nextRequestAt === null &&
        (await readXConfigView()).usage.requests === 0,
      'Fixture cannot reserve a real request or establish a real polling deadline',
    );

    await sql`UPDATE system_settings SET data=(data-'pollIntervalMinSeconds'-'pollIntervalMaxSeconds') || ${json({ pollIntervalSeconds: 900 })}::jsonb WHERE key='integrations:x'`;
    const legacyStored = JSON.stringify(
      (await sql`SELECT data FROM system_settings WHERE key='integrations:x'`)[0]!.data,
    );
    const legacy = await readXConfig();
    check(
      legacy.pollIntervalMinSeconds === 900 &&
        legacy.pollIntervalMaxSeconds === 1350 &&
        legacy.pollIntervalSeconds === 900,
      'An existing single interval reads as the documented range and retains the compatibility alias',
    );
    check(
      JSON.stringify(
        (await sql`SELECT data FROM system_settings WHERE key='integrations:x'`)[0]!.data,
      ) === legacyStored,
      'Reading legacy settings does not silently rewrite durable configuration',
    );
    await saveXConfig({ pollIntervalSeconds: 75000 });
    check(
      (await readXConfig()).pollIntervalMinSeconds === 75000 &&
        (await readXConfig()).pollIntervalMaxSeconds === 86400,
      'The legacy interval expansion never exceeds the documented daily upper bound',
    );
    await saveXConfig({ pollIntervalSeconds: 1000 });
    check(
      (await readXConfig()).pollIntervalMinSeconds === 1000 &&
        (await readXConfig()).pollIntervalMaxSeconds === 1500,
      'A legacy single-value PATCH converts to its bounded interval',
    );
    await saveXConfig({ pollIntervalMinSeconds: 1100 });
    check(
      (await readXConfig()).pollIntervalMinSeconds === 1100 &&
        (await readXConfig()).pollIntervalMaxSeconds === 1500,
      'A partial range update retains the opposite bound',
    );
    for (const patch of [
      { pollIntervalMinSeconds: 1600 },
      { pollIntervalMaxSeconds: 1000 },
      { pollIntervalSeconds: 600, pollIntervalMaxSeconds: 1200 },
    ]) {
      await assert.rejects(() => saveXConfig(patch));
      checks++;
    }
    check(
      (await readXConfig()).pollIntervalMinSeconds === 1100 &&
        (await readXConfig()).pollIntervalMaxSeconds === 1500,
      'Rejected reversed or mixed writes leave the saved range intact',
    );

    await saveXConfig({ pollIntervalMinSeconds: 300, pollIntervalMaxSeconds: 300 });
    config.dataMode = 'live';
    const beforeGenericPatch = {
      config: await readXConfigView(),
      source: (await sql`SELECT enabled,interval_seconds FROM data_sources WHERE id='x-search'`)[0],
      scheduling: await readXPollState(),
    };
    for (const patch of [
      { intervalSeconds: 600 },
      { enabled: false },
      { enabled: true },
      { enabled: false, intervalSeconds: 600 },
    ]) {
      const response = await app.request('/api/v1/sources/x-search', {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      });
      check(response.status === 400, 'The generic source editor rejects managed X writes');
      check(
        (await response.json()).error.message.includes('系统管理'),
        'The rejected X source write directs the operator to system management',
      );
    }
    check(
      JSON.stringify({
        config: await readXConfigView(),
        source: (
          await sql`SELECT enabled,interval_seconds FROM data_sources WHERE id='x-search'`
        )[0],
        scheduling: await readXPollState(),
      }) === JSON.stringify(beforeGenericPatch),
      'Rejected generic X writes preserve enabled state, configuration, quota, and scheduling',
    );
    check(
      (await reserveXRequest()) === 1,
      'The first enabled request reserves exactly one local quota slot',
    );
    const first = await readXPollState();
    check(
      first.lastDelaySeconds === 300 &&
        Date.parse(first.nextRequestAt!) - Date.parse(first.lastRequestAt!) === 300_000,
      'Equal bounds select the exact allowed delay and persist both request timestamps',
    );
    const manual = await app.request('/api/v1/integrations/x/test', { method: 'POST', headers });
    const manualResult = (await manual.json()).data;
    check(
      manual.status === 200 &&
        manualResult.status === 'skipped' &&
        manualResult.returnedPosts === 0 &&
        manualResult.samples.length === 0 &&
        manualResult.httpStatus === null,
      'A manual connection test respects the worker deadline without calling the collector',
    );
    check(
      (await readXConfigView()).usage.requests === 1 &&
        JSON.stringify(await readXPollState()) === JSON.stringify(first),
      'A deferred manual test consumes no quota and does not redraw the interval',
    );
    await saveXConfig({ pollIntervalMinSeconds: 600, pollIntervalMaxSeconds: 1200 });
    check(
      JSON.stringify(await readXPollState()) === JSON.stringify(first) &&
        (await readXConfigView()).scheduling.nextRequestAt === first.nextRequestAt,
      'Saving a new range and reloading the view preserve the already selected deadline',
    );
    await deferXRequestsUntil(new Date(Date.parse(first.nextRequestAt!) - 60_000).toISOString());
    check(
      (await readXPollState()).nextRequestAt === first.nextRequestAt,
      'A shorter upstream cooldown cannot shorten an existing request deadline',
    );
    const limitedUntil = new Date(Date.parse(first.nextRequestAt!) + 900_000).toISOString();
    await deferXRequestsUntil(limitedUntil);
    const limited = await readXPollState();
    check(
      limited.nextRequestAt === limitedUntil &&
        limited.lastDelaySeconds === first.lastDelaySeconds &&
        limited.lastRequestAt === first.lastRequestAt,
      'A longer upstream cooldown postpones the gate without pretending a new request occurred',
    );
    check(
      new Date(
        (await sql`SELECT next_poll_at FROM data_sources WHERE id='x-search'`)[0]!
          .next_poll_at as string,
      ).toISOString() === limitedUntil,
      'Source status mirrors the durable cooldown deadline',
    );
    await makeDue();
    const current = await readXConfig();
    const raced = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        reserveXRequest(current, { requireEnabled: index % 2 === 0 }),
      ),
    );
    check(
      raced.filter((result) => result.status === 'fulfilled').length === 1 &&
        raced.filter(
          (result) =>
            result.status === 'rejected' && result.reason instanceof XRequestDeferredError,
        ).length === 7 &&
        (await readXConfigView()).usage.requests === 2,
      'Concurrent manual and worker requests share a single durable interval slot across replicas',
    );
    const samples: number[] = [];
    for (let index = 0; index < 32; index++) {
      await makeDue();
      await reserveXRequest();
      const state = await readXPollState();
      assert.equal(
        Date.parse(state.nextRequestAt!) - Date.parse(state.lastRequestAt!),
        state.lastDelaySeconds! * 1000,
      );
      checks++;
      samples.push(state.lastDelaySeconds!);
    }
    check(
      samples.every((delay) => Number.isInteger(delay) && delay >= 600 && delay <= 1200),
      'Every sampled interval uses the configured inclusive integer bounds',
    );
    check(
      new Set(samples).size > 1,
      'Successive reservations draw multiple intervals instead of retaining a fixed schedule',
    );
    const scheduleUntil = new Date(Date.now() + 3_600_000).toISOString();
    await deferXRequestsUntil(scheduleUntil);
    const durableBeforeQueue = await readXPollState();
    await synchronizeXSchedule(queue);
    await synchronizeXSchedule(queue);
    let scheduled = await jobs();
    check(
      scheduled.length === 1 &&
        scheduled[0]!.id === `x-ingest-${Date.parse(scheduleUntil)}` &&
        scheduled[0]!.name === 'INGEST' &&
        scheduled[0]!.opts.attempts === 1,
      'Repeated reconciliation dispatches one delayed job for the same durable deadline',
    );
    check(
      (await queue.getJobSchedulers()).length === 0,
      'X scheduling creates no fixed-period BullMQ scheduler',
    );
    await queue.drain(true);
    await queue.close();
    queue = newQueue();
    await synchronizeXSchedule(queue);
    scheduled = await jobs();
    check(
      scheduled.length === 1 &&
        scheduled[0]!.id === `x-ingest-${Date.parse(scheduleUntil)}` &&
        JSON.stringify(await readXPollState()) === JSON.stringify(durableBeforeQueue),
      'Lost Redis jobs and a new queue instance rebuild the same deadline from PostgreSQL',
    );

    await queue.drain(true);
    await makeDue();
    await sql`UPDATE system_settings SET data=${json({ day, requests: 500 })} WHERE key=${usageKey}`;
    await assert.rejects(() => reserveXRequest());
    checks++;
    check(
      (await readXConfigView()).usage.requests === 500,
      'Exhausted daily quota blocks reservations without incrementing the counter',
    );
    await synchronizeXSchedule(queue);
    const nextDay = new Date();
    nextDay.setUTCHours(24, 0, 0, 0);
    scheduled = await jobs();
    check(
      scheduled.length === 1 &&
        scheduled[0]!.id === `x-ingest-${nextDay.getTime()}` &&
        scheduled[0]!.delay > 0,
      'Exhausted daily quota schedules the next possible request at the UTC day boundary',
    );
    await queue.drain(true);
    await saveXConfig({ enabled: false });
    await synchronizeXSchedule(queue);
    check((await jobs()).length === 0, 'A disabled collector does not dispatch a new delayed job');
    await saveXConfig({ dailyRequestLimit: 0 });
    await synchronizeXSchedule(queue);
    check((await jobs()).length === 0, 'A zero request quota cannot be scheduled');
    await saveXConfig({ dailyRequestLimit: 500, enabled: true });
    config.dataMode = 'fixture';
    await synchronizeXSchedule(queue);
    check((await jobs()).length === 0, 'Fixture mode never schedules the live X collector');
    console.log(
      `X random scheduling integration: ${checks} checks passed; real PostgreSQL/Redis, no X requests`,
    );
    return checks;
  } finally {
    config.dataMode = savedMode;
    config.xCollectorSecret = savedCollectorSecret;
    await queue.obliterate({ force: true });
    await queue.close();
    await sql.begin(async (tx) => {
      await tx`DELETE FROM system_settings WHERE key=ANY(${keys}::text[])`;
      for (const row of saved)
        await tx`INSERT INTO system_settings(key,data) VALUES(${String(row.key)},${json(row.data)})`;
      if (savedSource)
        await tx`UPDATE data_sources SET name=${String(savedSource.name)},enabled=${Boolean(savedSource.enabled)},mode=${String(savedSource.mode)},data=${json(savedSource.data)},next_poll_at=${savedSource.next_poll_at ? new Date(savedSource.next_poll_at as string).toISOString() : null} WHERE id='x-search'`;
      else await tx`DELETE FROM data_sources WHERE id='x-search'`;
    });
  }
}
