import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { sql, ensureAdmin, readAIConfig, readSourceIntegrationsConfig } from '@radar/database';
import { config } from '@radar/config';
import { createLogger } from '@radar/observability';
import {
  createRegistry,
  type Connector,
  type RawItem,
  type NormalizedEvent,
  type Cursor,
  FetchResultSchema,
  ConnectorError,
  NewsRssConnector,
  categoriesForSource,
  UniSatBrc20Connector,
  EvmFactoryConnector,
  SolanaMintConnector,
  DexScreenerConnector,
} from '@radar/connectors';
import {
  fingerprint,
  inputsForEvent,
  scoreOpportunity,
  scoreRisk,
  stableHash,
  evaluateRule,
  transitionStage,
  canAggregate,
  ScoringConfigSchema,
  DEFAULT_SCORING_CONFIG,
  detectHistoricalSignals,
  detectParticipationWindow,
  type ProjectObservation,
  type HistoricalSignal,
} from '@radar/signals';
import {
  RuleSchema,
  EventSchema,
  ProjectSchema,
  type AlertRule,
  type UserSettings,
  SourceInputSchema,
} from '@radar/shared';
const log = createLogger('worker.pipeline');
export const registry = createRegistry(config);
const json = (data: unknown) => sql.json(data as postgres.JSONValue);
type Tx = TransactionSql;

async function initialAnalysisStatus(): Promise<'PENDING' | 'DISABLED'> {
  if (config.dataMode === 'fixture') return 'PENDING';
  try {
    const ai = await readAIConfig();
    return ai.enabled && ai.apiKey && ai.model ? 'PENDING' : 'DISABLED';
  } catch {
    // Invalid integration secrets must never prevent deterministic event/alert persistence.
    log.warn('AI configuration unavailable; deterministic ingestion continues');
    return 'DISABLED';
  }
}

let sourceSync: Promise<void> | undefined;
let configuredSync: Promise<void> | undefined;
const configuredVersions = new Map<string, string>();
const configuredScopes = new Map<string, string>();
/** Read encrypted server configuration before future tasks; never retain removed credentials. */
export async function synchronizeConfiguredSources() {
  if (config.dataMode !== 'live') return;
  if (configuredSync) return configuredSync;
  configuredSync = (async () => {
    let effective: Awaited<ReturnType<typeof readSourceIntegrationsConfig>>;
    try {
      effective = await readSourceIntegrationsConfig();
    } catch {
      // A lost encryption key must not let stale in-memory credentials continue collecting.
      effective = {
        unisatApiKey: '',
        evmRpcUrl: '',
        solanaRpcUrl: '',
        evmFactoryAddress: '',
        solanaProgramId: '',
        dexChain: 'solana',
        dexTokenAddresses: [],
        configOrigin: 'database',
      };
      log.warn(
        'Source credentials cannot be decrypted; configured collection disabled until repaired',
      );
    }
    const entries: { connector: Connector; version: unknown; scope: unknown }[] = [
      {
        connector: new UniSatBrc20Connector(effective.unisatApiKey),
        version: [effective.unisatApiKey],
        scope: ['unisat-brc20'],
      },
      {
        connector: new EvmFactoryConnector(effective.evmRpcUrl, effective.evmFactoryAddress),
        version: [effective.evmRpcUrl, effective.evmFactoryAddress],
        scope: ['ethereum-mainnet', effective.evmFactoryAddress.toLowerCase()],
      },
      {
        connector: new SolanaMintConnector(effective.solanaRpcUrl, effective.solanaProgramId),
        version: [effective.solanaRpcUrl, effective.solanaProgramId],
        scope: ['solana-mainnet', effective.solanaProgramId],
      },
      {
        connector: new DexScreenerConnector(effective.dexChain, effective.dexTokenAddresses),
        version: [effective.dexChain, effective.dexTokenAddresses],
        scope: [effective.dexChain, effective.dexTokenAddresses],
      },
    ];
    for (const { connector, version, scope } of entries) {
      const id = connector.metadata.id;
      const fingerprint = stableHash(JSON.stringify(version));
      if (configuredVersions.get(id) === fingerprint && registry.get(id)) continue;
      const health = await connector.healthCheck();
      const scopeId = stableHash(JSON.stringify(scope));
      await connector.initialize();
      const old = registry.get(id);
      registry.remove(id);
      registry.register(connector);
      if (old) await old.shutdown();
      const configured = health.status !== 'unconfigured';
      await sql`UPDATE data_sources SET enabled=CASE WHEN NOT ${configured} THEN false WHEN data->>'status'='unconfigured' THEN true ELSE enabled END,last_error=null,data=data || ${json({ keyConfigured: configured, description: health.detail, status: configured ? 'pending' : 'unconfigured', integrationScope: scopeId, cooldownUntil: null })}::jsonb WHERE id=${id} AND mode='live'`;
      configuredVersions.set(id, fingerprint);
      configuredScopes.set(id, scopeId);
    }
  })();
  try {
    await configuredSync;
  } finally {
    configuredSync = undefined;
  }
}
/** Register durable custom sources before schedules are reconciled, without touching evidence rows. */
export async function synchronizeCustomSources() {
  if (config.dataMode !== 'live') return;
  if (sourceSync) return sourceSync;
  sourceSync = (async () => {
    const rows =
      await sql`SELECT id,name,interval_seconds,data FROM data_sources WHERE mode='live' AND data->>'custom'='true'`;
    const retained = new Set<string>();
    for (const row of rows) {
      const id = String(row.id);
      const data = row.data as Record<string, unknown>;
      const input = SourceInputSchema.safeParse(data.feedConfig);
      if (!input.success) {
        await sql`UPDATE data_sources SET enabled=false,last_error='保存的 RSS/Atom 配置无效，请重新添加来源',data=data || '{"status":"unconfigured"}'::jsonb WHERE id=${id} AND mode='live'`;
        log.warn({ sourceId: id }, 'invalid saved feed configuration; source not registered');
        continue;
      }
      retained.add(id);
      if (registry.get(id)) continue;
      const connector = new NewsRssConnector({
        id,
        name: String(row.name),
        feedUrl: input.data.feedUrl,
        categories: input.data.categories,
        pollIntervalSeconds: Math.max(60, Number(row.interval_seconds)),
      });
      await connector.initialize();
      registry.register(connector);
    }
    for (const connector of registry.list()) {
      const id = connector.metadata.id;
      if (id.startsWith('custom-rss-') && !retained.has(id)) {
        await connector.shutdown();
        registry.remove(id);
      }
    }
  })();
  try {
    await sourceSync;
  } finally {
    sourceSync = undefined;
  }
}

