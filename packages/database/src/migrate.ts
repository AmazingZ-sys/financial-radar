import { createHash } from 'node:crypto';
import { readFile, readdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from './index.js';
import { ensureAdmin } from './seed.js';
import { applyOnlineIndexes } from './online-indexes.js';
export async function migrate(): Promise<void> {
  let dir = process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'packages/database/drizzle');
  if (!process.env.MIGRATIONS_DIR) {
    try {
      await access(dir);
    } catch {
      dir = resolve(process.cwd(), 'drizzle');
    }
  }
  const files = (await readdir(dir)).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  if (files.length === 0) throw new Error('No migration files found');
  // A reserved connection keeps the session lock across both transactional and
  // concurrent-index steps. Separate API/Worker startup migrations cannot race.
  const connection = await sql.reserve();
  try {
    await connection`SELECT pg_advisory_lock(734862901)`;
    await connection`CREATE TABLE IF NOT EXISTS _radar_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const name of files) {
      const body = await readFile(resolve(dir, name), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const applied = await connection<
        { checksum: string }[]
      >`SELECT checksum FROM _radar_migrations WHERE name=${name}`;
      if (applied[0]) {
        if (applied[0].checksum !== checksum)
          throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      if (/\b(DROP\s+(TABLE|COLUMN|SCHEMA)|TRUNCATE)\b/i.test(body))
        throw new Error(`Destructive migration requires separate manual procedure: ${name}`);
      if (/^-- radar:nontransactional-indexes\r?\n/.test(body)) {
        await applyOnlineIndexes(connection, body);
        // If the process dies before this ledger write, the next run verifies
        // the existing valid indexes and safely resumes this same migration.
        await connection`INSERT INTO _radar_migrations(name,checksum) VALUES(${name},${checksum})`;
      } else {
        // postgres.js reserve() returns a pinned query interface without the
        // pool's begin() helper at runtime; explicit transactions are safe here.
        await connection`BEGIN`;
        try {
          await connection.unsafe(body);
          await connection`INSERT INTO _radar_migrations(name,checksum) VALUES(${name},${checksum})`;
          await connection`COMMIT`;
        } catch (error) {
          await connection`ROLLBACK`;
          throw error;
        }
      }
    }
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock(734862901)`;
    } finally {
      connection.release();
    }
  }
  await ensureAdmin();
}
