import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql } from '../packages/database/src/index.js';
import { SolanaMintConnector, type RawItem } from '../packages/connectors/src/index.js';
import { ResilientHttp } from '../packages/connectors/src/http.js';
import { registry, runIngestion } from '../apps/worker/src/pipeline.js';
import { cleanupFixtureSource } from './evm-pagination-integration.js';

function signature(index: number) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = index;
  let encoded = '';
  do {
    encoded = alphabet[value % 58] + encoded;
    value = Math.floor(value / 58);
  } while (value);
  return encoded.padStart(64, '1');
}
/** Real PostgreSQL recovery evidence. All RPC data is synthetic and explicitly Fixture. */
export async function verifySolanaHistoryRecovery() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error(
      'Solana history recovery integration requires a non-production Fixture database',
    );
  const sourceId = `solana-recovery-fixture-${randomUUID()}`;
  const projectPrefix = `fixture:${sourceId}:`;
  const initialCursor = { signature: signature(0), slot: 0 };
  const entries = Array.from({ length: 126 }, (_, i) => ({
    signature: signature(125 - i),
    slot: 125 - i,
    err: null,
    blockTime: null,
  }));
  const transactionRequests: number[] = [];
  const mintSlots = new Set([1, 25, 26, 125]);
  let failAt: number | undefined = 3;
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let result: unknown;
    if (request.method === 'getSignaturesForAddress') {
      const options = request.params[1] as { before?: string; limit: number; commitment: string };
      assert.equal(options.commitment, 'finalized');
      const start = options.before
        ? entries.findIndex((entry) => entry.signature === options.before) + 1
        : 0;
      result = entries.slice(start, start + options.limit);
    } else if (request.method === 'getTransaction') {
      const slot = entries.find((entry) => entry.signature === request.params[0])!.slot;
      transactionRequests.push(slot);
      result =
        slot === failAt
          ? null
          : {
              slot,
              version: 1,
              blockTime: null,
              meta: { err: null, innerInstructions: [] },
              transaction: {
                message: {
                  instructions: mintSlots.has(slot)
                    ? [
                        {
                          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                          parsed: {
                            type: 'initializeMint2',
                            info: { mint: signature(slot).slice(-32) },
                          },
                        },
                      ]
                    : [],
                },
              },
            };
    } else throw new Error('Unexpected synthetic RPC method');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  class FixtureSolanaConnector extends SolanaMintConnector {
    constructor() {
      super('https://example.invalid/fixture-rpc', '1'.repeat(32), fetcher);
      // The entire fetcher is synthetic; no external source is contacted or rate limit bypassed.
      this.http = new ResilientHttp(fetcher, undefined, undefined, 0);
      this.metadata = {
        ...this.metadata,
        id: sourceId,
        name: 'Fixture Solana history recovery',
        mode: 'fixture',
        licenseStatus: 'internal-research-only',
      };
    }
    override normalize(item: RawItem) {
      const event = super.normalize(item);
      const assetKey = projectPrefix + event.assetKey;
      return {
        ...event,
        assetKey,
        project: event.project ? { ...event.project, assetKey } : undefined,
        title: 'Fixture Solana history recovery evidence',
        description: 'Synthetic RPC evidence; no external chain data fetched.',
        originalUrl: `https://example.invalid/fixture/${sourceId}/${item.externalId}`,
        dataMode: 'fixture' as const,
      };
    }
  }
  let connector = new FixtureSolanaConnector();
  let checks = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    checks++;
  };
  const checkpoint = async () =>
    (await sql`SELECT cursor FROM source_checkpoints WHERE source_id=${sourceId}`)[0]!
      .cursor as Record<string, unknown>;
  const health = async () =>
    (await sql`SELECT last_success_at,last_error,data FROM data_sources WHERE id=${sourceId}`)[0]!;
  try {
    registry.register(connector);
    await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES(${sourceId},'Fixture Solana history recovery',true,'fixture','{"fixture":true}'::jsonb)`;
    await sql`INSERT INTO source_checkpoints(source_id,cursor) VALUES(${sourceId},${sql.json(initialCursor)})`;
    const scan = await runIngestion(sourceId);
    check(
      scan.fetched === 0 && scan.inserted === 0,
      'Scanning signatures creates no invented events',
    );
    const scannedCursor = await checkpoint();
    check(
      scannedCursor.signature === initialCursor.signature && !!scannedCursor.solanaRecovery,
      'Canonical signature stays fixed while scan progress is durable',
    );
    const scanningHealth = await health();
    check(
      scanningHealth.data.status === 'degraded' &&
        scanningHealth.last_success_at === null &&
        String(scanningHealth.last_error).includes('补偿'),
      'History scanning never claims full source health',
    );
    check(
      transactionRequests.length === 0,
      'No transactions are processed before the previous checkpoint is found',
    );

    registry.remove(sourceId);
    connector = new FixtureSolanaConnector();
    registry.register(connector);
    await assert.rejects(runIngestion(sourceId), /历史暂不可得/);
    checks++;
    assert.deepEqual(
      await checkpoint(),
      scannedCursor,
      'A later transaction failure preserves the entire persisted scan cursor',
    );
    checks++;
    check(
      (await sql`SELECT id FROM raw_items WHERE source_id=${sourceId}`).length === 0,
      'Failed fetched batch commits no partial raw events',
    );
    assert.deepEqual(
      transactionRequests,
      [1, 2, 3],
      'Restart resumes with the oldest missing transactions',
    );
    checks++;

    failAt = undefined;
    transactionRequests.length = 0;
    const replay = await runIngestion(sourceId);
    check(
      replay.fetched === 1 && replay.inserted === 1,
      'The first mint event passes through the real ingestion pipeline',
    );
    check(
      (await checkpoint()).signature === signature(20),
      'Canonical cursor advances to the last fully persisted contiguous transaction',
    );
    check(
      (await health()).data.status === 'degraded',
      'Partial replay continues to advertise recovery',
    );
    let rounds = 0;
    while ((await checkpoint()).solanaRecovery && rounds++ < 20) {
      const before = transactionRequests.length;
      await runIngestion(sourceId);
      check(
        transactionRequests.length - before <= 20,
        'Each recovery poll has a bounded transaction budget',
      );
    }
    check(rounds < 20, 'The bounded recovery completes');
    assert.deepEqual(
      transactionRequests,
      Array.from({ length: 125 }, (_, i) => i + 1),
      'Every missing transaction is processed once in contiguous chronological order',
    );
    checks++;
    check(
      (await checkpoint()).signature === signature(125),
      'Final checkpoint reaches the frozen recovery head',
    );
    const recoveredHealth = await health();
    check(
      recoveredHealth.data.status === 'healthy' &&
        !!recoveredHealth.last_success_at &&
        recoveredHealth.last_error === null,
      'Health returns only after recovery completes',
    );
    const facts = (
      await sql`SELECT (SELECT count(*)::int FROM raw_items WHERE source_id=${sourceId}) AS raw,(SELECT count(*)::int FROM events WHERE source_id=${sourceId}) AS events`
    )[0]!;
    check(
      facts.raw === 4 && facts.events === 4,
      'All four synthetic mint events have durable evidence',
    );
    check(
      (
        await sql`SELECT id FROM events WHERE source_id=${sourceId} AND data->>'dataMode' IS DISTINCT FROM 'fixture'`
      ).length === 0,
      'Synthetic recovery evidence always stays Fixture',
    );

    await sql`UPDATE source_checkpoints SET cursor=${sql.json(initialCursor)} WHERE source_id=${sourceId}`;
    rounds = 0;
    do {
      await runIngestion(sourceId);
    } while ((await checkpoint()).solanaRecovery && rounds++ < 20);
    check(rounds < 20, 'Replay completes within the same bound');
    const replayFacts = (
      await sql`SELECT (SELECT count(*)::int FROM raw_items WHERE source_id=${sourceId}) AS raw,(SELECT count(*)::int FROM events WHERE source_id=${sourceId}) AS events`
    )[0]!;
    assert.deepEqual(
      replayFacts,
      facts,
      'History replay does not duplicate raw evidence or events',
    );
    checks++;
    console.log(
      `Solana history recovery integration passed: ${checks} PostgreSQL checks; synthetic RPC only.`,
    );
    return { checks };
  } finally {
    registry.remove(sourceId);
    await connector.shutdown();
    await cleanupFixtureSource(sourceId, projectPrefix);
  }
}