export async function initializeSources() {
  const ownerId = await ensureAdmin();
  await synchronizeConfiguredSources();
  await synchronizeCustomSources();
  const registered = registry.list().map((connector) => connector.metadata.id);
  // A custom feed can be created after synchronization's SELECT; preserve its requested
  // enabled state until the next reconcile registers it. Malformed feeds are disabled
  // by synchronizeCustomSources, while old built-in adapters remain unscheduled.
  await sql`UPDATE data_sources SET enabled=false WHERE mode<>${config.dataMode} OR (NOT(id=ANY(${registered}::text[])) AND coalesce(data->>'custom','false')<>'true')`;
  for (const connector of registry.list()) {
    await connector.initialize();
    const health = await connector.healthCheck();
    const meta = connector.metadata;
    const data = {
      description: health.detail,
      docsUrl: meta.officialUrl,
      keyConfigured: health.status !== 'unconfigured',
      capabilities: [connector.capabilities.scope, 'checkpoint'],
      status: health.status === 'unconfigured' ? 'unconfigured' : 'pending',
      delayLabel: `${meta.pollIntervalSeconds}s轮询；来源延迟未知`,
      licenseStatus: meta.licenseStatus,
      categories: categoriesForSource(meta.id, meta.categories),
      ...(connector instanceof NewsRssConnector ? { feedUrl: connector.feed.feedUrl } : {}),
    };
    await sql`INSERT INTO data_sources(id,name,enabled,connector_type,mode,interval_seconds,data) VALUES(${meta.id},${meta.name},${health.status !== 'unconfigured'},${meta.transport},${meta.mode},${meta.pollIntervalSeconds},${json(data)}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mode=excluded.mode,data=data_sources.data || excluded.data`;
  }
  if (config.dataMode === 'fixture') {
    const existing = await sql`SELECT id FROM alert_rules WHERE owner_id=${ownerId}`;
    if (!existing.length) {
      const channels =
        await sql`SELECT id FROM notification_channels WHERE owner_id=${ownerId} AND provider='telegram'`;
      const now = new Date().toISOString();
      const id = randomUUID();
      const rule = RuleSchema.parse({
        id,
        ownerId,
        name: 'Fixture · 高可信事件验证',
        enabled: true,
        conditions: { minConfidence: 0.8, maxRiskScore: 100 },
        priority: 'P2',
        cooldownSeconds: 3600,
        channelIds: channels.map((r) => String(r.id)),
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await sql`INSERT INTO alert_rules(id,owner_id,name,enabled,version,data) VALUES(${id},${ownerId},${rule.name},true,1,${json(rule)}) ON CONFLICT DO NOTHING`;
      await sql`INSERT INTO alert_rule_versions(id,rule_id,version,data) VALUES(${randomUUID()},${id},1,${json(rule)}) ON CONFLICT DO NOTHING`;
    }
  }
}

function observationFrom(
  normalized: NormalizedEvent,
  rawId: string,
  firstSeenAt: string,
  availableAt: string,
): ProjectObservation | null {
  const project = normalized.project;
  if (!project) return null;
  const terms = project as typeof project & { startsAt?: string | null };
  const metrics = normalized.metrics ?? {};
  const observedAt =
    typeof metrics.observedAt === 'string' && Number.isFinite(Date.parse(metrics.observedAt))
      ? metrics.observedAt
      : firstSeenAt;
  const available = new Date(
    Math.max(
      Date.parse(firstSeenAt),
      Date.parse(availableAt),
      Date.parse(normalized.sourcePublishedAt ?? '') || 0,
      Date.parse(observedAt),
    ),
  ).toISOString();
  return {
    evidenceId: rawId,
    sourceId: normalized.sourceId,
    assetKey: project.assetKey,
    dataMode: normalized.dataMode,
    observedAt,
    availableAt: available,
    metrics,
    stage: project.stage,
    verificationStatus: normalized.verificationStatus,
    confidence: normalized.confidence,
    conditionsVerified: normalized.conditionsVerified === true,
    conditions: project.conditions,
    startsAt: terms.startsAt ?? null,
    endsAt: project.endsAt ?? null,
  };
}

function derivedNormalized(normalized: NormalizedEvent, signal: HistoricalSignal): NormalizedEvent {
  return {
    ...normalized,
    eventType: signal.type,
    signalType: signal.type,
    title: signal.type,
    description: signal.reason,
    severity: signal.severity,
    metrics: { ...(normalized.metrics ?? {}), ...signal.metrics },
    riskFlags: [...new Set([...(normalized.riskFlags ?? []), ...signal.riskFlags])],
  };
}
type ScoringConfig = ReturnType<typeof ScoringConfigSchema.parse>;
const criticalFlags = ['PHISHING', 'UNRESTRICTED_MINT', 'LIQUIDITY_REMOVAL'];
function retainedCriticalFlags(data?: Record<string, unknown>) {
  const previousBreakdown = data?.riskBreakdown as { flags?: unknown } | undefined;
  const stored = [data?.criticalRiskFlags, previousBreakdown?.flags]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value): value is string => typeof value === 'string' && criticalFlags.includes(value));
  return [...new Set(stored)];
}
async function persistHistoricalSignal(
  tx: Tx,
  normalized: NormalizedEvent,
  projectId: string,
  historical: HistoricalSignal,
  at: string,
  scoring: ScoringConfig,
  updateProjectSummary = false,
) {
  const derived = {
    ...derivedNormalized(normalized, historical),
    externalId: `history:${historical.stableKey}`,
    identity: historical.stableKey,
    // The detector's conclusion is first known at its processing clock. Its
    // evidence retains each source's publication/measurement timestamps.
    sourcePublishedAt: null,
    eventOccurredAt: null,
  };
  const inputs = inputsForEvent(derived, at);
  const opportunity = scoreOpportunity(inputs.opportunity, scoring.opportunity);
  const risk = scoreRisk(inputs.risk, derived.riskFlags, scoring.risk);
  const eventId = randomUUID();
  const event = {
    ...derived,
    id: eventId,
    firstSeenAt: at,
    collectedAt: at,
    normalizedAt: at,
    detectedAt: at,
    rawDataReference: historical.evidenceIds.at(-1)!,
    fingerprint: `history:${historical.stableKey}`,
    analysisStatus: await initialAnalysisStatus(),
    opportunityScore: opportunity.score,
    riskScore: risk.score,
    opportunityBreakdown: opportunity,
    riskBreakdown: risk,
    riskWarnings: [...risk.flags, ...risk.unknowns.map((key) => `${key}未知`)],
    evidenceIds: historical.evidenceIds,
    algorithmVersion: historical.algorithmVersion,
    createdAt: at,
    updatedAt: at,
  };
  EventSchema.parse(event);
  const inserted =
    await tx`INSERT INTO events(id,fingerprint,source_id,external_id,title,event_type,severity,first_seen_at,data) VALUES(${eventId},${event.fingerprint},${derived.sourceId},${derived.externalId},${event.title},${event.eventType},${event.severity},${at},${json(event)}) ON CONFLICT(fingerprint) DO NOTHING RETURNING id`;
  if (!inserted.length) return false;
  for (const rawId of historical.evidenceIds) {
    await tx`INSERT INTO event_sources(id,event_id,source_id,raw_item_id,url,source_published_at,data) SELECT ${randomUUID()}::uuid,${eventId}::uuid,r.source_id,r.id,${derived.originalUrl},r.published_at,${json({ dataMode: derived.dataMode, derived: true })}::jsonb FROM raw_items r WHERE r.id=${rawId}::uuid ON CONFLICT(event_id,raw_item_id) DO NOTHING`;
  }
  const signalId = randomUUID();
  const signal = {
    id: signalId,
    projectId,
    eventId,
    type: historical.type,
    detectedAt: at,
    opportunityScore: opportunity.score,
    riskScore: risk.score,
    evidenceIds: historical.evidenceIds,
    reason: historical.reason,
    scoringVersion: opportunity.version,
    opportunityBreakdown: opportunity,
    riskBreakdown: risk,
    riskFlags: derived.riskFlags,
    metrics: historical.metrics,
    algorithmVersion: historical.algorithmVersion,
  };
  await tx`INSERT INTO opportunity_signals(id,dedup_key,project_id,event_id,detected_at,data) VALUES(${signalId},${historical.stableKey},${projectId},${eventId},${at},${json(signal)})`;
  await tx`INSERT INTO risk_assessments(id,project_id,event_id,score,version,data) VALUES(${randomUUID()},${projectId},${eventId},${risk.score},${risk.version},${json(risk)})`;
  const participantGrowth =
    historical.type === 'UNIQUE_PARTICIPANTS_SPIKE' &&
    typeof historical.metrics.uniqueParticipants === 'number' &&
    typeof historical.metrics.participantGrowthPct === 'number'
      ? historical.metrics.participantGrowthPct
      : null;
  if (updateProjectSummary && (risk.critical || participantGrowth !== null)) {
    const row = (await tx`SELECT data FROM projects WHERE id=${projectId} FOR UPDATE`)[0];
    if (row) {
      const previous = row.data as Record<string, unknown>;
      const summary: Record<string, unknown> = { ...previous, updatedAt: at };
      if (risk.critical) {
        const flags = [
          ...new Set([
            ...retainedCriticalFlags(previous),
            ...risk.flags.filter((flag) => criticalFlags.includes(flag)),
          ]),
        ];
        const summaryRisk = scoreRisk(
          inputs.risk,
          [...new Set([...risk.flags, ...flags])],
          scoring.risk,
        );
        summaryRisk.score = Math.max(summaryRisk.score, Number(previous.riskScore) || 0);
        Object.assign(summary, {
          riskScore: summaryRisk.score,
          riskFlagged: true,
          riskBreakdown: summaryRisk,
          riskWarnings: [
            ...new Set([
              ...(Array.isArray(previous.riskWarnings) ? previous.riskWarnings : []),
              ...summaryRisk.flags,
              ...summaryRisk.unknowns.map((key) => `${key}未知`),
            ]),
          ],
          criticalRiskFlags: flags,
          criticalRiskDetectedAt: at,
          criticalRiskEvidenceIds: [
            ...new Set([
              ...(Array.isArray(previous.criticalRiskEvidenceIds)
                ? previous.criticalRiskEvidenceIds
                : []),
              ...historical.evidenceIds,
            ]),
          ],
        });
      }
      if (participantGrowth !== null)
        Object.assign(summary, {
          participantGrowthPct: participantGrowth,
          participantGrowthObservedAt: normalized.metrics?.observedAt ?? at,
          participantGrowthEvidenceIds: historical.evidenceIds,
          opportunityScore: opportunity.score,
          opportunityBreakdown: opportunity,
        });
      ProjectSchema.parse(summary);
      await tx`UPDATE projects SET data=${json(summary)},updated_at=${at}::timestamptz WHERE id=${projectId}`;
    }
  }
  await decideNotifications(tx, event, derived, projectId, signalId, at);
  if (event.analysisStatus === 'PENDING')
    await tx`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) VALUES(${randomUUID()},${'analyze:' + eventId},'ANALYZE',${eventId}) ON CONFLICT DO NOTHING`;
  return true;
}
export function quietHours(
  settings: Pick<UserSettings, 'timezone' | 'notifications'>,
  at = new Date(),
) {
  const { quietStart: start, quietEnd: end } = settings.notifications;
  if (start === null || end === null || start === end) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: settings.timezone,
    }).format(at),
  );
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
async function decideNotifications(
  tx: Tx,
  event: Record<string, unknown>,
  normalized: NormalizedEvent,
  projectId: string | null,
  signalId: string | null,
  now: string,
) {
  const rules =
    await tx`SELECT r.data,s.data AS settings FROM alert_rules r LEFT JOIN user_settings s ON s.user_id=r.owner_id WHERE r.enabled=true ORDER BY r.id`;
  for (const row of rules) {
    let rule: AlertRule;
    try {
      rule = RuleSchema.parse(row.data);
    } catch {
      continue;
    }
    const result = evaluateRule(
      rule.conditions,
      {
        ...normalized,
        sourceId: normalized.sourceId,
        firstSeenAt: String(event.firstSeenAt),
        opportunityScore: Number(event.opportunityScore),
        riskScore: Number(event.riskScore),
        stage: normalized.project?.stage,
      },
      Date.parse(now),
    );
    if (!result.matched) continue;
    const settings = row.settings as UserSettings | null;
    const isQuiet = settings ? quietHours(settings, new Date(now)) : false;
    const belowPriority = settings
      ? ['P0', 'P1', 'P2', 'P3'].indexOf(rule.priority) >
        ['P0', 'P1', 'P2', 'P3'].indexOf(settings.notifications.minimumPriority)
      : false;
    const cooldownEntity = projectId ?? String(event.id);
    // Serialize cooldown checks per rule/project across worker replicas.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${rule.id + cooldownEntity}))`;
    const recent =
      await tx`SELECT id FROM alert_triggers WHERE rule_id=${rule.id} AND data->>'cooldownEntity'=${cooldownEntity} AND detected_at > ${new Date(Date.parse(now) - rule.cooldownSeconds * 1000).toISOString()}::timestamptz LIMIT 1`;
    if (recent.length) continue;
    const triggerId = randomUUID();
    const eventId = event.id ? String(event.id) : null;
    // A project observation can produce several independent historical signals;
    // include signal identity so each signal has its own trigger deduplication.
    const triggerKey = stableHash(
      `${rule.id}:${rule.version}:${eventId ?? 'clock'}:${signalId ?? ''}`,
    );
    const triggered =
      await tx`INSERT INTO alert_triggers(id,rule_id,rule_version,event_id,signal_id,dedup_key,data) VALUES(${triggerId},${rule.id},${rule.version},${eventId},${signalId},${triggerKey},${json({ title: event.title, priority: rule.priority, ruleName: rule.name, cooldownEntity, reasons: result.reasons, suppressed: isQuiet ? 'QUIET_HOURS' : belowPriority ? 'MINIMUM_PRIORITY' : null, eventSnapshot: event })}) ON CONFLICT(dedup_key) DO NOTHING RETURNING id`;
    if (!triggered.length || isQuiet || belowPriority) continue;
    for (const channelId of rule.channelIds) {
      const channels =
        await tx`SELECT id FROM notification_channels WHERE id=${channelId} AND owner_id=${rule.ownerId} AND enabled=true`;
      if (!channels.length) continue;
      const id = randomUUID();
      const dedupKey = stableHash(`${triggerKey}:${channelId}`);
      const data = {
        ...event,
        id,
        eventId: event.id,
        channelId,
        title: event.title,
        body: event.description,
        description: event.description,
        priority: rule.priority,
        stage: normalized.project?.stage,
        riskFlags: normalized.riskFlags ?? [],
        templateVersion: 'v1',
        triggerId,
        dataMode: normalized.dataMode,
      };
      const rows =
        await tx`INSERT INTO notifications(id,dedup_key,channel_id,event_id,status,queued_at,data) VALUES(${id},${dedupKey},${channelId},${eventId},'PENDING',${now},${json(data)}) ON CONFLICT(dedup_key) DO NOTHING RETURNING id`;
      if (rows.length)
        await tx`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) VALUES(${randomUUID()},${'notify:' + id},'NOTIFY',${id}) ON CONFLICT(dedup_key) DO NOTHING`;
    }
  }
}
/** Persist one durable raw observation through the same normalization/history
 * path used by ingestion. Exported for the PostgreSQL acceptance fixture, which
 * feeds deterministic snapshots without bypassing worker transactions. */
