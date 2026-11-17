import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from '../packages/config/src/index.js';
import { sql, closeDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';

type ExplainNode = {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: ExplainNode[];
};
type Explain = { Plan: ExplainNode; 'Planning Time': number; 'Execution Time': number };

/** Controlled synthetic Fixture query benchmark; no live ingestion, alerts,
 * backtests, or claims about server CPU savings are produced. */
export async function verifyParticipationScale() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('Participation scale acceptance requires a non-production Fixture database');
  const prefix = `fixture:window-scale:${randomUUID()}:`;
  const sizes = [1000, 10000, 100000];
  const results: {
    projects: number;
    due: number;
    selected: number;
    indexNames: string[];
    sharedHitBlocks: number;
    sharedReadBlocks: number;
    executionMs: number;
    planningMs: number;
  }[] = [];
  let inserted = 0;
  try {
    for (const size of sizes) {
      await sql`INSERT INTO projects(id,asset_key,stage,chain,first_seen_at,data)
        SELECT md5(${prefix} || n::text)::uuid,${prefix} || n::text,'ACTIVE','Fixture','2000-01-01T00:00:00Z'::timestamptz,
          jsonb_build_object('dataMode','fixture','syntheticAcceptance',true)
        FROM generate_series(${inserted + 1}::int,${size}::int) n`;
      await sql`INSERT INTO participation_window_plans(data_mode,project_id,asset_key,revision,detector_version,next_check_at,status)
        SELECT 'fixture',md5(${prefix} || n::text)::uuid,${prefix} || n::text,1,'synthetic-scale-only',
          CASE WHEN n<=50 THEN '1999-12-31T23:59:59Z'::timestamptz ELSE '2099-01-01T00:00:00Z'::timestamptz END,'WAITING'
        FROM generate_series(${inserted + 1}::int,${size}::int) n`;
      inserted = size;
      await sql`ANALYZE participation_window_plans`;
      // This is the scheduler's due lookup, including the production predicates,
      // sort and batch cap. The synthetic clock isolates the 50 due fixtures.
      const explained = await sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT project_id,next_check_at FROM participation_window_plans
        WHERE data_mode='fixture' AND status='WAITING' AND next_check_at<='2000-01-01T00:00:00Z'::timestamptz
        ORDER BY next_check_at,project_id LIMIT 25`;
      const explanation = (explained[0]!['QUERY PLAN'] as Explain[])[0]!;
      const indexes: string[] = [];
      const visit = (node: ExplainNode) => {
        if (node['Index Name']) indexes.push(node['Index Name']);
        node.Plans?.forEach(visit);
      };
      visit(explanation.Plan);
      assert.equal(
        explanation.Plan['Actual Rows'],
        25,
        `${size}: bounded due lookup selects 25 of 50 due plans`,
      );
      assert.ok(
        indexes.includes('participation_due_idx'),
        `${size}: lookup uses the partial due index`,
      );
      results.push({
        projects: size,
        due: 50,
        selected: explanation.Plan['Actual Rows'],
        indexNames: indexes,
        sharedHitBlocks: explanation.Plan['Shared Hit Blocks'] ?? 0,
        sharedReadBlocks: explanation.Plan['Shared Read Blocks'] ?? 0,
        executionMs: explanation['Execution Time'],
        planningMs: explanation['Planning Time'],
      });
    }
    return { dataMode: 'fixture', synthetic: true, results };
  } finally {
    await sql`DELETE FROM participation_window_plans WHERE asset_key LIKE ${prefix + '%'}`;
    await sql`DELETE FROM participation_refresh_requests WHERE asset_key LIKE ${prefix + '%'}`;
    await sql`DELETE FROM projects WHERE asset_key LIKE ${prefix + '%'}`;
    await sql`ANALYZE participation_window_plans`;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrate();
    console.log(JSON.stringify(await verifyParticipationScale()));
  } finally {
    await closeDatabase();
  }
}
