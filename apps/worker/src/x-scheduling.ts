import type { Queue } from 'bullmq';
import { config } from '@radar/config';
import { sql, readXConfigView } from '@radar/database';

/** Redis is a timer only. The durable gate is rechecked before every actual request. */
export async function synchronizeXSchedule(queue: Queue) {
  if (config.dataMode !== 'live') return;
  const settings = await readXConfigView();
  if (!settings.source.enabled || settings.dailyRequestLimit <= 0) return;
  const source = (await sql`SELECT data FROM data_sources WHERE id='x-search' AND mode='live'`)[0];
  const cooldown = source?.data?.cooldownUntil;
  const now = Date.now();
  const nextDay = new Date(now);
  nextDay.setUTCHours(24, 0, 0, 0);
  const candidates = [
    settings.scheduling.nextRequestAt,
    typeof cooldown === 'string' ? cooldown : null,
    settings.usage.remaining === 0 ? nextDay.toISOString() : null,
  ].flatMap((value) => {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? [time] : [];
  });
  const due = Math.max(0, ...candidates);
  const jobId = due > now ? `x-ingest-${due}` : 'x-ingest-ready';
  await queue.add(
    'INGEST',
    { sourceId: 'x-search' },
    {
      jobId,
      delay: Math.max(0, due - now),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}
