import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '@radar/config';
import { sql } from '@radar/database';
import { createLogger } from '@radar/observability';
import { initializeSources, registry, runIngestion, scanParticipationWindows } from './pipeline.js';
import {
  analyzeEvent,
  sendNotification,
  recoverLeases,
  runOutboxOnce,
  heartbeat,
  DeferredWorkError,
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
let stopping = false;
let reconcileRunning = false;
await initializeSources();
async function beat() {
  const counts = await queue.getJobCounts('waiting', 'active', 'failed', 'delayed');
  const state = await heartbeat(counts);
  await redis.set('radar:worker:heartbeat', JSON.stringify(state), 'EX', 90);
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
    await runOutboxOnce();
    await beat();
  } finally {
    await registry.shutdown();
    await queue.close();
    await redis.quit();
    await sql.end();
  }
} else {
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
      try {
        const id = String(job.data.entityId);
        if (job.name === 'NOTIFY') {
          // Shared channel pacing across every worker replica, avoiding independent local rate limits.
          const row = (await sql`SELECT channel_id FROM notifications WHERE id=${id}`)[0];
          if (
            row &&
            !(await redis.set(`radar:notify-rate:${row.channel_id}`, '1', 'PX', 1100, 'NX'))
          )
            throw new Error('渠道速率限制，稍后重试');
          await sendNotification(id);
        } else if (job.name === 'ANALYZE') await analyzeEvent(id);
        else throw new Error('未知 Worker 任务');
        await sql`UPDATE outbox_jobs SET status='COMPLETED',locked_until=null WHERE id=${String(job.data.outboxId)} AND NOT(status='PENDING' AND available_at>now())`;
      } catch (error) {
        if (error instanceof DeferredWorkError) {
          await sql`UPDATE outbox_jobs SET status='PENDING',available_at=${error.retryAt.toISOString()},locked_until=null WHERE id=${String(job.data.outboxId)}`;
          return;
        }
        throw error;
      }
    },
    {
      connection: redis,
      concurrency: 4,
      stalledInterval: 30000,
      maxStalledCount: 2,
      lockDuration: 90000,
    },
  );
  worker.on('failed', async (job, error) => {
    log.error({ jobId: job?.id, message: error.message }, 'queue job failed');
    if (job?.data.outboxId)
      await sql`UPDATE outbox_jobs SET status='PENDING',attempts=attempts+1,available_at=now()+interval '30 seconds',locked_until=null WHERE id=${String(job.data.outboxId)} AND attempts<5`.catch(
        () => undefined,
      );
  });
  worker.on('error', (error) => log.error({ message: error.message }, 'worker queue error'));
  const scheduled = new Map<string, number>();
  async function synchronizeSchedules() {
    const rows =
      await sql`SELECT id,enabled,interval_seconds FROM data_sources WHERE mode=${config.dataMode}`;
    const enabled = new Map(
      rows
        .filter((source) => source.enabled && registry.get(String(source.id)))
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
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        },
      );
      scheduled.set(id, interval);
    }
    for (const id of scheduled.keys()) if (!enabled.has(id)) scheduled.delete(id);
  }
  async function reconcile() {
    if (stopping || reconcileRunning) return;
    reconcileRunning = true;
    try {
      await synchronizeSchedules();
      await recoverLeases();
      await scanParticipationWindows();
      const rows =
        await sql`UPDATE outbox_jobs SET status='QUEUED',locked_until=now()+interval '2 minutes' WHERE id IN (SELECT id FROM outbox_jobs WHERE status='PENDING' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id,kind,entity_id`;
      for (const row of rows) {
        const kind = String(row.kind).toUpperCase();
        const name = ['NOTIFY', 'NOTIFICATION'].includes(kind) ? 'NOTIFY' : 'ANALYZE';
        // Outbox ID is stable; completed jobs are removed so a recovered lease can be added after Redis loss.
        await queue.add(
          name,
          { outboxId: String(row.id), entityId: String(row.entity_id) },
          {
            jobId: `outbox-${row.id}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
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
    await worker.close();
    await queue.close();
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
