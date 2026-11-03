import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { RedisMemoryServer } from 'redis-memory-server';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const folder = await mkdtemp(resolve(tmpdir(), 'radar-recovery-'));
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
const pgPort = await freePort();
const redisPort = await freePort();
const redisDir = resolve(folder, 'redis');
await mkdir(redisDir);
const pg = new EmbeddedPostgres({
  databaseDir: resolve(folder, 'pg'),
  user: 'radar_drill',
  password: 'local_drill_password_only',
  port: pgPort,
  persistent: true,
  authMethod: 'scram-sha-256',
  onLog: () => {},
  onError: () => {},
});
const redisServer = new RedisMemoryServer({
  instance: {
    port: redisPort,
    ip: '127.0.0.1',
    args: ['--appendonly', 'yes', '--appendfsync', 'always', '--dir', redisDir],
  },
  binary: { version: '7.4.2', downloadDir: resolve(root, '.local/redis-binaries') },
  autoStart: false,
});
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: `postgresql://radar_drill:local_drill_password_only@127.0.0.1:${pgPort}/radar_drill`,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  DATA_MODE: 'fixture',
  LOG_LEVEL: 'silent',
  MIGRATIONS_DIR: resolve(root, 'packages/database/drizzle'),
});
const results: { name: string; passed: boolean; detail: string; at: string }[] = [];
const record = (name: string, detail: string) => {
  results.push({ name, passed: true, detail, at: new Date().toISOString() });
  process.stdout.write(`PASS ${name}: ${detail}\n`);
};
let child: ChildProcess | undefined;
let closeDatabase: (() => Promise<void>) | undefined;
let apiRedis: { disconnect(): void } | undefined;
async function waitFor(check: () => Promise<boolean>, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待恢复超时${last instanceof Error ? ': ' + last.message : ''}`);
}
async function runOnce() {
  await new Promise<void>((resolvePromise, reject) => {
    const processChild = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/worker/src/index.ts', '--once'],
      { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let errors = '';
    processChild.stderr?.on('data', (data: Buffer) => {
      errors += data.toString();
    });
    const timer = setTimeout(() => {
      processChild.kill('SIGKILL');
      reject(new Error('worker once timed out'));
    }, 40000);
    processChild.on('error', reject);
    processChild.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`worker once exit ${code}: ${errors.slice(0, 500)}`));
    });
  });
}
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('radar_drill');
  await redisServer.start();
  // Import config/database/API only after isolated URLs have been injected.
  const database = await import('../../../packages/database/src/index.js');
  closeDatabase = database.closeDatabase;
  const { migrate } = await import('../../../packages/database/src/migrate.js');
  await migrate();
  const { createApp } = await import('../../api/src/app.js');
  const security = await import('../../api/src/security.js');
  apiRedis = security.redis;
  const app = createApp();
  const ready = async () => (await app.request('http://localhost/ready')).status;
  assert.equal(await ready(), 200);
  await runOnce();
  const counts = async () => {
    const rows =
      await database.sql`SELECT (SELECT count(*)::int FROM raw_items) AS raw,(SELECT count(*)::int FROM events) AS events,(SELECT count(*)::int FROM projects) AS projects,(SELECT count(*)::int FROM opportunity_signals) AS signals,(SELECT count(*)::int FROM notifications) AS notifications`;
    return rows[0]!;
  };
  const baseline = await counts();
  assert.equal(Number(baseline.raw), 5);
  // The fixed Fixture participation window can expire as wall time advances.
  // Keep checking every original event, while accounting only for explicit clock signals.
  const clockEvents = (
    await database.sql`SELECT count(*)::int AS n FROM events WHERE event_type IN ('PARTICIPATION_WINDOW_EXPIRING','PARTICIPATION_WINDOW_EXPIRED') AND external_id LIKE 'history:%'`
  )[0]!.n;
  assert.equal(Number(baseline.events), 5 + Number(clockEvents));
  record(
    'baseline',
    `独立PG:${pgPort}/Redis:${redisPort}；raw=5 events=${baseline.events}（窗口时钟信号${clockEvents}） projects=${baseline.projects} signals=${baseline.signals}`,
  );

  await redisServer.stop();
  await waitFor(async () => (await ready()) === 503, 10000);
  record('Redis stopped', '真实Redis进程停止后API /ready=503；PostgreSQL事实仍保留');
  await redisServer.start();
  await waitFor(async () => (await ready()) === 200, 10000);
  assert.deepEqual(await counts(), baseline);
  record('Redis restarted', '同一隔离端口重新启动，/ready恢复200，事实计数不变');

  await pg.stop();
  await waitFor(async () => (await ready()) === 503, 15000);
  record('PostgreSQL stopped', '真实PG进程停止，API /ready=503');
  await pg.start();
  await waitFor(async () => (await ready()) === 200, 15000);
  assert.deepEqual(await counts(), baseline);
  record('PostgreSQL restarted', '同一数据目录重新启动，/ready=200，原始项和事件全部保留');

  child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/index.ts'], {
    cwd: root,
    env: process.env,
    stdio: 'ignore',
  });
  const childPid = child.pid;
  assert(childPid);
  await waitFor(async () => {
    const heartbeat = (
      await database.sql`SELECT data FROM system_settings WHERE key='worker:heartbeat'`
    )[0];
    return (heartbeat?.data as { pid?: number } | undefined)?.pid === childPid;
  });
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  child = undefined;
  record('Worker killed', '真实Worker建立心跳后SIGKILL，随后使用同一DB与Redis恢复');
  const notification = (
    await database.sql`SELECT id FROM notifications ORDER BY queued_at LIMIT 1`
  )[0];
  assert(notification);
  await database.sql`UPDATE notifications SET status='SENDING',locked_until=now()-interval '1 minute',next_attempt_at=now()-interval '1 minute' WHERE id=${String(notification.id)}`;
  await database.sql`UPDATE outbox_jobs SET status='QUEUED',locked_until=now()-interval '1 minute' WHERE entity_id=${String(notification.id)}`;
  await runOnce();
  assert.deepEqual(await counts(), baseline);
  const recovered = (
    await database.sql`SELECT status,attempts FROM notifications WHERE id=${String(notification.id)}`
  )[0]!;
  assert.equal(recovered.status, 'CANCELLED');
  assert(Number(recovered.attempts) >= 2);
  const duplicate =
    await database.sql`SELECT dedup_key FROM notifications GROUP BY dedup_key HAVING count(*)>1`;
  assert.equal(duplicate.length, 0);
  record(
    'Lease recovery + dedup',
    '过期SENDING/QUEUED租约已补偿；Fixture通知CANCELLED未外发，事实数量及通知唯一键不重复',
  );
  const { initializeSources, registry, runIngestion } = await import('../src/pipeline.js');
  await initializeSources();
  const source = registry.get('chain-fixture');
  assert(source);
  const originalFetch = source.fetch.bind(source);
  let calls = 0;
  source.fetch = async (...args) => {
    calls++;
    return originalFetch(...args);
  };
  await database.sql`UPDATE data_sources SET data=data || jsonb_build_object('cooldownUntil',(now()+interval '1 hour')::text) WHERE id='chain-fixture'`;
  const cooldown = await runIngestion('chain-fixture');
  assert.equal(cooldown.skipped, true);
  assert.equal(calls, 0);
  source.fetch = originalFetch;
  record('Persisted cooldown', 'DB中远端限流冷却未到时，重启后的采集跳过且没有发起HTTP请求');
  await registry.shutdown();
  const report = {
    date: '2026-11-02',
    runAt: new Date().toISOString(),
    scope:
      'isolated real PostgreSQL/Redis process restart + worker SIGKILL and expired lease recovery',
    results,
    limitations: [
      '未使用Docker：本机Docker daemon不可用。',
      '没有真实IM/LLM凭据：不证明第三方服务实际送达或计费。',
      'SENDING租约过期用数据库构造；SIGKILL未精确发生在远端消息接受与本地commit之间。',
      'AI不可用与规则仍工作由已有隔离集成和单测覆盖，本脚本不伪造真实LLM故障。',
    ],
  };
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(
    resolve(root, '.local/recovery-latest.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(
    `Recovery drill passed (${results.length} checks). Isolated services cleaned up.\n`,
  );
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(
    `Recovery drill failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
  );
} finally {
  if (child?.pid) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (child!.exitCode !== null || child!.signalCode !== null) resolve();
      else child!.once('exit', () => resolve());
    });
  }
  apiRedis?.disconnect();
  if (closeDatabase) await closeDatabase();
  await Promise.allSettled([pg.stop(), redisServer.stop()]);
  await rm(folder, { recursive: true, force: true });
}
