import { Redis } from 'ioredis';
import { config } from '@radar/config';
const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  retryStrategy: () => null,
});
redis.on('error', () => undefined);
try {
  const raw = await redis.get('radar:worker:heartbeat');
  const heartbeat = raw
    ? (JSON.parse(raw) as { timestamp: string; version: string; mode: string; commitSha: string })
    : null;
  const age = heartbeat ? Date.now() - Date.parse(heartbeat.timestamp) : Infinity;
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > 90000 ||
    heartbeat?.version !== config.version ||
    heartbeat?.mode !== config.dataMode ||
    heartbeat?.commitSha !== config.commitSha
  )
    throw new Error('Worker heartbeat stale, missing or belongs to another version/mode/commit');
  process.stdout.write(`healthy: heartbeat ${Math.round(age / 1000)}s ago\n`);
} catch {
  process.exitCode = 1;
  process.stderr.write(
    'unhealthy: worker heartbeat missing/stale/version mismatch or Redis unavailable\n',
  );
} finally {
  redis.disconnect();
}