export async function persistEvent(
  connector: Connector,
  rawId: string,
  firstSeenAt: string,
  item: RawItem,
) {
  let normalized = connector.normalize(item);
  if (normalized.dataMode !== connector.metadata.mode) throw new Error('Connector 数据模式不一致');
  const now = new Date().toISOString();
  if (normalized.eventType === 'MARKET_SNAPSHOT') {
    const value = normalized.metrics?.value;
    const asset = normalized.assets[0];
    const unit = String(normalized.metrics?.unit ?? '');
    const frequency = String(normalized.metrics?.frequency ?? 'tick');
    const sourceDate =
      typeof normalized.metrics?.sourceDate === 'string' ? normalized.metrics.sourceDate : null;
    if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value) || !asset || !unit)
      throw new Error('行情缺少有效值/资产/单位');
    if (!normalized.sourcePublishedAt && (!sourceDate || frequency !== 'daily'))
      throw new Error('行情缺少来源时刻或明确日度数据日期');
    const observedAt = normalized.sourcePublishedAt ?? firstSeenAt;
    const metadata = {
      dataMode: normalized.dataMode,
      originalUrl: normalized.originalUrl,
      sourceUrl: normalized.originalUrl,
      frequency,
      sourceDate,
      precision: normalized.metrics?.precision ?? null,
      publicationTimeKnown: normalized.sourcePublishedAt !== null,
      delayLabel: normalized.metrics?.delayLabel ?? '最新可用成交快照',
      name: normalized.metrics?.name ?? asset,
      rawDataReference: rawId,
    };
    const alreadyObserved =
      await sql`SELECT id FROM market_observations WHERE data->>'rawDataReference'=${rawId} LIMIT 1`;
    if (alreadyObserved.length) return false;
    const prior =
      await sql`SELECT value,data FROM market_observations WHERE asset_key=${asset} AND source_id=${connector.metadata.id} ORDER BY observed_at DESC LIMIT 1`;
    await sql`INSERT INTO market_observations(id,asset_key,source_id,observed_at,value,unit,delay_seconds,data) VALUES(${randomUUID()},${asset},${connector.metadata.id},${observedAt},${value},${unit},${normalized.sourcePublishedAt ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(normalized.sourcePublishedAt)) / 1000)) : null},${json(metadata)}) ON CONFLICT DO NOTHING`;
    // Daily revisions/history are retained without manufacturing intraday discovery or price-change signals.
    if (frequency === 'daily') return false;
    const previous = Number(prior[0]?.value);
    const change = previous > 0 ? ((Number(value) - previous) / previous) * 100 : null;
    if (change === null || Math.abs(change) < 2) return false;
    normalized = {
      ...normalized,
      eventType: 'PRICE_ANOMALY',
      identity: item.externalId,
      title: `${asset} 采样间价格变化 ${change.toFixed(2)}%`,
      metrics: { ...normalized.metrics, priceChangePct: change },
      severity: 'P2',
    };
  }
  const inputs = inputsForEvent(normalized, firstSeenAt);
  const savedScoring = (await sql`SELECT data FROM system_settings WHERE key='scoring-config'`)[0];
  const scoring = savedScoring
    ? ScoringConfigSchema.parse(savedScoring.data)
    : DEFAULT_SCORING_CONFIG;
  const opportunity = scoreOpportunity(inputs.opportunity, scoring.opportunity);
  const risk = scoreRisk(inputs.risk, normalized.riskFlags, scoring.risk);
  let hash = fingerprint(normalized);
  // Bounded candidate search only aggregates compatible asset identities and timestamps.
  const candidates =
    await sql`SELECT fingerprint,data FROM events WHERE event_type=${normalized.eventType} AND first_seen_at > now()-interval '1 hour' ORDER BY first_seen_at DESC LIMIT 100`;
  for (const candidate of candidates)
    if (
      canAggregate(
        normalized,
        candidate.data as NormalizedEvent & { title: string; sourcePublishedAt: string | null },
      )
    ) {
      hash = String(candidate.fingerprint);
      break;
    }
  const eventId = randomUUID();
  const event = {
    ...normalized,
    id: eventId,
    firstSeenAt,
    collectedAt: now,
    normalizedAt: now,
    detectedAt: now,
    rawDataReference: rawId,
    fingerprint: hash,
    analysisStatus: await initialAnalysisStatus(),
    opportunityScore: opportunity.score,
    riskScore: risk.score,
    riskWarnings: [...risk.flags, ...risk.unknowns.map((key) => `${key}未知`)],
    opportunityBreakdown: opportunity,
    riskBreakdown: risk,
    createdAt: now,
    updatedAt: now,
  };
  EventSchema.parse(event);
  return await sql.begin(async (tx) => {
    const observation = observationFrom(normalized, rawId, firstSeenAt, now);
    let previousProject: Record<string, unknown> | undefined;
    if (normalized.project) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`project:${normalized.dataMode}:${normalized.project.assetKey}`}))`;
      previousProject = (
        await tx`SELECT id,stage,data,first_seen_at,updated_at FROM projects WHERE asset_key=${normalized.project.assetKey} FOR UPDATE`
      )[0];
      // Keep the raw evidence, but a first snapshot from a future measurement
      // or publication time cannot establish today's project/event summary.
      if (!previousProject && observation && Date.parse(observation.availableAt) > Date.parse(now))
        return false;
    }
    const inserted =
      await tx`INSERT INTO events(id,fingerprint,source_id,external_id,title,event_type,severity,first_seen_at,data) VALUES(${eventId},${hash},${connector.metadata.id},${item.externalId},${event.title},${event.eventType},${event.severity},${firstSeenAt},${json(event)}) ON CONFLICT(fingerprint) DO NOTHING RETURNING id`;
    const id = inserted[0]
      ? eventId
      : String((await tx`SELECT id FROM events WHERE fingerprint=${hash}`)[0]!.id);
    await tx`INSERT INTO event_sources(id,event_id,source_id,raw_item_id,url,source_published_at,data) VALUES(${randomUUID()},${id},${connector.metadata.id},${rawId},${normalized.originalUrl},${normalized.sourcePublishedAt},${json({ title: normalized.title, observedAt: firstSeenAt, verificationStatus: normalized.verificationStatus, dataMode: normalized.dataMode })}) ON CONFLICT(event_id,raw_item_id) DO NOTHING`;
    if (!inserted.length) return false;
    let projectId: string | null = null;
    if (normalized.project) {
      const p = normalized.project;
      const old = previousProject;
      projectId = old ? String(old.id) : randomUUID();
      const oldData = old?.data as Record<string, unknown> | undefined;
      if (oldData?.dataMode && oldData.dataMode !== normalized.dataMode)
        throw new Error('项目资产标识跨数据模式冲突，禁止覆盖历史事实');
      let latestObservedAt =
        typeof oldData?.latestObservedAt === 'string' &&
        Number.isFinite(Date.parse(oldData.latestObservedAt))
          ? oldData.latestObservedAt
          : null;
      if (old && !latestObservedAt) {
        const knownMetric = (
          await tx`SELECT observed_at FROM project_metrics WHERE project_id=${projectId} AND observed_at<=${now}::timestamptz AND coalesce(data->>'availableAt',observed_at::text)::timestamptz<=${now}::timestamptz ORDER BY observed_at DESC LIMIT 1`
        )[0];
        if (knownMetric)
          latestObservedAt = new Date(knownMetric.observed_at as string).toISOString();
        else {
          const fallbackTimes = [
            oldData?.updatedAt,
            oldData?.firstSeenAt,
            old.updated_at,
            old.first_seen_at,
          ]
            .map((value) =>
              value instanceof Date
                ? value.getTime()
                : typeof value === 'string'
                  ? Date.parse(value)
                  : NaN,
            )
            .filter((value) => Number.isFinite(value) && value <= Date.parse(now));
          if (fallbackTimes.length)
            latestObservedAt = new Date(Math.max(...fallbackTimes)).toISOString();
        }
      }
      const isLatest =
        (!observation || Date.parse(observation.availableAt) <= Date.parse(now)) &&
        (!latestObservedAt ||
          !observation ||
          Date.parse(observation.observedAt) >= Date.parse(latestObservedAt));
      const effectiveStage = isLatest ? p.stage : String(old?.stage ?? p.stage);
      if (old && String(old.stage) !== effectiveStage)
        transitionStage(String(old.stage), effectiveStage, [rawId]);
      // An unknown fresh snapshot is not evidence that a confirmed critical
      // risk has ended. Keep its flags and floor until an explicit, evidenced
      // resolution workflow exists.
      const confirmedCritical = [
        ...new Set([
          ...retainedCriticalFlags(oldData),
          ...risk.flags.filter((flag) => criticalFlags.includes(flag)),
        ]),
      ];
      const projectRisk = scoreRisk(
        inputs.risk,
        [...new Set([...risk.flags, ...confirmedCritical])],
        scoring.risk,
      );
      if (confirmedCritical.length)
        projectRisk.score = Math.max(projectRisk.score, Number(oldData?.riskScore) || 0);
      const project = {
        ...p,
        stage: effectiveStage,
        id: projectId,
        verificationStatus: isLatest
          ? normalized.verificationStatus
          : (oldData?.verificationStatus ?? normalized.verificationStatus),
        riskFlagged: confirmedCritical.length > 0 || projectRisk.score >= 60,
        watching: true,
        firstSeenAt: oldData?.firstSeenAt ?? firstSeenAt,
        opportunityScore: opportunity.score,
        riskScore: projectRisk.score,
        participants:
          normalized.metrics?.uniqueParticipants ?? normalized.metrics?.participants ?? null,
        participantGrowthPct:
          normalized.metrics?.participantGrowthPct ?? oldData?.participantGrowthPct ?? null,
        participantGrowthObservedAt: oldData?.participantGrowthObservedAt ?? null,
        participantGrowthEvidenceIds: oldData?.participantGrowthEvidenceIds ?? [],
        mintProgress:
          typeof normalized.metrics?.mintProgress === 'number'
            ? normalized.metrics.mintProgress
            : null,
        conditionsVerified: isLatest
          ? normalized.conditionsVerified === true
          : oldData?.conditionsVerified === true,
        latestObservedAt: isLatest
          ? (observation?.observedAt ?? latestObservedAt)
          : latestObservedAt,
        sourceUrls: [
          ...new Set([...((oldData?.sourceUrls as string[]) ?? []), normalized.originalUrl]),
        ],
        dataMode: normalized.dataMode,
        opportunityBreakdown: opportunity,
        riskBreakdown: projectRisk,
        riskWarnings: [...projectRisk.flags, ...projectRisk.unknowns.map((key) => `${key}未知`)],
        criticalRiskFlags: confirmedCritical,
        criticalRiskDetectedAt: oldData?.criticalRiskDetectedAt ?? (risk.critical ? now : null),
        criticalRiskEvidenceIds: oldData?.criticalRiskEvidenceIds ?? (risk.critical ? [rawId] : []),
        updatedAt: now,
      };
      const currentProject = isLatest
        ? project
        : { ...project, ...oldData, latestObservedAt, sourceUrls: project.sourceUrls };
      ProjectSchema.parse(currentProject);
      await tx`INSERT INTO projects(id,asset_key,stage,chain,first_seen_at,data) VALUES(${projectId},${p.assetKey},${effectiveStage},${p.chain},${String(project.firstSeenAt)},${json(currentProject)}) ON CONFLICT(asset_key) DO UPDATE SET stage=excluded.stage,data=excluded.data,updated_at=now()`;
      if (!old || String(old.stage) !== effectiveStage)
        await tx`INSERT INTO project_lifecycle_events(id,project_id,from_stage,to_stage,reason,evidence_ids,occurred_at) VALUES(${randomUUID()},${projectId},${old ? String(old.stage) : null},${effectiveStage},${'证据支持的阶段：' + normalized.title},${json([rawId])},${now})`;
      if (!old && normalized.eventType === 'TOKEN_STATE_SNAPSHOT' && p.protocol === 'BRC-20')
        await persistHistoricalSignal(
          tx,
          normalized,
          projectId,
          {
            type: 'NEW_TOKEN_DEPLOYED',
            stableKey: stableHash(
              `history-v1:${normalized.dataMode}:${normalized.sourceId}:${p.assetKey}:first-discovery`,
            ),
            reason:
              '首次观察到索引器中的部署候选；真实链上部署时刻另记，官方身份与参与条件仍须核验。',
            evidenceIds: [rawId],
            metrics: {},
            riskFlags: [],
            severity: 'P2',
            algorithmVersion: 'history-v1',
          },
          now,
          scoring,
          isLatest,
        );
      if (observation) {
        const metricData = {
          ...(normalized.metrics ?? {}),
          availableAt: observation.availableAt,
          evidenceId: observation.evidenceId,
          __observation: {
            stage: observation.stage,
            verificationStatus: observation.verificationStatus,
            confidence: observation.confidence,
            conditionsVerified: observation.conditionsVerified,
            conditions: observation.conditions,
            startsAt: observation.startsAt,
            endsAt: observation.endsAt,
            event: normalized,
          },
        };
        await tx`INSERT INTO project_metrics(id,project_id,source_id,observed_at,data) VALUES(${randomUUID()},${projectId},${connector.metadata.id},${observation.observedAt},${json(metricData)}) ON CONFLICT DO NOTHING`;
        const metricRows =
          await tx`SELECT observed_at,data FROM project_metrics WHERE project_id=${projectId} AND source_id=${connector.metadata.id} ORDER BY observed_at DESC LIMIT 100`;
        const history: ProjectObservation[] = metricRows.map((row) => {
          const data = (row.data ?? {}) as Record<string, unknown>;
          const metadata = (data.__observation ?? {}) as Record<string, unknown>;
          const metricValues = { ...data };
          delete metricValues.availableAt;
          delete metricValues.evidenceId;
          delete metricValues.__observation;
          return {
            evidenceId: String(data.evidenceId ?? `${connector.metadata.id}:${row.observed_at}`),
            sourceId: connector.metadata.id,
            assetKey: p.assetKey,
            dataMode: normalized.dataMode,
            observedAt: new Date(row.observed_at as string).toISOString(),
            availableAt:
              typeof data.availableAt === 'string' ? data.availableAt : observation.availableAt,
            metrics: metricValues,
            stage: String(metadata.stage ?? p.stage),
            verificationStatus: String(
              metadata.verificationStatus ?? normalized.verificationStatus,
            ),
            confidence: Number(metadata.confidence ?? normalized.confidence),
            conditionsVerified: Object.prototype.hasOwnProperty.call(metadata, 'conditionsVerified')
              ? metadata.conditionsVerified === true
              : normalized.conditionsVerified === true,
            conditions: Object.prototype.hasOwnProperty.call(metadata, 'conditions')
              ? typeof metadata.conditions === 'string'
                ? metadata.conditions
                : null
              : p.conditions,
            startsAt: Object.prototype.hasOwnProperty.call(metadata, 'startsAt')
              ? typeof metadata.startsAt === 'string'
                ? metadata.startsAt
                : null
              : null,
            endsAt: Object.prototype.hasOwnProperty.call(metadata, 'endsAt')
              ? typeof metadata.endsAt === 'string'
                ? metadata.endsAt
                : null
              : null,
          };
        });
        const current = history.find((entry) => entry.evidenceId === rawId) ?? observation;
        const derived = [
          ...detectHistoricalSignals(current, history, now),
          ...(isLatest ? detectParticipationWindow(current, now) : []),
        ];
        for (const historical of derived)
          await persistHistoricalSignal(
            tx,
            normalized,
            projectId,
            historical,
            now,
            scoring,
            isLatest,
          );
      }
    }
    let signalId: string | null = null;
    if (normalized.signalType) {
      signalId = randomUUID();
      const signal = {
        id: signalId,
        projectId,
        eventId,
        type: normalized.signalType,
        detectedAt: now,
        opportunityScore: opportunity.score,
        riskScore: risk.score,
        evidenceIds: [rawId],
        reason: normalized.description,
        scoringVersion: opportunity.version,
      };
      await tx`INSERT INTO opportunity_signals(id,dedup_key,project_id,event_id,detected_at,data) VALUES(${signalId},${stableHash(hash + normalized.signalType)},${projectId},${eventId},${now},${json(signal)}) ON CONFLICT(dedup_key) DO NOTHING`;
    }
    await tx`INSERT INTO risk_assessments(id,project_id,event_id,score,version,data) VALUES(${randomUUID()},${projectId},${eventId},${risk.score},${risk.version},${json(risk)})`;
    await decideNotifications(tx, event, normalized, projectId, signalId, now);
    if (event.analysisStatus === 'PENDING')
      await tx`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) VALUES(${randomUUID()},${'analyze:' + eventId},'ANALYZE',${eventId}) ON CONFLICT DO NOTHING`;
    return true;
  });
}
export async function runIngestion(sourceId: string) {
  // PostgreSQL also serializes a source if Redis loses a lease or is restarted.
  // The session is reserved so acquisition and release use the same connection.
  const lease = await sql.reserve();
  const lockKey = `source:${config.dataMode}:${sourceId}`;
  try {
    const locked = await lease`SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS acquired`;
    if (!locked[0]?.acquired) return { fetched: 0, inserted: 0, skipped: true };
    try {
      return await runIngestionUnlocked(sourceId);
    } finally {
      await lease`SELECT pg_advisory_unlock(hashtext(${lockKey}))`;
    }
  } finally {
    lease.release();
  }
}
async function runIngestionUnlocked(sourceId: string) {
  await synchronizeConfiguredSources();
  const source = (await sql`SELECT enabled,mode,data FROM data_sources WHERE id=${sourceId}`)[0];
  if (!source?.enabled || source.mode !== config.dataMode)
    return { fetched: 0, inserted: 0, skipped: true };
  const connector = registry.get(sourceId);
  const integrationScope = configuredScopes.get(sourceId);
  // Old queue entries may outlive a disabled/removed/malformed source configuration.
  if (!connector) return { fetched: 0, inserted: 0, skipped: true };
  const cooldownUntil = (source.data as Record<string, unknown>)?.cooldownUntil;
  if (typeof cooldownUntil === 'string' && Date.parse(cooldownUntil) > Date.now())
    return { fetched: 0, inserted: 0, skipped: true };
  const runId = randomUUID();
  const started = Date.now();
  await sql`INSERT INTO ingestion_runs(id,source_id,status) VALUES(${runId},${sourceId},'RUNNING')`;
  try {
    const checkpoint = (
      await sql`SELECT cursor FROM source_checkpoints WHERE source_id=${sourceId}`
    )[0];
    const savedCursor = checkpoint?.cursor as Cursor | undefined;
    const cursor =
      integrationScope && savedCursor?._integrationScope !== integrationScope
        ? undefined
        : savedCursor;
    // Change-only adapters must finish a durable batch before fetching again:
    // after a partial failure, upstream may already have reverted to a state
    // that the old committed cursor would otherwise suppress.
    const retainsBatch = connector instanceof UniSatBrc20Connector;
    const pending = retainsBatch
      ? (
          await sql`SELECT integration_scope,data FROM source_pending_batches WHERE source_id=${sourceId}`
        )[0]
      : undefined;
    const fetched =
      pending && pending.integration_scope === (integrationScope ?? null)
        ? FetchResultSchema.parse(pending.data)
        : await connector.fetch(cursor);
    if (integrationScope) fetched.cursor._integrationScope = integrationScope;
    if (retainsBatch)
      await sql`INSERT INTO source_pending_batches(source_id,integration_scope,data) VALUES(${sourceId},${integrationScope ?? null},${json(fetched)}) ON CONFLICT(source_id) DO UPDATE SET integration_scope=excluded.integration_scope,data=excluded.data,created_at=now()`;
    let inserted = 0;
    const orderedItems = [...fetched.items].sort((a, b) => {
      const aObserved =
        typeof a.payload.observedAt === 'string'
          ? a.payload.observedAt
          : typeof a.payload.observed_at === 'string'
            ? a.payload.observed_at
            : typeof a.payload.timestamp === 'string'
              ? a.payload.timestamp
              : null;
      const bObserved =
        typeof b.payload.observedAt === 'string'
          ? b.payload.observedAt
          : typeof b.payload.observed_at === 'string'
            ? b.payload.observed_at
            : typeof b.payload.timestamp === 'string'
              ? b.payload.timestamp
              : null;
      const aTime = Date.parse(aObserved ?? a.publishedAt ?? '') || 0;
      const bTime = Date.parse(bObserved ?? b.publishedAt ?? '') || 0;
      return aTime - bTime || a.externalId.localeCompare(b.externalId);
    });
    for (const item of orderedItems) {
      const now = new Date().toISOString();
      // Raw storage is committed before normalization, including malformed items for investigation.
      await sql`INSERT INTO raw_items(id,source_id,external_id,payload,published_at,first_seen_at,collected_at) VALUES(${randomUUID()},${sourceId},${item.externalId},${json(item.payload)},${item.publishedAt},${now},${now}) ON CONFLICT(source_id,external_id) DO NOTHING`;
      const raw = (
        await sql`SELECT id,first_seen_at,payload,published_at FROM raw_items WHERE source_id=${sourceId} AND external_id=${item.externalId}`
      )[0]!;
      if (
        await persistEvent(
          connector,
          String(raw.id),
          new Date(raw.first_seen_at as string).toISOString(),
          {
            externalId: item.externalId,
            payload: raw.payload as RawItem['payload'],
            publishedAt: raw.published_at
              ? new Date(raw.published_at as string).toISOString()
              : null,
          },
        )
      )
        inserted++;
    }
    const recovery =
      connector instanceof SolanaMintConnector
        ? (fetched.cursor.solanaRecovery as { phase?: string } | undefined)
        : undefined;
    const healthStatus = recovery ? 'degraded' : 'healthy';
    const healthDetail = recovery
      ? `Solana 历史补偿中（${recovery.phase === 'scan' ? '扫描缺口' : '回放交易'}）；尚未追平，检查点不越过未处理交易`
      : null;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO source_checkpoints(source_id,cursor) VALUES(${sourceId},${json(fetched.cursor)}) ON CONFLICT(source_id) DO UPDATE SET cursor=excluded.cursor,committed_at=now()`;
      if (retainsBatch) await tx`DELETE FROM source_pending_batches WHERE source_id=${sourceId}`;
      await tx`UPDATE ingestion_runs SET status='COMPLETED',fetched=${orderedItems.length},inserted=${inserted},finished_at=now() WHERE id=${runId}`;
      await tx`UPDATE data_sources SET last_success_at=CASE WHEN ${Boolean(recovery)} THEN last_success_at ELSE now() END,last_error=${healthDetail},next_poll_at=now()+interval_seconds*interval '1 second',data=data || ${json({ status: healthStatus, cooldownUntil: null })}::jsonb WHERE id=${sourceId}`;
      await tx`INSERT INTO source_health_records(id,source_id,status,latency_ms,error) VALUES(${randomUUID()},${sourceId},${healthStatus},${Date.now() - started},${healthDetail})`;
    });
    log.info({ sourceId, runId, fetched: orderedItems.length, inserted }, 'ingestion completed');
    return { fetched: orderedItems.length, inserted, skipped: false };
  } catch (error) {
    const summary = error instanceof Error ? error.message.slice(0, 300) : '采集失败';
    await sql`UPDATE ingestion_runs SET status='FAILED',error=${summary},finished_at=now() WHERE id=${runId}`;
    const cooldown =
      error instanceof ConnectorError && error.retryAfterMs > 0
        ? new Date(Date.now() + error.retryAfterMs).toISOString()
        : null;
    await sql`UPDATE data_sources SET last_error=${summary},next_poll_at=coalesce(${cooldown}::timestamptz,next_poll_at),data=data || ${json({ status: 'degraded', cooldownUntil: cooldown })}::jsonb WHERE id=${sourceId}`;
    await sql`INSERT INTO source_health_records(id,source_id,status,latency_ms,error) VALUES(${randomUUID()},${sourceId},'degraded',${Date.now() - started},${summary})`;
    throw error;
  }
}

