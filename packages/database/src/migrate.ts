import { createHash } from 'node:crypto';
import { readFile, readdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from './index.js';
import { ensureAdmin } from './seed.js';
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
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(734862901)`;
    await tx`CREATE TABLE IF NOT EXISTS _radar_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const name of files) {
      const body = await readFile(resolve(dir, name), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const applied = await tx<
        { checksum: string }[]
      >`SELECT checksum FROM _radar_migrations WHERE name=${name}`;
      if (applied[0]) {
        if (applied[0].checksum !== checksum)
          throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      if (/\b(DROP\s+(TABLE|COLUMN|SCHEMA)|TRUNCATE)\b/i.test(body))
        throw new Error(`Destructive migration requires separate manual procedure: ${name}`);
      await tx.unsafe(body);
      await tx`INSERT INTO _radar_migrations(name,checksum) VALUES(${name},${checksum})`;
    }
  });
  await ensureAdmin();
}
