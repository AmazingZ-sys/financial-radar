import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

// This script always creates its own disposable local PostgreSQL database. It
// never migrates DATABASE_URL supplied by a deployment or a developer's shell.
if (process.env.NODE_ENV === 'production' || process.env.DATA_MODE !== 'fixture')
  throw new Error(
    'Migration acceptance requires explicit DATA_MODE=fixture and non-production NODE_ENV',
  );

const workDir = await mkdtemp(join(tmpdir(), 'radar-participation-migrations-'));
const portServer = createServer();
await new Promise<void>((done, reject) => {
  portServer.once('error', reject);
  portServer.listen(0, '127.0.0.1', done);
});
const address = portServer.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((done, reject) =>
  portServer.close((error) => (error ? reject(error) : done())),
);
const pg = new EmbeddedPostgres({
  databaseDir: join(workDir, 'postgres'),
  user: 'radar',
  password: 'migration_fixture_only',
  port,
  persistent: false,
  authMethod: 'scram-sha-256',
  onLog: () => {},
  onError: (error: unknown) => process.stderr.write(String(error)),
});
let closeDatabase: (() => Promise<void>) | undefined;
let checks = 0;
const check = (value: unknown, message: string) => {
  assert.ok(value, message);
  checks++;
};
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('participation_migration_fixture');
  process.env.DATABASE_URL = `postgresql://radar:migration_fixture_only@127.0.0.1:${port}/participation_migration_fixture`;
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_EMAIL = 'migration-fixture@radar.local';
  process.env.ADMIN_PASSWORD = 'migration-fixture-only-password';
  const original = resolve('packages/database/drizzle');
  const baseline = await mkdtemp(join(workDir, 'baseline-'));
  for (const file of [
    '0001_initial.sql',
    '0002_economic_calendar.sql',
    '0003_source_pending_batches.sql',
  ])
    await copyFile(join(original, file), join(baseline, file));
  process.env.MIGRATIONS_DIR = baseline;
  const { migrate } = await import('../packages/database/src/migrate.js');
  const database = await import('../packages/database/src/index.js');
  const { sql } = database;
  closeDatabase = database.closeDatabase;
  const { applyOnlineIndexes } = await import('../packages/database/src/online-indexes.js');
  await migrate();
  const projectId = randomUUID();
  const rawId = randomUUID();
  await sql`INSERT INTO data_sources(id,name,mode) VALUES('migration-fixture','Migration fixture','fixture')`;
  await sql`INSERT INTO projects(id,asset_key,stage,chain,first_seen_at,data) VALUES(${projectId},'fixture:migration','ACTIVE','Fixture',now(),'{"dataMode":"fixture"}'::jsonb)`;
  await sql`INSERT INTO raw_items(id,source_id,external_id,payload,first_seen_at,collected_at) VALUES(${rawId},'migration-fixture','raw','{}',now(),now())`;
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  const goodId = randomUUID();
  const badId = randomUUID();
  const badTimeId = randomUUID();
  const missingId = randomUUID();
  await sql`INSERT INTO project_metrics(id,project_id,source_id,observed_at,data) VALUES
    (${goodId},${projectId},'migration-fixture',now()-interval '4 seconds',${json({ evidenceId: rawId, availableAt: '2026-11-16T00:00:00.000Z' })}),
    (${badId},${projectId},'migration-fixture',now()-interval '3 seconds',${json({ evidenceId: 'not-a-uuid', availableAt: 'nonsense' })}),
    (${badTimeId},${projectId},'migration-fixture',now()-interval '2 seconds',${json({ evidenceId: rawId, availableAt: '2026-99-99' })}),
    (${missingId},${projectId},'migration-fixture',now()-interval '1 second',${json({ evidenceId: randomUUID() })})`;
  process.env.MIGRATIONS_DIR = original;
  await migrate();
  await migrate();
  const rows =
    await sql`SELECT id,evidence_id,available_at FROM project_metrics ORDER BY observed_at`;
  check(
    rows[0]!.evidence_id === rawId && rows[0]!.available_at,
    'upgrade backfills valid legacy evidence and available time',
  );
  check(
    rows[1]!.evidence_id === null && rows[3]!.evidence_id === null,
    'invalid and absent UUID references remain isolated',
  );
  check(
    rows[2]!.available_at === null,
    'malformed available time does not abort upgrade or become known evidence',
  );
  check(
    (
      await sql`SELECT count(*)::int n FROM pg_index WHERE indexrelid IN ('project_metrics_latest_participation'::regclass,'project_metrics_participation_source'::regclass) AND indisvalid AND indisready`
    )[0]!.n === 2,
    'online indexes are valid after repeat migration',
  );
  await sql`UPDATE data_sources SET enabled=false WHERE id='migration-fixture'`;
  check(
    (
      await sql`SELECT count(*)::int n FROM participation_source_refreshes WHERE source_id='migration-fixture'`
    )[0]!.n === 1,
    'source toggle writes a durable refresh in the same transaction',
  );
  const inserted = randomUUID();
  await sql`INSERT INTO project_metrics(id,project_id,source_id,observed_at,data) VALUES(${inserted},${projectId},'migration-fixture',now(),${json({ evidenceId: rawId, availableAt: '2026-11-16T00:00:00.000Z' })})`;
  check(
    (await sql`SELECT evidence_id FROM project_metrics WHERE id=${inserted}`)[0]!.evidence_id ===
      rawId,
    'old JSON-only writers populate typed evidence through compatibility trigger',
  );
  check(
    (
      await sql`SELECT count(*)::int n FROM participation_refresh_requests WHERE asset_key='fixture:migration'`
    )[0]!.n === 1,
    'metric changes coalesce into one durable project refresh',
  );
  const connection = await sql.reserve();
  try {
    await connection`CREATE TABLE migration_index_fixture(id integer)`;
    await connection`INSERT INTO migration_index_fixture VALUES(1),(1)`;
    const body =
      'CREATE UNIQUE INDEX CONCURRENTLY migration_index_recovery ON migration_index_fixture(id);';
    await assert.rejects(() => applyOnlineIndexes(connection, body));
    check(
      (
        await connection`SELECT i.indisvalid valid FROM pg_index i WHERE i.indexrelid='migration_index_recovery'::regclass`
      )[0]!.valid === false,
      'failed concurrent build leaves a recoverable invalid index',
    );
    await connection`DELETE FROM migration_index_fixture WHERE ctid=(SELECT ctid FROM migration_index_fixture LIMIT 1)`;
    await applyOnlineIndexes(connection, body);
    await applyOnlineIndexes(connection, body);
    check(
      (
        await connection`SELECT i.indisvalid valid FROM pg_index i WHERE i.indexrelid='migration_index_recovery'::regclass`
      )[0]!.valid === true,
      'rerun repairs the exact invalid migration index and is idempotent',
    );
    await assert.rejects(
      () =>
        applyOnlineIndexes(
          connection,
          'CREATE INDEX CONCURRENTLY migration_index_recovery ON migration_index_fixture(id);',
        ),
      /definition mismatch/,
    );
    checks++;
  } finally {
    connection.release();
  }
  await Promise.all([migrate(), migrate()]);
  check(
    (await sql`SELECT count(*)::int n FROM _radar_migrations`)[0]!.n >= 5,
    'concurrent API/Worker migrations serialize without duplicate application',
  );
  console.log(
    JSON.stringify({
      checks,
      dataMode: 'fixture',
      database: 'disposable local PostgreSQL',
      migrations: 'passed',
      invalidIndexRecovery: 'passed',
    }),
  );
} finally {
  try {
    await closeDatabase?.();
  } finally {
    try {
      await pg.stop();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
