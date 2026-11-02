import EmbeddedPostgres from 'embedded-postgres';
import { RedisMemoryServer } from 'redis-memory-server';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Real PostgreSQL and Redis processes for development, without requiring Docker.
// These defaults are loopback-only local credentials. Production uses Compose.
const dataDir = resolve('.local/postgres');
const redisDir = resolve('.local/redis');
mkdirSync(redisDir, { recursive: true });
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'radar',
  password: 'radar_dev_only',
  port: 5432,
  persistent: true,
  autoRehydrateSymlinks: true,
  authMethod: 'scram-sha-256',
  onLog: () => {},
  onError: (e: unknown) => process.stderr.write(String(e)),
});
const redis = new RedisMemoryServer({
  instance: { port: 6379, ip: '127.0.0.1', args: ['--appendonly', 'yes', '--dir', redisDir] },
  binary: { version: '7.4.2', downloadDir: resolve('.local/redis-binaries') },
  autoStart: false,
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([pg.stop(), redis.stop()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
try {
  if (!existsSync(resolve(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = 'radar'");
  await client.end();
  if (!result.rowCount) await pg.createDatabase('radar');
  await redis.start();
  console.log(
    'PostgreSQL :5432 and Redis :6379 ready (loopback only). Ctrl-C stops both; .local data is retained.',
  );
  await new Promise<void>(() => {});
} catch (e) {
  console.error('Local services failed:', e instanceof Error ? e.message : 'unknown error');
  await Promise.allSettled([pg.stop(), redis.stop()]);
  process.exit(1);
}
