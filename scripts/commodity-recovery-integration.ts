import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql } from '../packages/database/src/index.js';
import {
  GoldPriceConnector,
  EiaWtiDailyConnector,
  type RawItem,
} from '../packages/connectors/src/index.js';
import { registry, runIngestion } from '../apps/worker/src/pipeline.js';
import { cleanupFixtureSource } from './evm-pagination-integration.js';

// ZIP with one synthetic PET.RWTC.D row (2026-11-02, USD 60/barrel).
const wtiFixtureZip =
  'UEsDBBQAAAAIAMR5ZF1z7EeVaQAAAHgAAAAHAAAAUEVULnR4dKtWKk4tykwtjs9MUbJSUApwDdELCg9x1nNR0lFQykvMTQWJumVWlJQWpSqEh3iChEvzMkuKQeIu+Tk5iUXFCgWpRQpOiUVFqTkg6TSwFIiVkliSCORERysZGRiZGRoaGAFFzQxiY2u5AFBLAQIUAxQAAAAIAMR5ZF1z7EeVaQAAAHgAAAAHAAAAAAAAAAAAAACAAQAAAABQRVQudHh0UEsFBgAAAAABAAEANQAAAI4AAAAAAA==';

/** Synthetic commodity responses through real PostgreSQL; no external requests. */
export async function verifyCommodityRecovery() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('Commodity recovery integration requires a non-production Fixture database');
  let checks = 0;
  for (const kind of ['gold', 'oil'] as const) {
    const sourceId = `commodity-recovery-fixture-${randomUUID()}`;
    const projectPrefix = `fixture:${sourceId}:`;
    const initialCursor = { fixture: true, previous: 'retained' };
    const syntheticSecret = `synthetic-secret-${randomUUID()}`;
    let failing = true;
    const fetcher: typeof fetch = async () => {
      if (failing) {
        if (kind === 'oil') return new Response('Synthetic rejection', { status: 406 });
        throw new TypeError(`Synthetic failure https://example.invalid/?key=${syntheticSecret}`, {
          cause: Object.assign(new Error(syntheticSecret), { code: 'ENOTFOUND' }),
        });
      }
      if (kind === 'gold')
        return new Response(
          JSON.stringify({ symbol: 'XAU', price: 4000, updatedAt: '2026-11-04T01:00:00Z' }),
        );
      return new Response(Buffer.from(wtiFixtureZip, 'base64'));
    };
    const connector =
      kind === 'gold' ? new GoldPriceConnector(fetcher) : new EiaWtiDailyConnector(fetcher);
    connector.metadata = {
      ...connector.metadata,
      id: sourceId,
      name: `Fixture ${kind} recovery`,
      mode: 'fixture',
    };
    const normalize = connector.normalize.bind(connector);
    connector.normalize = (item: RawItem) => ({
      ...normalize(item),
      sourceId,
      dataMode: 'fixture',
      description: 'Synthetic commodity recovery evidence.',
      originalUrl: `https://example.invalid/fixture/${sourceId}`,
    });
    const check = (condition: unknown, message: string) => {
      assert.ok(condition, message);
      checks++;
    };
    const counts = async () =>
      (
        await sql`SELECT (SELECT count(*)::int FROM raw_items WHERE source_id=${sourceId}) raw,(SELECT count(*)::int FROM market_observations WHERE source_id=${sourceId}) market`
      )[0]!;
    try {
      registry.register(connector);
      await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES(${sourceId},${connector.metadata.name},true,'fixture','{"fixture":true}'::jsonb)`;
      await sql`INSERT INTO source_checkpoints(source_id,cursor) VALUES(${sourceId},${sql.json(initialCursor)})`;
      await assert.rejects(runIngestion(sourceId), kind === 'gold' ? /ENOTFOUND/ : /HTTP 406/);
      checks++;
      assert.deepEqual(
        (await sql`SELECT cursor FROM source_checkpoints WHERE source_id=${sourceId}`)[0]!.cursor,
        initialCursor,
      );
      checks++;
      assert.deepEqual(await counts(), { raw: 0, market: 0 });
      checks++;
      const failed = (
        await sql`SELECT last_error,last_success_at,data FROM data_sources WHERE id=${sourceId}`
      )[0]!;
      check(
        failed.data.status === 'degraded' && failed.last_success_at === null,
        'Failed source is never healthy',
      );
      check(
        !String(failed.last_error).includes(syntheticSecret),
        'Persisted failure excludes synthetic credentials',
      );
      const record = (
        await sql`SELECT error FROM source_health_records WHERE source_id=${sourceId} ORDER BY observed_at DESC LIMIT 1`
      )[0]!;
      check(
        String(record.error).includes(kind === 'gold' ? 'ENOTFOUND' : 'HTTP 406'),
        'Health history retains the actionable cause',
      );
      failing = false;
      await runIngestion(sourceId);
      assert.deepEqual(await counts(), { raw: 1, market: 1 });
      checks++;
      const recovered = (
        await sql`SELECT last_error,last_success_at,data FROM data_sources WHERE id=${sourceId}`
      )[0]!;
      check(
        recovered.data.status === 'healthy' &&
          recovered.last_error === null &&
          !!recovered.last_success_at,
        'A real successful ingestion restores health',
      );
      await runIngestion(sourceId);
      assert.deepEqual(await counts(), { raw: 1, market: 1 });
      checks++;
      check(
        (
          await sql`SELECT id FROM market_observations WHERE source_id=${sourceId} AND data->>'dataMode' IS DISTINCT FROM 'fixture'`
        ).length === 0,
        'Synthetic observations remain explicitly Fixture',
      );
    } finally {
      registry.remove(sourceId);
      await connector.shutdown();
      await sql`DELETE FROM market_observations WHERE source_id=${sourceId}`;
      await cleanupFixtureSource(sourceId, projectPrefix);
    }
  }
  console.log(
    `Commodity recovery integration passed: ${checks} PostgreSQL checks; synthetic responses only.`,
  );
  return { checks };
}