/** Evaluate verified participation terms from the latest persisted observation.
 * This is deliberately clock-driven: it runs even when no source has emitted a
 * new raw item, and it never changes the project's lifecycle stage. */
export async function scanParticipationWindows(
  at = new Date().toISOString(),
  sourceIds?: readonly string[],
) {
  if (!Number.isFinite(Date.parse(at))) throw new Error('窗口检测时钟无效');
  const projects =
    await sql`SELECT id,asset_key FROM projects WHERE data->>'dataMode'=${config.dataMode} ORDER BY asset_key`;
  const saved = (await sql`SELECT data FROM system_settings WHERE key='scoring-config'`)[0];
  const scoring = saved ? ScoringConfigSchema.parse(saved.data) : DEFAULT_SCORING_CONFIG;
  let detected = 0;
  for (const project of projects) {
    detected += await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`project:${config.dataMode}:${project.asset_key}`}))`;
      // Re-read under the same project lock as ingestion. A newer revocation of
      // verified terms therefore supersedes the older participation window.
      const row = (
        await tx`
        SELECT m.source_id,m.observed_at,m.data,r.external_id,r.payload,p.data AS project_data
        FROM project_metrics m
        JOIN projects p ON p.id=m.project_id
        JOIN data_sources s ON s.id=m.source_id AND s.mode=${config.dataMode} AND s.enabled=true
        JOIN raw_items r ON r.id::text=m.data->>'evidenceId'
        WHERE m.project_id=${String(project.id)} AND p.data->>'dataMode'=${config.dataMode}
          AND m.observed_at<=${at}::timestamptz
          AND coalesce(m.data->>'availableAt',m.observed_at::text)::timestamptz<=${at}::timestamptz
          AND (${sourceIds === undefined} OR m.source_id=ANY(${sourceIds ? [...sourceIds] : []}::text[]))
        ORDER BY m.observed_at DESC,m.source_id LIMIT 1`
      )[0];
      if (!row) return 0;
      const data = row.data as Record<string, unknown>;
      const metadata = (data.__observation ?? {}) as Record<string, unknown>;
      // Old deployments without an immutable normalized observation must wait
      // for a fresh source observation; project DTOs cannot verify old terms.
      const normalized = metadata.event as NormalizedEvent | undefined;
      if (
        !normalized?.project ||
        normalized.dataMode !== config.dataMode ||
        normalized.sourceId !== row.source_id
      )
        return 0;
      const observation: ProjectObservation = {
        evidenceId: String(data.evidenceId),
        sourceId: String(row.source_id),
        assetKey: String(project.asset_key),
        dataMode: config.dataMode,
        observedAt: new Date(row.observed_at as string).toISOString(),
        availableAt: String(data.availableAt),
        metrics: normalized.metrics ?? {},
        stage: String(metadata.stage),
        verificationStatus: String(metadata.verificationStatus),
        confidence: Number(metadata.confidence),
        conditionsVerified: metadata.conditionsVerified === true,
        conditions: typeof metadata.conditions === 'string' ? metadata.conditions : null,
        startsAt: typeof metadata.startsAt === 'string' ? metadata.startsAt : null,
        endsAt: typeof metadata.endsAt === 'string' ? metadata.endsAt : null,
      };
      let inserted = 0;
      for (const historical of detectParticipationWindow(observation, at))
        if (
          await persistHistoricalSignal(tx, normalized, String(project.id), historical, at, scoring)
        )
          inserted++;
      return inserted;
    });
  }
  return detected;
}
