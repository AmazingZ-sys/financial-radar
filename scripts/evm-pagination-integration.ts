import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql } from '../packages/database/src/index.js';
import {
  EvmFactoryConnector,
  SolanaMintConnector,
  ConnectorError,
  PAIR_CREATED_TOPIC,
  type RawItem,
} from '../packages/connectors/src/index.js';
import { registry, runIngestion } from '../apps/worker/src/pipeline.js';

async function cleanupFixtureSource(sourceId: string, projectPrefix: string) {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM outbox_jobs WHERE entity_id IN (SELECT id FROM notifications WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})) OR entity_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
    await tx`DELETE FROM notification_attempts WHERE notification_id IN (SELECT id FROM notifications WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId}))`;
    await tx`DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
    await tx`DELETE FROM alert_triggers WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
    await tx`DELETE FROM opportunity_signals WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
    await tx`DELETE FROM risk_assessments WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
    await tx`DELETE FROM project_lifecycle_events WHERE project_id IN (SELECT id FROM projects WHERE asset_key LIKE ${projectPrefix + '%'})`;
    await tx`DELETE FROM project_metrics WHERE source_id=${sourceId}`;
    await tx`DELETE FROM projects WHERE asset_key LIKE ${projectPrefix + '%'}`;
    await tx`DELETE FROM ai_analysis_runs WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
    await tx`DELETE FROM event_sources WHERE source_id=${sourceId}`;
    await tx`DELETE FROM events WHERE source_id=${sourceId}`;
    await tx`DELETE FROM raw_items WHERE source_id=${sourceId}`;
    await tx`DELETE FROM source_checkpoints WHERE source_id=${sourceId}`;
    await tx`DELETE FROM source_health_records WHERE source_id=${sourceId}`;
    await tx`DELETE FROM ingestion_runs WHERE source_id=${sourceId}`;
    await tx`DELETE FROM data_sources WHERE id=${sourceId}`;
  });
}

/** Real PostgreSQL checkpoints with synthetic RPC responses, never a live source. */
export async function verifyEvmPagination() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('EVM pagination integration requires a non-production Fixture database');
  const sourceId = `evm-pagination-fixture-${randomUUID()}`;
  const projectPrefix = `fixture:${sourceId}:`;
  const factory = '0x' + randomBytes(20).toString('hex');
  const hash = '0x' + 'a'.repeat(64);
  const initialCursor = { blockNumber: 79, blockHash: hash };
  const ranges: number[][] = [];
  let failSecondPage = true;
  let checks = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    checks++;
  };
  const topic = (address: string) => '0x' + '0'.repeat(24) + address.slice(2);
  const logs = [89, 100].map((height) => ({
    address: factory,
    topics: [
      PAIR_CREATED_TOPIC,
      topic('0x' + randomBytes(20).toString('hex')),
      topic('0x' + randomBytes(20).toString('hex')),
    ],
    data: topic('0x' + randomBytes(20).toString('hex')) + '0'.repeat(63) + '1',
    transactionHash: '0x' + randomBytes(32).toString('hex'),
    blockHash: hash,
    blockNumber: '0x' + height.toString(16),
    logIndex: '0x0',
    removed: false,
  }));
  const fetcher: typeof fetch = async (_input, init) => {
    const { method, params } = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    let result: unknown;
    if (method === 'eth_chainId') result = '0x1';
    else if (method === 'eth_getBlockByNumber')
      result = {
        number: params[0] === 'finalized' ? '0x64' : params[0],
        hash,
        timestamp: '0x69000000',
      };
    else if (method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      ranges.push([from, to]);
      if (to - from + 1 > 10 || (failSecondPage && from === 90))
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32600, message: 'Synthetic RPC free-plan rejection' },
          }),
          { status: 400 },
        );
      result = logs.filter((entry) => {
        const height = Number(BigInt(entry.blockNumber));
        return height >= from && height <= to;
      });
    } else throw new Error(`Unexpected fixture RPC method: ${method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  class FixtureEvmFactoryConnector extends EvmFactoryConnector {
    override normalize(item: RawItem) {
      const event = super.normalize(item);
      const assetKey = projectPrefix + event.assetKey;
      return {
        ...event,
        title: 'Fixture EVM pagination evidence',
        description: 'Synthetic RPC regression evidence; no external chain data was fetched.',
        originalUrl: `https://example.invalid/fixture/${sourceId}/${item.externalId}`,
        assetKey,
        project: event.project ? { ...event.project, assetKey } : undefined,
        dataMode: 'fixture' as const,
      };
    }
  }
  const connector = new FixtureEvmFactoryConnector('https://rpc.example.invalid', factory, fetcher);
  connector.metadata = {
    ...connector.metadata,
    id: sourceId,
    name: 'Fixture EVM pagination',
    officialUrl: 'https://example.invalid/fixture',
    mode: 'fixture',
    licenseStatus: 'internal-research-only',
  };
  const countFacts = async () =>
    (
      await sql`SELECT (SELECT count(*)::int FROM raw_items WHERE source_id=${sourceId}) AS raw,(SELECT count(*)::int FROM events WHERE source_id=${sourceId}) AS events`
    )[0]!;
  try {
    registry.register(connector);
    await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES(${sourceId},'Fixture EVM pagination',true,'fixture','{"fixture":true}'::jsonb)`;
    await sql`INSERT INTO source_checkpoints(source_id,cursor) VALUES(${sourceId},${sql.json(initialCursor)})`;
    await assert.rejects(runIngestion(sourceId), /HTTP 400/);
    checks++;
    const failedCursor = (
      await sql`SELECT cursor FROM source_checkpoints WHERE source_id=${sourceId}`
    )[0]!.cursor;
    assert.deepEqual(
      failedCursor,
      initialCursor,
      'Later-page failure preserves the PostgreSQL checkpoint',
    );
    checks++;
    const failedFacts = await countFacts();
    check(
      failedFacts.raw === 0 && failedFacts.events === 0,
      'A failed fetch commits no partial-page facts',
    );
    check(
      (await sql`SELECT status FROM ingestion_runs WHERE source_id=${sourceId}`)[0]!.status ===
        'FAILED',
      'Failed pagination is recorded as a failed ingestion run',
    );
    assert.deepEqual(
      ranges,
      [
        [80, 89],
        [90, 99],
      ],
      'A failed page stops further requests',
    );
    checks++;

    failSecondPage = false;
    ranges.length = 0;
    const recovered = await runIngestion(sourceId);
    assert.deepEqual(
      ranges,
      [
        [80, 89],
        [90, 99],
        [100, 100],
      ],
      'Retry starts from the saved block and covers the finalized tail',
    );
    checks++;
    check(
      recovered.fetched === 2 && recovered.inserted === 2,
      'Both pages of synthetic logs reach the real ingestion pipeline',
    );
    const recoveredCursor = (
      await sql`SELECT cursor FROM source_checkpoints WHERE source_id=${sourceId}`
    )[0]!.cursor;
    check(
      recoveredCursor.blockNumber === 100 && recoveredCursor.blockHash === hash,
      'Checkpoint advances only after every page succeeds',
    );
    const facts = await countFacts();
    check(facts.raw === 2 && facts.events === 2, 'Raw evidence and events are persisted');
    check(
      (
        await sql`SELECT id FROM events WHERE source_id=${sourceId} AND data->>'dataMode' IS DISTINCT FROM 'fixture'`
      ).length === 0,
      'Synthetic RPC events remain explicitly fixture data',
    );

    await sql`UPDATE source_checkpoints SET cursor=${sql.json(initialCursor)} WHERE source_id=${sourceId}`;
    const replayed = await runIngestion(sourceId);
    check(
      replayed.fetched === 2 && replayed.inserted === 0,
      'Replaying all pages does not insert duplicate events',
    );
    assert.deepEqual(
      await countFacts(),
      facts,
      'Raw and event counts remain idempotent after replay',
    );
    checks++;
    console.log(
      `EVM pagination integration passed: ${checks} PostgreSQL checks; synthetic RPC only.`,
    );
    return { checks };
  } finally {
    registry.remove(sourceId);
    await connector.shutdown();
    await cleanupFixtureSource(sourceId, projectPrefix);
  }
}

/** Versioned Solana transactions through the real worker and PostgreSQL pipeline. */
export async function verifySolanaTransactionVersion() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('Solana version integration requires a non-production Fixture database');
  const sourceId = `solana-version-fixture-${randomUUID()}`;
  const projectPrefix = `fixture:${sourceId}:`;
  const initialCursor = { signature: '1'.repeat(64), slot: 99 };
  const olderSignature = '2'.repeat(64);
  const newerSignature = '3'.repeat(64);
  const signatures = [
    { signature: newerSignature, slot: 101, err: null, blockTime: null },
    { signature: olderSignature, slot: 100, err: null, blockTime: null },
  ];
  const providerSecret = `synthetic-provider-secret-${randomUUID()}`;
  const transactionRequests: string[] = [];
  let rejectNewerVersion = true;
  let checks = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    checks++;
  };
  const fetcher: typeof fetch = async (_input, init) => {
    const { method, params } = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    let result: unknown;
    if (method === 'getSignaturesForAddress') {
      const options = params[1] as { commitment: string; until: string };
      assert.equal(options.commitment, 'finalized');
      assert.equal(options.until, initialCursor.signature);
      result = signatures;
    } else if (method === 'getTransaction') {
      const signature = String(params[0]);
      const options = params[1] as {
        commitment: string;
        encoding: string;
        maxSupportedTransactionVersion: number;
      };
      assert.deepEqual(options, {
        commitment: 'finalized',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 1,
      });
      transactionRequests.push(signature);
      if (rejectNewerVersion && signature === newerSignature)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: -32015,
              message: `Synthetic unsupported transaction version; https://rpc.example.invalid/${providerSecret}`,
            },
          }),
        );
      const older = signature === olderSignature;
      result = {
        version: 1,
        slot: older ? 100 : 101,
        blockTime: null,
        meta: {
          err: null,
          innerInstructions: [
            {
              index: 0,
              instructions: [
                {
                  programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
                  parsed: {
                    type: 'initializeMint2',
                    info: { mint: (older ? '4' : '5').repeat(32) },
                  },
                },
              ],
            },
          ],
        },
        transaction: {
          message: {
            transactionConfig: {},
            instructions: [{ programId: '6'.repeat(32), accounts: [], data: '' }],
          },
        },
      };
    } else throw new Error(`Unexpected fixture RPC method: ${method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  class FixtureSolanaMintConnector extends SolanaMintConnector {
    override normalize(item: RawItem) {
      const event = super.normalize(item);
      const assetKey = projectPrefix + event.assetKey;
      return {
        ...event,
        title: 'Fixture Solana transaction version evidence',
        description: 'Synthetic versioned transaction; no external chain data was fetched.',
        originalUrl: `https://example.invalid/fixture/${sourceId}/${item.externalId}`,
        assetKey,
        project: event.project ? { ...event.project, assetKey } : undefined,
        dataMode: 'fixture' as const,
      };
    }
  }
  const connector = new FixtureSolanaMintConnector(
    'https://rpc.example.invalid',
    '6'.repeat(32),
    fetcher,
  );
  connector.metadata = {
    ...connector.metadata,
    id: sourceId,
    name: 'Fixture Solana transaction version',
    officialUrl: 'https://example.invalid/fixture',
    mode: 'fixture',
    licenseStatus: 'internal-research-only',
  };
  const countFacts = async () =>
    (
      await sql`SELECT (SELECT count(*)::int FROM raw_items WHERE source_id=${sourceId}) AS raw,(SELECT count(*)::int FROM events WHERE source_id=${sourceId}) AS events`
    )[0]!;
  try {
    registry.register(connector);
    await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES(${sourceId},'Fixture Solana transaction version',true,'fixture','{"fixture":true}'::jsonb)`;
    await sql`INSERT INTO source_checkpoints(source_id,cursor) VALUES(${sourceId},${sql.json(initialCursor)})`;
    await assert.rejects(runIngestion(sourceId), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.classification, 'PERMANENT');
      assert.ok(error.message.includes('-32015'));
      assert.ok(!error.message.includes(providerSecret));
      return true;
    });
    checks++;
    assert.deepEqual(
      (await sql`SELECT cursor FROM source_checkpoints WHERE source_id=${sourceId}`)[0]!.cursor,
      initialCursor,
      'Unsupported later transaction preserves the committed signature',
    );
    checks++;
    const failedFacts = await countFacts();
    check(
      failedFacts.raw === 0 && failedFacts.events === 0,
      'A later transaction error never persists an incomplete fetched batch',
    );
    const failedRun = (
      await sql`SELECT status,error FROM ingestion_runs WHERE source_id=${sourceId}`
    )[0]!;
    check(
      failedRun.status === 'FAILED' &&
        String(failedRun.error).includes('-32015') &&
        !String(failedRun.error).includes(providerSecret),
      'Persisted run errors explain the version failure without provider text',
    );
    const sourceError = String(
      (await sql`SELECT last_error FROM data_sources WHERE id=${sourceId}`)[0]!.last_error,
    );
    check(
      sourceError.includes('-32015') && !sourceError.includes(providerSecret),
      'Source health also retains only the sanitized version error',
    );
    assert.deepEqual(
      transactionRequests,
      [olderSignature, newerSignature],
      'The error occurs after the earlier transaction has been read',
    );
    checks++;

    rejectNewerVersion = false;
    transactionRequests.length = 0;
    const recovered = await runIngestion(sourceId);
    assert.deepEqual(
      transactionRequests,
      [olderSignature, newerSignature],
      'Retry reads the entire batch from the previous persisted signature',
    );
    checks++;
    check(
      recovered.fetched === 2 && recovered.inserted === 2,
      'Version 1 inner initializeMint2 instructions reach persisted events',
    );
    const recoveredCursor = (
      await sql`SELECT cursor FROM source_checkpoints WHERE source_id=${sourceId}`
    )[0]!.cursor;
    check(
      recoveredCursor.signature === newerSignature && recoveredCursor.slot === 101,
      'Successful versioned transactions advance the checkpoint to the newest signature',
    );
    const facts = await countFacts();
    check(
      facts.raw === 2 && facts.events === 2,
      'Both versioned transactions have durable evidence',
    );
    check(
      (
        await sql`SELECT id FROM events WHERE source_id=${sourceId} AND data->>'dataMode' IS DISTINCT FROM 'fixture'`
      ).length === 0,
      'Synthetic Solana evidence remains explicitly fixture data',
    );
    await sql`UPDATE source_checkpoints SET cursor=${sql.json(initialCursor)} WHERE source_id=${sourceId}`;
    const replayed = await runIngestion(sourceId);
    check(
      replayed.fetched === 2 && replayed.inserted === 0,
      'Replaying versioned transactions creates no duplicate events',
    );
    assert.deepEqual(
      await countFacts(),
      facts,
      'Versioned raw and event replay remains idempotent',
    );
    checks++;
    console.log(
      `Solana transaction version integration passed: ${checks} PostgreSQL checks; synthetic RPC only.`,
    );
    return { checks };
  } finally {
    registry.remove(sourceId);
    await connector.shutdown();
    await cleanupFixtureSource(sourceId, projectPrefix);
  }
}
