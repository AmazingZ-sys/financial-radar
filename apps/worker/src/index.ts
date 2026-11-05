import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '@radar/config';
import { sql } from '@radar/database';
import { createLogger } from '@radar/observability';
import { scanXTopics } from './x-topics.js';
import { synchronizeXSchedule } from './x-scheduling.js';
import {
  initializeSources,
  registry,
  runIngestion,
  scanParticipationWindows,
  synchronizeCustomSources,
  synchronizeConfiguredSources,
} from './pipeline.js';
import {
  analyzeEvent,
  sendNotification,
  recoverLeases,
  runOutboxOnce,
  heartbeat,
  DeferredWorkError,
  claimOutboxJobs,
  extendAnalysisOutboxLease,
} from './jobs.js';
const log = createLogger('worker');
export { runIngestion, initializeSources, runOutboxOnce, scanParticipationWindows };
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
redis.on('error', (error) =>
  log.error(
    { message: error.message },
    'Redis connection failure; durable work remains in PostgreSQL',
  ),
);
const queue = new Queue('financial-radar', { connection: redis });
const aiQueue = new Queue('financial-radar-ai', { connection: redis });
let stopping = false;
let reconcileRunning = false;
await initializeSources();
async function scanXTopicsSafely() {
  try {
    await scanXTopics();
  } catch {
    log.warn('X topic scan failed; deterministic alerts continue');
  }
}
async function beat() {
  const [coreCounts, aiCounts] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'failed', 'delayed'),
    aiQueue.getJobCounts('waiting', 'active', 'failed', 'delayed'),
  ]);
  const counts = Object.fromEntries(
    ['waiting', 'active', 'failed', 'delayed'].map((key) => [
      key,
      (coreCounts[key] ?? 0) + (aiCounts[key] ?? 0),
    ]),
  );
  const state = await heartbeat(counts);
  await redis.set('radar:worker:heartbeat', JSON.stringify(state), 'EX', 90);
}
async function enqueueOutboxJob(name: 'ANALYZE' | 'NOTIFY', outboxId: string, entityId: string) {
  // Identical IDs deduplicate transfers of legacy AI jobs and PostgreSQL recovery dispatches.
  await (name === 'ANALYZE' ? aiQueue : queue).add(
    name,
    { outboxId, entityId },
    {
      jobId: `outbox-${outboxId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}
if (process.argv.includes('--once')) {
  try {
    for (const connector of registry.list()) {
      try {
        await runIngestion(connector.metadata.id);
      } catch (error) {
        log.error(
          {
            sourceId: connector.metadata.id,
            error: error instanceof Error ? error.message : 'ingestion error',
          },
          'one-shot ingestion failed',
        );
      }
    }
    await scanParticipationWindows();
    await scanXTopicsSafely();
    await runOutboxOnce();
    await beat();
  } finally {
    await registry.shutdown();
    await queue.close();
    await aiQueue.close();
    await redis.quit();
    await sql.end();
  }
} else {
  async function processOutboxJob(job: Job) {
    try {
      const id = String(job.data.entityId);
      if (job.name === 'NOTIFY') {
        // Shared channel pacing across every worker replica, avoiding independent local rate limits.
        const row = (await sql`SELECT channel_id FROM notifications WHERE id=${id}`)[0];
        if (row && !(await redis.set(`radar:notify-rate:${row.channel_id}`, '1', 'PX', 1100, 'NX')))
          throw new Error('渠道速率限制，稍后重试');
        await sendNotification(id);
      } else if (job.name === 'ANALYZE') {
        await extendAnalysisOutboxLease(String(job.data.outboxId));
        await analyzeEvent(id);
      } else throw new Error('未知 Worker 任务');
      await sql`UPDATE outbox_jobs SET status='COMPLETED',locked_until=null WHERE id=${String(job.data.outboxId)} AND NOT(status='PENDING' AND available_at>now())`;
    } catch (error) {
      if (error instanceof DeferredWorkError) {
        await sql`UPDATE outbox_jobs SET status='PENDING',available_at=${error.retryAt.toISOString()},locked_until=null WHERE id=${String(job.data.outboxId)}`;
        return;
      }
      throw error;
    }
  }
  const worker = new Worker(
    'financial-radar',
    async (job) => {
      if (job.name === 'INGEST') {
        const sourceId = String(job.data.sourceId);
        const token = randomUUID();
        const lock = `radar:source-lock:${sourceId}`;
        if (!(await redis.set(lock, token, 'PX', 120000, 'NX'))) return;
        try {
          await runIngestion(sourceId);
        } finally {
          await redis.eval(
            "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
            1,
            lock,
            token,
          );
        }
        return;
      }
      if (job.name === 'ANALYZE') {
        // Drain jobs created before the dedicated queue existed without holding a core slot
        // for model inference. The AI worker alone completes the durable outbox record.
        await enqueueOutboxJob('ANALYZE', String(job.data.outboxId), String(job.data.entityId));
        return;
      }
      await processOutboxJob(job);
    },
    {
      connection: redis,
      concurrency: 4,
      stalledInterval: 30000,
      maxStalledCount: 2,
      lockDuration: 90000,
    },
  );
  const aiWorker = new Worker('financial-radar-ai', processOutboxJob, {
    connection: redis,
    concurrency: 2,
    stalledInterval: 30000,
    maxStalledCount: 2,
    lockDuration: 90000,
  });
  for (const processor of [worker, aiWorker]) {
    processor.on('failed', async (job, error) => {
      log.error(
        { queue: processor.name, jobId: job?.id, message: error.message },
        'queue job failed',
      );
      if (job?.data.outboxId)
        await sql`UPDATE outbox_jobs SET status='PENDING',attempts=attempts+1,available_at=now()+interval '30 seconds',locked_until=null WHERE id=${String(job.data.outboxId)} AND attempts<5`.catch(
          () => undefined,
        );
    });
    processor.on('error', (error) =>
      log.error({ queue: processor.name, message: error.message }, 'worker queue error'),
    );
  }
  const scheduled = new Map<string, number>();
  async function synchronizeSchedules() {
    await synchronizeConfiguredSources();
    await synchronizeCustomSources();
    const rows =
      await sql`SELECT id,enabled,interval_seconds FROM data_sources WHERE mode=${config.dataMode}`;
    const enabled = new Map(
      rows
        .filter(
          (source) => source.id !== 'x-search' && source.enabled && registry.get(String(source.id)),
        )
        .map((source) => [String(source.id), Number(source.interval_seconds)]),
    );
    for (const entry of await queue.getJobSchedulers()) {
      if (entry.key?.startsWith('source-') && !enabled.has(entry.key.slice(7)))
        await queue.removeJobScheduler(entry.key);
    }
    for (const [id, interval] of enabled) {
      if (scheduled.get(id) === interval) continue;
      await queue.upsertJobScheduler(
        `source-${id}`,
        { every: interval * 1000 },
        {
          name: 'INGEST',
          data: { sourceId: id },
          opts: {
            attempts: id === 'x-search' ? 1 : 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        },
      );
      scheduled.set(id, interval);
    }
    for (const id of scheduled.keys()) if (!enabled.has(id)) scheduled.delete(id);
    await synchronizeXSchedule(queue);
  }
  async function reconcile() {
    if (stopping || reconcileRunning) return;
    reconcileRunning = true;
    try {
      await synchronizeSchedules();
      await recoverLeases();
      await scanParticipationWindows();
      await scanXTopicsSafely();
      const rows = await claimOutboxJobs();
      for (const row of rows) {
        const kind = String(row.kind).toUpperCase();
        const name = ['NOTIFY', 'NOTIFICATION'].includes(kind) ? 'NOTIFY' : 'ANALYZE';
        // Completed jobs are removed so PostgreSQL can redispatch after Redis loss.
        await enqueueOutboxJob(name, String(row.id), String(row.entity_id));
      }
      await beat();
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : 'reconcile failed' },
        'reconciler will retry; no durable facts discarded',
      );
    } finally {
      reconcileRunning = false;
    }
  }
  const timer = setInterval(() => {
    void reconcile();
  }, 15000);
  await reconcile();
  log.info(
    { mode: config.dataMode, sources: registry.list().map((source) => source.metadata.id) },
    'worker started',
  );
  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log.info({ signal }, 'draining worker');
    const force = setTimeout(() => {
      log.error('graceful shutdown timeout');
      process.exit(1);
    }, 30000);
    force.unref();
    await Promise.all([worker.close(), aiWorker.close()]);
    await queue.close();
    await aiQueue.close();
    await registry.shutdown();
    await redis.quit();
    await sql.end();
    clearTimeout(force);
    process.exit(0);
  }
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}
