import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql } from '../packages/database/src/index.js';
import { UniSatBrc20Connector, type RawItem } from '../packages/connectors/src/index.js';
import { registry, runIngestion } from '../apps/worker/src/pipeline.js';

/** Real PostgreSQL acceptance using the actual UniSat adapter with synthetic
 * HTTP responses. Every persisted row is explicitly isolated as Fixture data. */
export async function verifyUniSatIngestion() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('UniSat ingestion integration requires a non-production Fixture database');
  const sourceId = `unisat-ingestion-fixture-${randomUUID()}`;
  const projectPrefix = `fixture:${sourceId}:`;
  const deployedAt = Math.floor(Date.now() / 1000) - 3600;
  const secondDeployedAt = deployedAt - 60;
  let firstMinted = '10';
  let secondMinted = '15';
  let failSecondNormalization = false;
  let normalizationCalls = 0;
  let height = 900_000;
  let transportRequests = 0;
  let checks = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    checks++;
  };
  const equal = (actual: unknown, expected: unknown, message: string) => {
    assert.deepEqual(actual, expected, message);
    checks++;
  };
  const fetcher: typeof fetch = async (input) => {
    transportRequests++;
    const url = new URL(String(input));
    assert.equal(url.hostname, 'open-api.unisat.io');
    const detail =
      url.searchParams.get('complete') === 'no'
        ? [
            {
              ticker: 'AAAA',
              inscriptionId: 'fixture-ai0',
              deployTime: deployedAt,
              minted: firstMinted,
              max: '100',
              holdersCount: 10,
            },
            {
              ticker: 'BBBB',
              inscriptionId: 'fixture-bi0',
              deployTime: secondDeployedAt,
              minted: secondMinted,
              max: '100',
              holdersCount: 15,
            },
            {
              ticker: 'OLDD',
              inscriptionId: 'fixture-oldi0',
              deployTime: 1_678_340_348,
              minted: '10',
              max: '100',
            },
            { ticker: 'UNKN', inscriptionId: 'fixture-unknowni0', minted: '10', max: '100' },
            {
              ticker: 'FUTR',
              inscriptionId: 'fixture-futurei0',
              deployTime: Math.floor(Date.now() / 1000) + 86_400,
              minted: '10',
              max: '100',
            },
          ]
        : [];
    return new Response(
      JSON.stringify({ code: 0, data: { height: height++, total: detail.length, detail } }),
    );
  };
  class FixtureUniSatConnector extends UniSatBrc20Connector {
    override normalize(item: RawItem) {
      normalizationCalls++;
      if (failSecondNormalization && normalizationCalls === 2)
        throw new Error('Synthetic second UniSat normalization failure');
      const event = super.normalize(item);
      const assetKey = projectPrefix + event.assetKey;
      return {
        ...event,
        title: `Fixture UniSat state ${String(item.payload.ticker)}`,
        description: 'Synthetic UniSat status response; no external chain data was fetched.',
        originalUrl: `https://example.invalid/fixture/${sourceId}/${item.externalId}`,
        assetKey,
        project: event.project ? { ...event.project, assetKey } : undefined,
        dataMode: 'fixture' as const,
      };
    }
  }
  const createConnector = () => {
    const instance = new FixtureUniSatConnector('synthetic-unisat-key', fetcher);
    instance.metadata = {
      ...instance.metadata,
      id: sourceId,
      name: 'Fixture UniSat ingestion',
      officialUrl: 'https://example.invalid/fixture',
      mode: 'fixture',
      licenseStatus: 'internal-research-only',
    };
    return instance;
  };
  let connector = createConnector();
  const countFacts = async () =>
    (
      await sql`SELECT (SELECT count(*)::int FROM raw_items WHERE source_id=${sourceId}) AS raw,(SELECT count(*)::int FROM events WHERE source_id=${sourceId}) AS events,(SELECT count(*)::int FROM events WHERE source_id=${sourceId} AND event_type='TOKEN_STATE_SNAPSHOT') AS snapshots,(SELECT count(*)::int FROM project_metrics WHERE source_id=${sourceId}) AS metrics,(SELECT count(*)::int FROM projects WHERE asset_key LIKE ${projectPrefix + '%'}) AS projects,(SELECT count(*)::int FROM opportunity_signals WHERE project_id IN (SELECT id FROM projects WHERE asset_key LIKE ${projectPrefix + '%'}) AND data->>'type'='NEW_TOKEN_DEPLOYED') AS deployments`
    )[0]!;
  const readCursor = async () =>
    (await sql`SELECT cursor FROM source_checkpoints WHERE source_id=${sourceId}`)[0]!.cursor;
  try {
    registry.register(connector);
    await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES(${sourceId},'Fixture UniSat ingestion',true,'fixture','{"fixture":true}'::jsonb)`;
    const first = await runIngestion(sourceId);
    check(
      first.fetched === 2 && first.inserted === 2,
      'Only two recent deployments enter ingestion',
    );
    const baseline = await countFacts();
    check(
      baseline.raw === 2 &&
        baseline.snapshots === 2 &&
        baseline.metrics === 2 &&
        baseline.projects === 2,
      'Recent snapshots persist raw evidence, events, metrics and projects',
    );
    check(
      baseline.deployments === 2,
      'Each recent candidate creates one deployment discovery signal',
    );
    check(
      (
        await sql`SELECT id FROM raw_items WHERE source_id=${sourceId} AND payload->>'ticker' IN ('OLDD','UNKN','FUTR')`
      ).length === 0,
      '2023, unknown and future deployments create no raw facts',
    );
    const initialCursor = await readCursor();
    check(
      initialCursor.version === 2 && initialCursor.batchSequence === 1,
      'Versioned checkpoint commits the first batch',
    );
    check(
      Object.keys(initialCursor.snapshots).length === 2 &&
        initialCursor.snapshots['fixture-ai0']?.fingerprint &&
        initialCursor.snapshots['fixture-bi0']?.fingerprint,
      'Checkpoint retains only accepted recent candidate fingerprints',
    );
    const times =
      await sql`SELECT e.data,r.first_seen_at,r.collected_at FROM events e JOIN raw_items r ON r.id=(e.data->>'rawDataReference')::uuid WHERE e.source_id=${sourceId} AND e.event_type='TOKEN_STATE_SNAPSHOT' ORDER BY e.title`;
    equal(
      times.map((row) => row.data.eventOccurredAt),
      [deployedAt, secondDeployedAt].map((time) => new Date(time * 1000).toISOString()),
      'Event occurrence preserves each real synthetic deployment time',
    );
    check(
      times.every((row) => row.data.sourcePublishedAt === null),
      'Polling never invents an unknown provider publication time',
    );
    check(
      times.every(
        (row) =>
          row.data.firstSeenAt === new Date(row.first_seen_at as string).toISOString() &&
          Date.parse(row.data.firstSeenAt) >= deployedAt * 1000 &&
          Date.parse(row.data.collectedAt) >= new Date(row.collected_at as string).getTime() &&
          Number.isFinite(Date.parse(row.data.metrics.observedAt)),
      ),
      'Discovery, collection and observation timestamps retain processing semantics',
    );
    check(
      (
        await sql`SELECT id FROM events WHERE source_id=${sourceId} AND data->>'dataMode' IS DISTINCT FROM 'fixture'`
      ).length === 0,
      'All synthetic snapshots and derived events remain explicitly fixture',
    );

    const unchanged = await runIngestion(sourceId);
    check(
      unchanged.fetched === 0 && unchanged.inserted === 0,
      'Unchanged status produces zero new observations',
    );
    equal(
      await countFacts(),
      baseline,
      'Unchanged polling creates no raw, event, metric or discovery duplicates',
    );
    check(
      (await readCursor()).batchSequence === 2,
      'Successful unchanged polling advances only checkpoint metadata',
    );
    check(
      (await sql`SELECT last_error,data FROM data_sources WHERE id=${sourceId}`)[0]!.data.status ===
        'healthy',
      'A zero-item poll remains healthy',
    );

    registry.remove(sourceId);
    await connector.shutdown();
    connector = createConnector();
    registry.register(connector);
    const resumed = await runIngestion(sourceId);
    check(
      resumed.fetched === 0 && resumed.inserted === 0,
      'Recreated connector resumes saved PostgreSQL snapshot fingerprints',
    );
    equal(
      await countFacts(),
      baseline,
      'Process recreation does not reinsert unchanged observations',
    );
    check(
      (await readCursor()).batchSequence === 3,
      'Recreated connector continues the durable batch sequence',
    );

    firstMinted = '20';
    const changed = await runIngestion(sourceId);
    check(
      changed.fetched === 1 && changed.inserted === 1,
      'A genuine token state change emits one observation',
    );
    const afterChange = await countFacts();
    check(
      afterChange.raw === 3 && afterChange.snapshots === 3 && afterChange.metrics === 3,
      'Changed state adds one immutable raw/event/metric set',
    );
    check(
      afterChange.projects === 2 && afterChange.deployments === 2,
      'A state change reuses its project without repeating deployment discovery',
    );

    firstMinted = '10';
    const reverted = await runIngestion(sourceId);
    check(
      reverted.fetched === 1 && reverted.inserted === 1,
      'A to B to A state reversion remains a distinct observation',
    );
    const beforeFailureFacts = await countFacts();
    check(
      beforeFailureFacts.raw === 4 &&
        beforeFailureFacts.snapshots === 4 &&
        beforeFailureFacts.metrics === 4,
      'Reversion preserves a fourth immutable state observation',
    );
    const beforeFailureCursor = await readCursor();
    firstMinted = '25';
    secondMinted = '30';
    failSecondNormalization = true;
    normalizationCalls = 0;
    await assert.rejects(runIngestion(sourceId), /Synthetic second UniSat normalization failure/);
    checks++;
    equal(
      await readCursor(),
      beforeFailureCursor,
      'Partial processing failure preserves the prior committed checkpoint',
    );
    const pendingBatch = (
      await sql`SELECT data FROM source_pending_batches WHERE source_id=${sourceId}`
    )[0];
    check(
      pendingBatch?.data.items.length === 2,
      'Partial processing failure retains its complete staged batch in PostgreSQL',
    );
    const partialFacts = await countFacts();
    check(
      partialFacts.raw === beforeFailureFacts.raw + 2 &&
        partialFacts.snapshots === beforeFailureFacts.snapshots + 1 &&
        partialFacts.metrics === beforeFailureFacts.metrics + 1,
      'Partial failure retains both raw records and only the first successfully normalized state',
    );
    const partialIds = (
      await sql`SELECT external_id FROM raw_items WHERE source_id=${sourceId} ORDER BY external_id`
    ).map((row) => String(row.external_id));
    check(
      (await sql`SELECT id FROM ingestion_runs WHERE source_id=${sourceId} AND status='FAILED'`)
        .length === 1,
      'Partial normalization failure is visible in durable ingestion runs',
    );
    failSecondNormalization = false;
    normalizationCalls = 0;
    // The provider reverts while the failed batch is awaiting recovery. The
    // pending B observation must finish before a later poll records A again.
    firstMinted = '10';
    const requestsBeforeRetry = transportRequests;
    registry.remove(sourceId);
    await connector.shutdown();
    connector = createConnector();
    registry.register(connector);
    const retried = await runIngestion(sourceId);
    check(
      retried.fetched === 2 && retried.inserted === 1,
      'Restarted retry replays the failed batch and inserts only its missing event',
    );
    check(
      transportRequests === requestsBeforeRetry,
      'Restarted retry replays the durable batch without rereading changed upstream state',
    );
    equal(
      (
        await sql`SELECT external_id FROM raw_items WHERE source_id=${sourceId} ORDER BY external_id`
      ).map((row) => String(row.external_id)),
      partialIds,
      'Failed-batch retry uses exactly the same external raw identities',
    );
    const recovered = await countFacts();
    check(
      recovered.raw === beforeFailureFacts.raw + 2 &&
        recovered.snapshots === beforeFailureFacts.snapshots + 2 &&
        recovered.metrics === beforeFailureFacts.metrics + 2,
      'Recovered batch persists each state exactly once across failure and restart',
    );
    check(
      (await readCursor()).batchSequence === beforeFailureCursor.batchSequence + 1,
      'Checkpoint advances exactly one sequence after the retry succeeds',
    );
    check(
      (await sql`SELECT source_id FROM source_pending_batches WHERE source_id=${sourceId}`)
        .length === 0,
      'Successful batch recovery removes its pending batch with the checkpoint commit',
    );
    check(
      recovered.projects === 2 && recovered.deployments === 2,
      'Retries never repeat project creation or deployment discoveries',
    );
    const recoveredEvidence =
      await sql`SELECT e.data,r.payload,r.first_seen_at FROM events e JOIN raw_items r ON r.id=(e.data->>'rawDataReference')::uuid WHERE e.source_id=${sourceId} AND e.event_type='TOKEN_STATE_SNAPSHOT'`;
    check(
      recoveredEvidence.every((row) => row.data.metrics.observedAt === row.payload.observedAt),
      'Retry metrics use the observation time from their retained raw evidence',
    );
    check(
      recoveredEvidence.every(
        (row) => row.data.firstSeenAt === new Date(row.first_seen_at as string).toISOString(),
      ),
      'Retried events preserve the original durable raw first-discovery time',
    );
    const afterRetry = await runIngestion(sourceId);
    check(
      afterRetry.fetched === 1 && afterRetry.inserted === 1,
      'The next poll captures upstream A after the staged B batch has committed',
    );
    const afterUpstreamReversion = await countFacts();
    check(
      afterUpstreamReversion.raw === recovered.raw + 1 &&
        afterUpstreamReversion.snapshots === recovered.snapshots + 1 &&
        afterUpstreamReversion.metrics === recovered.metrics + 1,
      'Upstream reversion following a failed batch creates one immutable state observation',
    );
    check(
      transportRequests > requestsBeforeRetry,
      'Polling resumes provider requests after pending batch recovery',
    );
    const stableAfterRetry = await runIngestion(sourceId);
    check(
      stableAfterRetry.fetched === 0 && stableAfterRetry.inserted === 0,
      'The recovered and reverted state is suppressed on the next unchanged poll',
    );
    equal(await countFacts(), afterUpstreamReversion, 'Facts stay stable after retry recovery');
    console.log(
      `UniSat ingestion integration passed: ${checks} PostgreSQL checks; synthetic status responses only.`,
    );
    return { checks };
  } finally {
    registry.remove(sourceId);
    await connector.shutdown();
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
}
