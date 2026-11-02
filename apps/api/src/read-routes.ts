import { sql } from '@radar/database';
import { config } from '@radar/config';
import {
  EventSchema,
  ProjectSchema,
  SignalSchema,
  DashboardSchema,
  SourceSchema,
  SourceIdSchema,
  MarketSchema,
  PaginationSchema,
  DataModeSchema,
} from '@radar/shared';
import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { addRoute, fail, idParam, meta, type ApiContext, type ApiEnv } from './http.js';
import { redis } from './security.js';
const date = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
function page(c: ApiContext) {
  return PaginationSchema.parse(c.req.query());
}
export async function eventById(id: string) {
  const rows = await sql<
    { data: unknown }[]
  >`SELECT data FROM events WHERE id=${id} AND data->>'dataMode'=${config.dataMode}`;
  if (!rows[0]) fail(404, '事件不存在');
  return EventSchema.parse(rows[0].data);
}
export async function projectById(id: string) {
  const rows = await sql<
    { data: unknown }[]
  >`SELECT data FROM projects WHERE id=${id} AND data->>'dataMode'=${config.dataMode}`;
  if (!rows[0]) fail(404, '项目不存在');
  return ProjectSchema.parse(rows[0].data);
}
export function readRoutes(app: OpenAPIHono<ApiEnv>) {
  addRoute(app, 'get', '/api/v1/events', '事件流', z.array(EventSchema), async (c) => {
    const p = page(c);
    const q = z
      .string()
      .max(200)
      .parse(c.req.query('q') ?? '');
    const asset = c.req.query('asset');
    const category = c.req.query('category');
    const severity = c.req.query('priority');
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (severity) z.enum(['P0', 'P1', 'P2', 'P3']).parse(severity);
    if (from) z.iso.datetime({ offset: true }).parse(from);
    if (to) z.iso.datetime({ offset: true }).parse(to);
    const where = sql`data->>'dataMode'=${config.dataMode} AND (${!q} OR title ILIKE ${'%' + q + '%'} OR data->>'description' ILIKE ${'%' + q + '%'}) AND (${!asset} OR data->'assets' ? ${asset ?? ''}) AND (${!category} OR data->'categories' ? ${category ?? ''}) AND (${!severity} OR severity=${severity ?? ''}) AND (${!from} OR first_seen_at>=${from ?? '1970-01-01T00:00:00Z'}::timestamptz) AND (${!to} OR first_seen_at<=${to ?? '9999-01-01T00:00:00Z'}::timestamptz)`;
    const [rows, count] = await Promise.all([
      sql<
        { data: unknown }[]
      >`SELECT data FROM events WHERE ${where} ORDER BY first_seen_at DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
      sql<{ n: string }[]>`SELECT count(*) n FROM events WHERE ${where}`,
    ]);
    return {
      data: rows.map((r) => EventSchema.parse(r.data)),
      meta: meta(Number(count[0]!.n), p.page, p.pageSize),
    };
  });
  addRoute(app, 'get', '/api/v1/events/{id}', '事件详情', EventSchema, async (c) => ({
    data: await eventById(idParam(c)),
  }));
  addRoute(
    app,
    'get',
    '/api/v1/events/{id}/sources',
    '事件证据来源',
    z.array(
      z.object({
        id: z.string(),
        sourceId: z.string(),
        rawItemId: z.string(),
        url: z.string().nullable(),
        sourcePublishedAt: z.string().nullable(),
        firstSeenAt: z.string().nullable(),
        collectedAt: z.string().nullable(),
        payload: z.unknown(),
      }),
    ),
    async (c) => {
      const id = idParam(c);
      await eventById(id);
      const rows =
        await sql`SELECT es.*,r.payload,r.first_seen_at,r.collected_at FROM event_sources es JOIN raw_items r ON r.id=es.raw_item_id WHERE es.event_id=${id} AND EXISTS(SELECT 1 FROM data_sources s WHERE s.id=es.source_id AND s.mode=${config.dataMode}) ORDER BY r.first_seen_at`;
      return {
        data: rows.map((r) => ({
          id: r.id,
          sourceId: r.source_id,
          rawItemId: r.raw_item_id,
          url: r.url,
          sourcePublishedAt: date(r.source_published_at),
          firstSeenAt: date(r.first_seen_at),
          collectedAt: date(r.collected_at),
          payload: r.payload,
        })),
      };
    },
  );
  addRoute(app, 'get', '/api/v1/projects', '早期机会项目', z.array(ProjectSchema), async (c) => {
    const p = page(c);
    const verified = c.req.query('verified');
    if (verified) z.enum(['true', 'false']).parse(verified);
    const risk = c.req.query('risk');
    if (risk) z.enum(['true', 'false']).parse(risk);
    const chain = c.req.query('chain'),
      stage = c.req.query('stage'),
      q = z
        .string()
        .max(200)
        .parse(c.req.query('q') ?? '');
    const where = sql`data->>'dataMode'=${config.dataMode} AND (${!chain} OR chain=${chain ?? ''}) AND (${!stage} OR stage=${stage ?? ''}) AND (${!q} OR data->>'name' ILIKE ${'%' + q + '%'} OR asset_key ILIKE ${'%' + q + '%'}) AND (${!verified} OR (data->>'verificationStatus'='VERIFIED')=${verified === 'true'}) AND (${!risk} OR (data->>'riskFlagged')::boolean=${risk === 'true'})`;
    const [rows, count] = await Promise.all([
      sql<
        { data: unknown }[]
      >`SELECT data FROM projects WHERE ${where} ORDER BY first_seen_at DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
      sql<{ n: string }[]>`SELECT count(*) n FROM projects WHERE ${where}`,
    ]);
    return {
      data: rows.map((r) => ProjectSchema.parse(r.data)),
      meta: meta(Number(count[0]!.n), p.page, p.pageSize),
    };
  });
  addRoute(app, 'get', '/api/v1/projects/{id}', '项目详情', ProjectSchema, async (c) => ({
    data: await projectById(idParam(c)),
  }));
  addRoute(
    app,
    'get',
    '/api/v1/projects/{id}/timeline',
    '项目生命周期历史',
    z.array(
      z.object({
        id: z.string(),
        fromStage: z.string().nullable(),
        toStage: z.string(),
        reason: z.string(),
        evidenceIds: z.array(z.string()),
        occurredAt: z.string(),
        recordedAt: z.string(),
      }),
    ),
    async (c) => {
      const id = idParam(c);
      await projectById(id);
      const rows =
        await sql`SELECT * FROM project_lifecycle_events WHERE project_id=${id} ORDER BY occurred_at`;
      return {
        data: rows.map((r) => ({
          id: r.id,
          fromStage: r.from_stage,
          toStage: r.to_stage,
          reason: r.reason,
          evidenceIds: r.evidence_ids,
          occurredAt: date(r.occurred_at),
          recordedAt: date(r.recorded_at),
        })),
      };
    },
  );
  addRoute(
    app,
    'get',
    '/api/v1/projects/{id}/signals',
    '项目独立信号',
    z.array(SignalSchema),
    async (c) => {
      const id = idParam(c);
      await projectById(id);
      const rows = await sql<
        { data: unknown }[]
      >`SELECT os.data FROM opportunity_signals os WHERE os.project_id=${id} AND EXISTS(SELECT 1 FROM events e WHERE e.id=os.event_id AND e.data->>'dataMode'=${config.dataMode}) ORDER BY detected_at DESC`;
      return { data: rows.map((r) => SignalSchema.parse(r.data)) };
    },
  );
  addRoute(app, 'get', '/api/v1/sources', '数据源健康', z.array(SourceSchema), async () => {
    const rows = await sources();
    return { data: rows, meta: meta(rows.length, 1, 100) };
  });
  addRoute(app, 'get', '/api/v1/sources/{id}', '数据源详情', SourceSchema, async (c) => {
    const id = SourceIdSchema.parse(c.req.param('id'));
    const result = (await sources()).find((s) => s.id === id);
    if (!result) fail(404, '数据源不存在');
    return { data: result };
  });
  addRoute(
    app,
    'get',
    '/api/v1/sources/{id}/health',
    '数据源健康历史',
    z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        latencyMs: z.number().nullable(),
        error: z.string().nullable(),
        observedAt: z.string(),
      }),
    ),
    async (c) => {
      const id = SourceIdSchema.parse(c.req.param('id'));
      if (!(await sources()).some((source) => source.id === id)) fail(404, '数据源不存在');
      const p = page(c);
      const rows =
        await sql`SELECT * FROM source_health_records WHERE source_id=${id} ORDER BY observed_at DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`;
      return {
        data: rows.map((r) => ({
          id: r.id,
          status: r.status,
          latencyMs: r.latency_ms,
          error: r.error,
          observedAt: date(r.observed_at),
        })),
      };
    },
  );
  addRoute(
    app,
    'get',
    '/api/v1/markets/assets',
    '最新可用行情（含来源和延迟）',
    z.array(MarketSchema),
    async () => {
      const rows =
        await sql`SELECT DISTINCT ON(asset_key) * FROM market_observations WHERE data->>'dataMode'=${config.dataMode} ORDER BY asset_key,data->>'sourceDate' DESC NULLS LAST,observed_at DESC`;
      const names: Record<string, string> = {
        BTC: '比特币',
        ETH: '以太坊',
        XAU: '现货黄金',
        WTI: 'WTI 原油',
        US2Y: '美国2年期国债',
        US10Y: '美国10年期国债',
        US30Y: '美国30年期国债',
      };
      const values = rows.map((r) =>
        MarketSchema.parse({
          ...r.data,
          asset: r.asset_key,
          name: names[String(r.asset_key)] ?? r.data?.name ?? r.asset_key,
          value: Number(r.value),
          unit: r.unit,
          changePct: r.data?.changePct ?? null,
          sourceId: r.source_id,
          observedAt: date(r.observed_at),
          delaySeconds: r.delay_seconds,
          dataMode: r.data?.dataMode ?? config.dataMode,
        }),
      );
      for (const asset of Object.keys(names))
        if (!values.some((v) => v.asset === asset))
          values.push(
            MarketSchema.parse({
              asset,
              name: names[asset],
              value: null,
              unit: asset.startsWith('US') ? '%' : 'USD',
              changePct: null,
              sourceId: 'unconfigured',
              observedAt: null,
              delaySeconds: null,
              dataMode: config.dataMode,
            }),
          );
      return { data: values };
    },
  );
  addRoute(
    app,
    'get',
    '/api/v1/markets/history',
    '历史观测（不插值）',
    z.array(
      z.object({
        observedAt: z.string(),
        value: z.number(),
        sourceId: z.string(),
        unit: z.string(),
        delaySeconds: z.number().nullable(),
        dataMode: DataModeSchema,
        frequency: z.string().optional(),
        sourceDate: z.string().nullable().optional(),
        publicationTimeKnown: z.boolean().optional(),
        delayLabel: z.string().optional(),
        sourceUrl: z.string().optional(),
      }),
    ),
    async (c) => {
      const asset = z.string().min(1).max(100).parse(c.req.query('asset'));
      const from = c.req.query('from');
      const to = c.req.query('to');
      if (from) z.iso.datetime({ offset: true }).parse(from);
      if (to) z.iso.datetime({ offset: true }).parse(to);
      if (from && to && Date.parse(from) > Date.parse(to)) fail(400, '开始时间不能晚于结束时间');
      const rows = await sql`WITH samples AS (
          SELECT DISTINCT ON(source_id,coalesce(data->>'sourceDate',observed_at::text)) *,
            CASE WHEN data->>'frequency'='daily' AND data->>'sourceDate' IS NOT NULL
              THEN ((data->>'sourceDate')::date::timestamp AT TIME ZONE 'UTC') ELSE observed_at END AS period_at
          FROM market_observations WHERE asset_key=${asset} AND data->>'dataMode'=${config.dataMode}
          ORDER BY source_id,coalesce(data->>'sourceDate',observed_at::text),observed_at DESC
        ) SELECT * FROM (SELECT * FROM samples WHERE period_at>=${from ?? '1970-01-01T00:00:00Z'}::timestamptz AND period_at<=${to ?? '9999-01-01T00:00:00Z'}::timestamptz ORDER BY period_at DESC LIMIT 1000) t ORDER BY period_at`;
      return {
        data: rows.map((r) => ({
          ...r.data,
          observedAt: date(r.observed_at),
          value: Number(r.value),
          sourceId: r.source_id,
          unit: r.unit,
          delaySeconds: r.delay_seconds,
          dataMode: r.data?.dataMode ?? config.dataMode,
        })),
      };
    },
  );
  addRoute(app, 'get', '/api/v1/dashboard', '监控总览', DashboardSchema, async () => {
    const [counts, recentEvents, recentProjects, recentAlerts, sourceData, heartbeat, trend] =
      await Promise.all([
        sql`SELECT (SELECT count(*) FROM raw_items r JOIN data_sources s ON s.id=r.source_id WHERE s.mode=${config.dataMode} AND r.collected_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') collected,(SELECT count(*) FROM events WHERE data->>'dataMode'=${config.dataMode} AND first_seen_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') events,(SELECT count(*) FROM projects WHERE data->>'dataMode'=${config.dataMode} AND first_seen_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') projects,(SELECT count(*) FROM alert_triggers a JOIN events e ON e.id=a.event_id WHERE e.data->>'dataMode'=${config.dataMode} AND a.detected_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND a.data->>'priority' IN ('P0','P1')) alerts,(SELECT count(*) FROM notifications WHERE status IN ('SENT','FAILED','RETRYING') AND data->>'dataMode'='live' AND data->>'dataMode'=${config.dataMode} AND queued_at>=date_trunc('day',now())) notices,(SELECT count(*) FROM notifications WHERE status='SENT' AND data->>'dataMode'='live' AND data->>'dataMode'=${config.dataMode} AND queued_at>=date_trunc('day',now())) sent`,
        sql<
          { data: unknown }[]
        >`SELECT data FROM events WHERE data->>'dataMode'=${config.dataMode} ORDER BY first_seen_at DESC LIMIT 6`,
        sql<
          { data: unknown }[]
        >`SELECT data FROM projects WHERE data->>'dataMode'=${config.dataMode} ORDER BY first_seen_at DESC LIMIT 5`,
        sql`SELECT a.* FROM alert_triggers a JOIN events e ON e.id=a.event_id WHERE e.data->>'dataMode'=${config.dataMode} ORDER BY a.detected_at DESC LIMIT 5`,
        sources(),
        sql`SELECT data FROM system_settings WHERE key='worker:heartbeat'`,
        sql`WITH buckets AS (SELECT date_trunc('hour',first_seen_at) bucket,count(*) events,0::bigint signals FROM events WHERE data->>'dataMode'=${config.dataMode} AND first_seen_at>now()-interval '24 hour' GROUP BY 1 UNION ALL SELECT date_trunc('hour',detected_at) bucket,0::bigint events,count(*) signals FROM opportunity_signals os WHERE EXISTS(SELECT 1 FROM events e WHERE e.id=os.event_id AND e.data->>'dataMode'=${config.dataMode}) AND detected_at>now()-interval '24 hour' GROUP BY 1) SELECT to_char(bucket AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:00:00"Z"') time,sum(events) events,sum(signals) signals FROM buckets GROUP BY bucket ORDER BY bucket`,
      ]);
    const count = counts[0]!;
    const hb = heartbeat[0]?.data as
      | { timestamp?: string; at?: string; mode?: string; version?: string; commitSha?: string }
      | undefined;
    const t = hb?.timestamp ?? hb?.at;
    const latency = await latencyStats();
    return {
      data: {
        onlineSources: sourceData.filter((s) => s.status === 'healthy').length,
        totalSources: sourceData.length,
        collectedToday: Number(count.collected),
        eventsToday: Number(count.events),
        projectsToday: Number(count.projects),
        highPriorityAlerts: Number(count.alerts),
        notificationSuccessRate: Number(count.notices)
          ? (Number(count.sent) / Number(count.notices)) * 100
          : null,
        recentEvents: recentEvents.map((r) => EventSchema.parse(r.data)),
        recentProjects: recentProjects.map((r) => ProjectSchema.parse(r.data)),
        recentAlerts: recentAlerts.map((r) => ({
          ...r.data,
          id: r.id,
          detectedAt: date(r.detected_at),
        })),
        workerOnline:
          hb?.mode === config.dataMode &&
          hb.version === config.version &&
          hb.commitSha === config.commitSha &&
          !!t &&
          Date.now() - Date.parse(t) < 120000,
        dataMode: config.dataMode,
        asOf: new Date().toISOString(),
        latency,
        trend: trend.map((r) => ({
          time: r.time,
          events: Number(r.events),
          signals: Number(r.signals),
        })),
      },
    };
  });
  addRoute(
    app,
    'get',
    '/api/v1/system/status',
    '系统版本与依赖状态',
    z.object({
      version: z.string(),
      commitSha: z.string(),
      dataMode: DataModeSchema,
      asOf: z.string(),
      worker: z.object({ online: z.boolean(), lastHeartbeat: z.string().nullable() }),
      queues: z.record(z.string(), z.number().nullable()),
      ai: z.object({
        configured: z.boolean(),
        provider: z.string(),
        model: z.string(),
        dailyBudgetUsd: z.number(),
        usage: z.object({
          calls: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          estimatedCost: z.number(),
        }),
      }),
      keys: z.record(z.string(), z.boolean()),
      latency: z.object({
        p50Ms: z.number().nullable(),
        p95Ms: z.number().nullable(),
        samples: z.number(),
      }),
    }),
    async () => {
      const [hb, usage, queues] = await Promise.all([
        sql`SELECT data FROM system_settings WHERE key='worker:heartbeat'`,
        sql`SELECT count(*) calls,coalesce(sum(input_tokens),0) input_tokens,coalesce(sum(output_tokens),0) output_tokens,coalesce(sum(estimated_cost),0) estimated_cost FROM ai_analysis_runs WHERE (provider='fixture')=${config.dataMode === 'fixture'} AND created_at>=date_trunc('day',now())`,
        queueCounts(),
      ]);
      const t = hb[0]?.data?.timestamp ?? hb[0]?.data?.at ?? null;
      const u = usage[0]!;
      return {
        data: {
          version: config.version,
          commitSha: config.commitSha,
          dataMode: config.dataMode,
          asOf: new Date().toISOString(),
          worker: {
            online:
              hb[0]?.data?.mode === config.dataMode &&
              hb[0]?.data?.version === config.version &&
              hb[0]?.data?.commitSha === config.commitSha &&
              !!t &&
              Date.now() - Date.parse(t) < 120000,
            lastHeartbeat: t,
          },
          queues,
          ai: {
            configured: !!config.aiApiKey && !!config.aiModel,
            provider:
              config.dataMode === 'fixture'
                ? 'fixture'
                : config.aiApiKey
                  ? 'openai-compatible'
                  : 'disabled',
            model:
              config.dataMode === 'fixture' ? 'fixture-evidence-v1' : config.aiModel || '未配置',
            dailyBudgetUsd: config.aiDailyBudgetUsd,
            usage: {
              calls: Number(u.calls),
              inputTokens: Number(u.input_tokens),
              outputTokens: Number(u.output_tokens),
              estimatedCost: Number(u.estimated_cost),
            },
          },
          keys: {
            telegram: !!config.telegramBotToken && !!config.telegramChatId,
            github: !!config.githubToken,
            unisat: !!config.unisatApiKey,
            evmRpc: !!config.evmRpcUrl,
            solanaRpc: !!config.solanaRpcUrl,
          },
          latency: await latencyStats(),
        },
      };
    },
  );
  addRoute(
    app,
    'get',
    '/api/v1/system/latency',
    '各处理阶段真实延迟分位数',
    z.array(
      z.object({
        stage: z.string(),
        p50Ms: z.number().nullable(),
        p95Ms: z.number().nullable(),
        samples: z.number(),
      }),
    ),
    async () => ({ data: await stageLatency() }),
  );
  addRoute(
    app,
    'get',
    '/api/v1/system/logs',
    '脱敏操作审计',
    z.array(
      z.object({
        id: z.string(),
        action: z.string(),
        entityType: z.string(),
        entityId: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    async (c) => {
      const p = page(c);
      const rows =
        await sql`SELECT id,action,entity_type,entity_id,created_at FROM audit_logs WHERE actor_id=${c.get('actor').id} ORDER BY created_at DESC LIMIT ${p.pageSize}`;
      return {
        data: rows.map((r) => ({
          id: r.id,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          createdAt: date(r.created_at),
        })),
      };
    },
  );
}
export async function sources() {
  const rows =
    await sql`SELECT s.*,h.status,h.latency_ms,(SELECT avg(CASE WHEN lower(hh.status)='healthy' THEN 1.0 ELSE 0 END) FROM source_health_records hh WHERE hh.source_id=s.id AND hh.observed_at>now()-interval '24 hour') success_rate FROM data_sources s LEFT JOIN LATERAL(SELECT status,latency_ms FROM source_health_records WHERE source_id=s.id ORDER BY observed_at DESC LIMIT 1) h ON true WHERE s.mode=${config.dataMode} ORDER BY s.id`;
  return rows.map((r) =>
    SourceSchema.parse({
      ...r.data,
      id: r.id,
      name: r.name,
      connectorType: r.connector_type,
      mode: r.mode,
      enabled: r.enabled,
      status: !r.enabled
        ? 'disabled'
        : String(r.status ?? r.data?.status ?? 'unknown').toLowerCase(),
      intervalSeconds: r.interval_seconds,
      lastSuccessAt: date(r.last_success_at),
      lastError: r.last_error,
      nextPollAt: date(r.next_poll_at),
      successRate: r.success_rate == null ? null : Number(r.success_rate),
      latencyMs: r.latency_ms ?? null,
      freshnessSeconds: r.last_success_at
        ? Math.max(0, (Date.now() - new Date(r.last_success_at).getTime()) / 1000)
        : null,
    }),
  );
}
async function latencyStats() {
  const rows =
    await sql`SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM(first_seen_at-(data->>'sourcePublishedAt')::timestamptz))*1000) p50,percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM(first_seen_at-(data->>'sourcePublishedAt')::timestamptz))*1000) p95,count(*) samples FROM events WHERE data->>'dataMode'=${config.dataMode} AND data->>'sourcePublishedAt' IS NOT NULL AND first_seen_at>=(data->>'sourcePublishedAt')::timestamptz`;
  const r = rows[0]!;
  return {
    p50Ms: r.p50 == null ? null : Number(r.p50),
    p95Ms: r.p95 == null ? null : Number(r.p95),
    samples: Number(r.samples),
  };
}
async function queueCounts(): Promise<Record<string, number | null>> {
  try {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
    const [waiting, active, failed, delayed] = await Promise.all([
      redis.llen('bull:financial-radar:wait'),
      redis.llen('bull:financial-radar:active'),
      redis.zcard('bull:financial-radar:failed'),
      redis.zcard('bull:financial-radar:delayed'),
    ]);
    return { waiting, active, failed, delayed };
  } catch {
    return { waiting: null, active: null, failed: null, delayed: null };
  }
}

async function stageLatency() {
  const rows = await sql`WITH timings AS (
 SELECT 'discovery' stage,extract(epoch FROM(first_seen_at-(data->>'sourcePublishedAt')::timestamptz))*1000 ms FROM events WHERE data->>'dataMode'=${config.dataMode} AND data->>'sourcePublishedAt' IS NOT NULL
 UNION ALL SELECT 'normalization',extract(epoch FROM((data->>'normalizedAt')::timestamptz-first_seen_at))*1000 FROM events WHERE data->>'dataMode'=${config.dataMode} AND data->>'normalizedAt' IS NOT NULL
 UNION ALL SELECT 'detection',extract(epoch FROM((data->>'detectedAt')::timestamptz-(data->>'normalizedAt')::timestamptz))*1000 FROM events WHERE data->>'dataMode'=${config.dataMode} AND data->>'detectedAt' IS NOT NULL AND data->>'normalizedAt' IS NOT NULL
 UNION ALL SELECT 'queue',extract(epoch FROM(a.started_at-n.queued_at))*1000 FROM notification_attempts a JOIN notifications n ON n.id=a.notification_id WHERE n.data->>'dataMode'='live' AND n.data->>'dataMode'=${config.dataMode}
 UNION ALL SELECT 'delivery',extract(epoch FROM(a.finished_at-a.started_at))*1000 FROM notification_attempts a JOIN notifications n ON n.id=a.notification_id WHERE a.outcome='SENT' AND a.finished_at IS NOT NULL AND n.data->>'dataMode'='live' AND n.data->>'dataMode'=${config.dataMode}
 UNION ALL SELECT 'endToEnd',extract(epoch FROM(n.accepted_at-(e.data->>'sourcePublishedAt')::timestamptz))*1000 FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.accepted_at IS NOT NULL AND e.data->>'sourcePublishedAt' IS NOT NULL AND n.data->>'dataMode'='live' AND n.data->>'dataMode'=${config.dataMode}
 ) SELECT stage,percentile_cont(0.5) WITHIN GROUP(ORDER BY ms) p50,percentile_cont(0.95) WITHIN GROUP(ORDER BY ms) p95,count(*) samples FROM timings WHERE ms>=0 GROUP BY stage`;
  return ['discovery', 'normalization', 'detection', 'queue', 'delivery', 'endToEnd'].map(
    (stage) => {
      const r = rows.find((x) => x.stage === stage);
      return {
        stage,
        p50Ms: r?.p50 == null ? null : Number(r.p50),
        p95Ms: r?.p95 == null ? null : Number(r.p95),
        samples: Number(r?.samples ?? 0),
      };
    },
  );
}
