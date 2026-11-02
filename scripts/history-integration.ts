import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Connector, NormalizedEvent, RawItem } from '../packages/connectors/src/index.js';
import { sql, closeDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { config } from '../packages/config/src/index.js';
import { RuleSchema } from '../packages/shared/src/index.js';
import { persistEvent, scanParticipationWindows } from '../apps/worker/src/pipeline.js';

/** Real PostgreSQL acceptance. Each run creates one isolated Fixture source and
 * removes only its own records, including its notification/outbox dependencies. */
export async function verifyHistoricalPipeline(
  inspect?: (context: {
    projectId: string;
    sourceId: string;
    signalEventIds: string[];
    rawIds: string[];
  }) => Promise<void>,
) {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('Historical integration requires a non-production Fixture database');
  const suffix = randomUUID();
  const sourceId = `history-acceptance-${suffix}`;
  const assetKey = `fixture:history:${suffix}`;
  const ownerId = randomUUID();
  const channelId = randomUUID();
  const at = Date.now();
  const end = new Date(at + 2 * 3600_000).toISOString();
  const json = (data: unknown) => sql.json(data as Parameters<typeof sql.json>[0]);
  let checks = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    checks++;
  };
  const connector: Connector = {
    metadata: {
      id: sourceId,
      name: sourceId,
      officialUrl: 'https://example.org/fixture',
      transport: 'pull',
      mode: 'fixture',
      categories: ['history'],
      trust: 0.9,
      pollIntervalSeconds: 60,
      licenseStatus: 'internal-research-only',
    },
    capabilities: { history: true, checkpoint: true, scope: 'watchlist', sourceTimestamp: false },
    rateLimit: { maxRequests: 1, windowMs: 1000, respectRetryAfter: true },
    initialize: async () => {},
    fetch: async () => ({ items: [], cursor: {} }),
    healthCheck: async () => ({ status: 'healthy', detail: 'deterministic fixture' }),
    shutdown: async () => {},
    normalize: (item) => item.payload.normalized as NormalizedEvent,
  };
  try {
    await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES(${sourceId},${sourceId},true,'fixture','{}')`;
    await sql`INSERT INTO users(id,email,password_hash) VALUES(${ownerId},${`${suffix}@history.fixture`},'not-a-login-hash')`;
    await sql`INSERT INTO notification_channels(id,owner_id,provider,name,enabled,data) VALUES(${channelId},${ownerId},'telegram','history fixture',true,'{}')`;
    for (const type of [
      'UNIQUE_PARTICIPANTS_SPIKE',
      'LIQUIDITY_REMOVED',
      'PARTICIPATION_WINDOW_EXPIRED',
    ]) {
      const rule = RuleSchema.parse({
        id: randomUUID(),
        ownerId,
        name: type,
        conditions: { sourceIds: [sourceId], eventTypes: [type] },
        channelIds: [channelId],
        cooldownSeconds: 60,
        createdAt: new Date(at).toISOString(),
        updatedAt: new Date(at).toISOString(),
        version: 1,
      });
      await sql`INSERT INTO alert_rules(id,owner_id,name,enabled,version,data) VALUES(${rule.id},${ownerId},${rule.name},true,1,${json(rule)})`;
    }
    const snapshots: RawItem[] = [0, 1, 2].map((i) => {
      const observedAt = new Date(at - (120 - i * 50) * 60_000).toISOString();
      const normalized: NormalizedEvent = {
        sourceId,
        externalId: `sample-${i}`,
        title: `history snapshot ${i}`,
        description: 'synthetic integration evidence',
        eventType: 'TOKEN_STATE_SNAPSHOT',
        originalUrl: 'https://example.org/fixture',
        sourcePublishedAt: null,
        eventOccurredAt: null,
        assets: [assetKey],
        categories: ['history'],
        chain: 'Fixture',
        assetKey,
        identity: `${assetKey}:${i}`,
        confidence: i === 2 ? 0.95 : 0.7,
        severity: 'P2',
        verificationStatus: 'VERIFIED',
        dataMode: 'fixture',
        conditionsVerified: true,
        project: {
          assetKey,
          name: 'Historical acceptance fixture',
          chain: 'Fixture',
          protocol: 'BRC-20',
          stage: i === 2 ? 'ACTIVE' : 'EARLY_STAGE',
          conditions: 'Verified synthetic terms',
          startsAt: new Date(at - 4 * 3600_000).toISOString(),
          endsAt: end,
        },
        metrics: {
          observedAt,
          max: '1000.0',
          mintProgress: [0, 2, 8][i]!,
          uniqueParticipants: [10, 10, 40][i]!,
          holders: [100, 300, 900][i]!,
          liquidityUsd: [20000, 20000, 5000][i]!,
          volumeUsd: [1000, 1000, 10000][i]!,
          volumeWindowSeconds: 3600,
          socialMentions: [20, 20, 100][i]!,
          socialWindowSeconds: 3600,
        },
      };
      return { externalId: `sample-${i}`, payload: { normalized }, publishedAt: null };
    });
    const futureRawId = randomUUID();
    const futureInitial = {
      externalId: 'first-future',
      publishedAt: null,
      payload: {
        normalized: {
          ...(snapshots[2]!.payload.normalized as NormalizedEvent),
          externalId: 'first-future',
          identity: `${assetKey}:first-future`,
          metrics: {
            observedAt: new Date(at + 240 * 60_000).toISOString(),
            mintProgress: 99,
            uniqueParticipants: 9000,
          },
        },
      },
    };
    const initiallySeen = new Date(at).toISOString();
    await sql`INSERT INTO raw_items(id,source_id,external_id,payload,published_at,first_seen_at,collected_at) VALUES(${futureRawId},${sourceId},${futureInitial.externalId},${json(futureInitial.payload)},null,${initiallySeen},${initiallySeen})`;
    await persistEvent(connector, futureRawId, initiallySeen, futureInitial);
    check(
      (await sql`SELECT count(*)::int n FROM projects WHERE asset_key=${assetKey}`)[0]!.n === 0,
      'first future observation cannot establish a project summary',
    );
    check(
      (await sql`SELECT count(*)::int n FROM raw_items WHERE id=${futureRawId}`)[0]!.n === 1 &&
        (await sql`SELECT count(*)::int n FROM events WHERE source_id=${sourceId}`)[0]!.n === 0,
      'future-only first observation retains raw evidence without current event or signal',
    );
    for (const item of snapshots) {
      const id = randomUUID();
      const seen = new Date(at).toISOString();
      await sql`INSERT INTO raw_items(id,source_id,external_id,payload,published_at,first_seen_at,collected_at) VALUES(${id},${sourceId},${item.externalId},${json(item.payload)},null,${seen},${seen})`;
      await persistEvent(connector, id, seen, item);
    }
    const project = (await sql`SELECT id,stage FROM projects WHERE asset_key=${assetKey}`)[0]!;
    const projectId = String(project.id);
    check(
      (await sql`SELECT count(*)::int n FROM project_metrics WHERE project_id=${projectId}`)[0]!
        .n === 3,
      'three immutable metric observations persisted',
    );
    const signals = await sql`SELECT data FROM opportunity_signals WHERE project_id=${projectId}`;
    const types = signals.map((row) => String((row.data as Record<string, unknown>).type));
    for (const type of [
      'NEW_TOKEN_DEPLOYED',
      'MINT_STARTED',
      'MINT_PROGRESS_ACCELERATED',
      'UNIQUE_PARTICIPANTS_SPIKE',
      'LIQUIDITY_REMOVED',
      'VOLUME_SPIKE',
      'SOCIAL_MOMENTUM',
      'PROJECT_LAUNCHED',
      'PROJECT_TRUST_CHANGED',
    ])
      check(types.includes(type), `${type} derived from historical observations`);
    const removed = signals.find(
      (row) => (row.data as Record<string, unknown>).type === 'LIQUIDITY_REMOVED',
    )!.data as Record<string, unknown>;
    check(Number(removed.riskScore) >= 85, 'critical liquidity removal independently raises risk');
    const initialSummary = (await sql`SELECT data FROM projects WHERE id=${projectId}`)[0]!
      .data as Record<string, unknown>;
    const participantSpike = signals.find(
      (row) => (row.data as Record<string, unknown>).type === 'UNIQUE_PARTICIPANTS_SPIKE',
    )!.data as Record<string, unknown>;
    check(
      Number(initialSummary.riskScore) >= 85 && initialSummary.riskFlagged === true,
      'project summary inherits critical liquidity risk',
    );
    check(
      initialSummary.participantGrowthPct === 300 && initialSummary.participants === 40,
      'project summary records genuine participant growth rather than holders',
    );
    check(
      (initialSummary.riskBreakdown as { flags: string[] }).flags.includes('LIQUIDITY_REMOVAL') &&
        (initialSummary.riskWarnings as string[]).includes('LIQUIDITY_REMOVAL'),
      'project risk breakdown and warnings retain critical evidence',
    );
    check(
      initialSummary.opportunityScore === participantSpike.opportunityScore &&
        (initialSummary.opportunityBreakdown as { version: string }).version ===
          participantSpike.scoringVersion,
      'project opportunity summary retains the derived score and scoring version',
    );
    check(
      (
        await sql`SELECT count(*)::int n FROM alert_triggers WHERE rule_id IN (SELECT id FROM alert_rules WHERE owner_id=${ownerId})`
      )[0]!.n === 2,
      'different historical signals reach source-specific rules',
    );
    const before = (
      await sql`SELECT count(*)::int n FROM opportunity_signals WHERE project_id=${projectId}`
    )[0]!.n;
    const last = snapshots[2]!;
    const raw = (
      await sql`SELECT id,first_seen_at FROM raw_items WHERE source_id=${sourceId} AND external_id=${last.externalId}`
    )[0]!;
    await Promise.all([
      persistEvent(
        connector,
        String(raw.id),
        new Date(raw.first_seen_at as string).toISOString(),
        last,
      ),
      persistEvent(
        connector,
        String(raw.id),
        new Date(raw.first_seen_at as string).toISOString(),
        last,
      ),
    ]);
    check(
      (await sql`SELECT count(*)::int n FROM opportunity_signals WHERE project_id=${projectId}`)[0]!
        .n === before,
      'concurrent retry preserves signal count',
    );
    const append = async (externalId: string, normalized: NormalizedEvent) => {
      const id = randomUUID();
      const seen = new Date().toISOString();
      const item = {
        externalId,
        publishedAt: null,
        payload: {
          normalized: { ...normalized, externalId, identity: `${assetKey}:${externalId}` },
        },
      };
      await sql`INSERT INTO raw_items(id,source_id,external_id,payload,published_at,first_seen_at,collected_at) VALUES(${id},${sourceId},${externalId},${json(item.payload)},null,${seen},${seen})`;
      await persistEvent(connector, id, seen, item);
    };
    const lastNormalized = last.payload.normalized as NormalizedEvent;
    await sql`UPDATE projects SET data=data-'latestObservedAt' WHERE id=${projectId}`;
    await append('late', {
      ...lastNormalized,
      project: { ...lastNormalized.project!, stage: 'EARLY_STAGE' },
      metrics: {
        ...lastNormalized.metrics,
        observedAt: new Date(at - 180 * 60_000).toISOString(),
        mintProgress: 1,
        uniqueParticipants: 9000,
      },
    });
    const legacyMetricSummary = (
      await sql`SELECT stage,data FROM projects WHERE id=${projectId}`
    )[0]!;
    check(
      legacyMetricSummary.stage === 'ACTIVE' &&
        (legacyMetricSummary.data as Record<string, unknown>).latestObservedAt ===
          lastNormalized.metrics?.observedAt &&
        (legacyMetricSummary.data as Record<string, unknown>).mintProgress === 8,
      'legacy summary derives its time baseline from latest knowable project metrics',
    );
    await append('future', {
      ...lastNormalized,
      project: { ...lastNormalized.project!, stage: 'COMPLETED' },
      metrics: {
        ...lastNormalized.metrics,
        observedAt: new Date(at + 240 * 60_000).toISOString(),
        mintProgress: 99,
        uniqueParticipants: 9000,
      },
    });
    const currentProject = (await sql`SELECT stage,data FROM projects WHERE id=${projectId}`)[0]!;
    check(
      currentProject.stage === 'ACTIVE' &&
        (currentProject.data as Record<string, unknown>).mintProgress === 8 &&
        Number((currentProject.data as Record<string, unknown>).riskScore) >= 85 &&
        (currentProject.data as Record<string, unknown>).participantGrowthPct === 300,
      'late/future observations cannot roll current project state',
    );
    check(
      (
        await sql`SELECT count(*)::int n FROM project_lifecycle_events WHERE project_id=${projectId}`
      )[0]!.n === 2,
      'late observation creates no false lifecycle transition',
    );
    check(
      (await sql`SELECT count(*)::int n FROM opportunity_signals WHERE project_id=${projectId}`)[0]!
        .n === before,
      'late/future observations cannot leak history signals',
    );
    await append('ordinary', {
      ...lastNormalized,
      metrics: {
        ...lastNormalized.metrics,
        observedAt: new Date(at - 10 * 60_000).toISOString(),
        holders: 500000,
      },
    });
    const ordinarySummary = (await sql`SELECT data FROM projects WHERE id=${projectId}`)[0]!
      .data as Record<string, unknown>;
    check(
      Number(ordinarySummary.riskScore) >= 85 &&
        ordinarySummary.riskFlagged === true &&
        (ordinarySummary.criticalRiskFlags as string[]).includes('LIQUIDITY_REMOVAL'),
      'an ordinary low-information snapshot cannot erase confirmed critical risk',
    );
    check(
      ordinarySummary.participantGrowthPct === 300 && ordinarySummary.participants === 40,
      'ordinary holder growth cannot overwrite the last measured genuine participant spike',
    );
    // Simulate a legacy summary without metrics, then restore only this test's
    // saved metric rows so the later clock acceptance still uses full history.
    const savedMetrics =
      await sql`DELETE FROM project_metrics WHERE project_id=${projectId} RETURNING id,source_id,observed_at,data`;
    await sql`UPDATE projects SET data=data-'latestObservedAt' WHERE id=${projectId}`;
    await append('legacy-no-metrics-late', {
      ...lastNormalized,
      project: { ...lastNormalized.project!, stage: 'EARLY_STAGE' },
      metrics: {
        observedAt: new Date(at - 200 * 60_000).toISOString(),
        mintProgress: 1,
        uniqueParticipants: 9000,
      },
    });
    const legacyFallback = (await sql`SELECT stage,data FROM projects WHERE id=${projectId}`)[0]!;
    const fallbackData = legacyFallback.data as Record<string, unknown>;
    check(
      legacyFallback.stage === 'ACTIVE' &&
        fallbackData.mintProgress === 8 &&
        Number(fallbackData.riskScore) >= 85 &&
        fallbackData.participantGrowthPct === 300,
      'legacy summary without metrics conservatively rejects older observations using saved summary time',
    );
    check(
      Date.parse(String(fallbackData.latestObservedAt)) >= at,
      'legacy fallback records the existing summary time as its recovered baseline',
    );
    for (const metric of savedMetrics)
      await sql`INSERT INTO project_metrics(id,project_id,source_id,observed_at,data) VALUES(${String(metric.id)},${projectId},${String(metric.source_id)},${new Date(metric.observed_at as string).toISOString()},${json(metric.data)})`;
    const withdrawn = {
      ...lastNormalized,
      metrics: undefined,
      conditionsVerified: false,
      project: { ...lastNormalized.project!, conditions: null, endsAt: null },
    };
    await append('withdrawn', withdrawn);
    await scanParticipationWindows(new Date(at + 70 * 60_000).toISOString(), [sourceId]);
    check(
      (
        await sql`SELECT count(*)::int n FROM opportunity_signals WHERE project_id=${projectId} AND data->>'type' LIKE 'PARTICIPATION_WINDOW_%'`
      )[0]!.n === 0,
      'terms revocation without numeric metrics suppresses older verified window',
    );
    await append('restored', { ...lastNormalized, metrics: {} });
    await scanParticipationWindows(new Date(at + 70 * 60_000).toISOString(), [sourceId]);
    await scanParticipationWindows(new Date(at + 121 * 60_000).toISOString(), [sourceId]);
    await scanParticipationWindows(new Date(at + 122 * 60_000).toISOString(), [sourceId]);
    check(
      (
        await sql`SELECT count(*)::int n FROM opportunity_signals WHERE project_id=${projectId} AND data->>'type' IN ('PARTICIPATION_WINDOW_EXPIRING','PARTICIPATION_WINDOW_EXPIRED')`
      )[0]!.n === 2,
      'clock alone produces one expiring and one expired signal',
    );
    check(
      (await sql`SELECT stage FROM projects WHERE id=${projectId}`)[0]!.stage === 'ACTIVE',
      'activity expiration does not complete project',
    );
    check(
      (await sql`SELECT count(*)::int n FROM notifications WHERE channel_id=${channelId}`)[0]!.n ===
        3,
      'signals create durable notifications through the outbox',
    );
    check(
      (
        await sql`SELECT count(*)::int n FROM events WHERE source_id=${sourceId} AND data->>'sourcePublishedAt' IS NOT NULL`
      )[0]!.n === 0,
      'sampling/clock never fabricates source publication',
    );
    check(
      (
        await sql`SELECT count(*)::int n FROM opportunity_signals s LEFT JOIN events e ON e.id=s.event_id WHERE s.project_id=${projectId} AND (e.id IS NULL OR NOT EXISTS(SELECT 1 FROM event_sources es WHERE es.event_id=e.id))`
      )[0]!.n === 0,
      'every derived/window signal has a persisted event and raw evidence',
    );
    check(
      (
        await sql`SELECT count(*)::int n FROM opportunity_signals WHERE project_id=${projectId} AND data->>'type'='NEW_TOKEN_DEPLOYED'`
      )[0]!.n === 1,
      'first indexed deployment discovery emits once across snapshots',
    );
    check(
      (
        await sql`SELECT count(*)::int n FROM outbox_jobs WHERE kind='NOTIFY' AND entity_id IN (SELECT id FROM notifications WHERE channel_id=${channelId})`
      )[0]!.n === 3,
      'notification outbox commit matches the three deterministic rule triggers',
    );
    if (inspect)
      await inspect({
        projectId,
        sourceId,
        signalEventIds: (
          await sql`SELECT event_id FROM opportunity_signals WHERE project_id=${projectId}`
        ).map((row) => String(row.event_id)),
        rawIds: (await sql`SELECT id FROM raw_items WHERE source_id=${sourceId}`).map((row) =>
          String(row.id),
        ),
      });
    return { checks, dataMode: 'fixture', historicalSignals: before, windowSignals: 2 };
  } finally {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM outbox_jobs WHERE entity_id IN (SELECT id FROM notifications WHERE channel_id=${channelId} OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId})) OR entity_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM notification_attempts WHERE notification_id IN (SELECT id FROM notifications WHERE channel_id=${channelId} OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId}))`;
      await tx`DELETE FROM notifications WHERE channel_id=${channelId} OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM alert_triggers WHERE rule_id IN (SELECT id FROM alert_rules WHERE owner_id=${ownerId}) OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM alert_rule_versions WHERE rule_id IN (SELECT id FROM alert_rules WHERE owner_id=${ownerId})`;
      await tx`DELETE FROM alert_rules WHERE owner_id=${ownerId}`;
      await tx`DELETE FROM opportunity_signals WHERE project_id IN (SELECT id FROM projects WHERE asset_key=${assetKey})`;
      await tx`DELETE FROM risk_assessments WHERE project_id IN (SELECT id FROM projects WHERE asset_key=${assetKey}) OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM project_lifecycle_events WHERE project_id IN (SELECT id FROM projects WHERE asset_key=${assetKey})`;
      await tx`DELETE FROM project_metrics WHERE project_id IN (SELECT id FROM projects WHERE asset_key=${assetKey})`;
      await tx`DELETE FROM projects WHERE asset_key=${assetKey}`;
      await tx`DELETE FROM ai_analysis_runs WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM event_sources WHERE source_id=${sourceId}`;
      await tx`DELETE FROM events WHERE source_id=${sourceId}`;
      await tx`DELETE FROM raw_items WHERE source_id=${sourceId}`;
      await tx`DELETE FROM data_sources WHERE id=${sourceId}`;
      await tx`DELETE FROM notification_channels WHERE owner_id=${ownerId}`;
      await tx`DELETE FROM user_settings WHERE user_id=${ownerId}`;
      await tx`DELETE FROM users WHERE id=${ownerId}`;
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrate();
    console.log(JSON.stringify(await verifyHistoricalPipeline()));
  } finally {
    await closeDatabase();
  }
}
