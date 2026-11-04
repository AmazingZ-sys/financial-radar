import { randomUUID } from 'node:crypto';
import {
  sql,
  notificationConfigView,
  saveNotificationConfig,
  readNotificationConfig,
} from '@radar/database';
import { config, assertPublicHttpsUrl } from '@radar/config';
import {
  RuleSchema,
  RuleInputSchema,
  RuleConditionsSchema,
  SettingsSchema,
  NotificationSchema,
  NotificationConfigViewSchema,
  NotificationConfigPatchSchema,
  PaginationSchema,
  SourceIdSchema,
  MarketSourceMinimumIntervals,
} from '@radar/shared';
import { evaluateRule, replay, type RuleEvent } from '@radar/signals';
import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { addRoute, body, fail, idParam, meta, type ApiContext, type ApiEnv } from './http.js';
import { audit, rateLimit } from './security.js';
import { sources } from './read-routes.js';
const date = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const Ok = z.object({ ok: z.boolean() });
async function ruleById(c: ApiContext, id: string) {
  const rows = await sql<
    { data: unknown }[]
  >`SELECT data FROM alert_rules WHERE id=${id} AND owner_id=${c.get('actor').id}`;
  if (!rows[0]) fail(404, '规则不存在');
  return RuleSchema.parse(rows[0].data);
}
export function writeRoutes(app: OpenAPIHono<ApiEnv>) {
  addRoute(app, 'get', '/api/v1/alert-rules', '规则列表', z.array(RuleSchema), async (c) => {
    const rows = await sql<
      { data: unknown }[]
    >`SELECT data FROM alert_rules WHERE owner_id=${c.get('actor').id} AND coalesce((data->>'deleted')::boolean,false)=false ORDER BY created_at DESC`;
    return { data: rows.map((r) => RuleSchema.parse(r.data)), meta: meta(rows.length, 1, 100) };
  });
  addRoute(
    app,
    'post',
    '/api/v1/alert-rules',
    '新建规则',
    RuleSchema,
    async (c) => {
      const input = await body(c, RuleInputSchema);
      await validateChannels(c, input.channelIds);
      const now = new Date().toISOString();
      const rule = RuleSchema.parse({
        ...input,
        id: randomUUID(),
        ownerId: c.get('actor').id,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await sql.begin(async (tx) => {
        await tx`INSERT INTO alert_rules(id,owner_id,name,enabled,version,data) VALUES(${rule.id},${rule.ownerId},${rule.name},${rule.enabled},1,${tx.json(rule)})`;
        await tx`INSERT INTO alert_rule_versions(id,rule_id,version,data) VALUES(${randomUUID()},${rule.id},1,${tx.json(rule)})`;
      });
      await audit(c, rule.ownerId, 'CREATE', 'alert_rule', rule.id);
      return { data: rule };
    },
    { body: RuleInputSchema },
  );
  const PatchRule = RuleInputSchema.partial();
  addRoute(
    app,
    'patch',
    '/api/v1/alert-rules/{id}',
    '更新规则并保留版本',
    RuleSchema,
    async (c) => {
      const id = idParam(c);
      const patch = await body(c, PatchRule);
      if (patch.channelIds) await validateChannels(c, patch.channelIds);
      const next = await sql.begin(async (tx) => {
        const rows = await tx<
          { data: unknown }[]
        >`SELECT data FROM alert_rules WHERE id=${id} AND owner_id=${c.get('actor').id} FOR UPDATE`;
        if (!rows[0]) fail(404, '规则不存在');
        const old = RuleSchema.parse(rows[0].data);
        const rule = RuleSchema.parse({
          ...old,
          ...patch,
          version: old.version + 1,
          updatedAt: new Date().toISOString(),
        });
        await tx`UPDATE alert_rules SET name=${rule.name},enabled=${rule.enabled},version=${rule.version},data=${tx.json(rule)},updated_at=now() WHERE id=${id}`;
        await tx`INSERT INTO alert_rule_versions(id,rule_id,version,data) VALUES(${randomUUID()},${id},${rule.version},${tx.json(rule)})`;
        return rule;
      });
      await audit(c, c.get('actor').id, 'UPDATE', 'alert_rule', id);
      return { data: next };
    },
    { body: PatchRule },
  );
  addRoute(app, 'delete', '/api/v1/alert-rules/{id}', '删除规则（保留触发审计）', Ok, async (c) => {
    const id = idParam(c);
    const old = await ruleById(c, id);
    const data = {
      ...old,
      enabled: false,
      deleted: true,
      updatedAt: new Date().toISOString(),
      version: old.version + 1,
    };
    await sql.begin(async (tx) => {
      await tx`UPDATE alert_rules SET enabled=false,version=${data.version},data=${tx.json(data)},updated_at=now() WHERE id=${id} AND owner_id=${c.get('actor').id}`;
      await tx`INSERT INTO alert_rule_versions(id,rule_id,version,data) VALUES(${randomUUID()},${id},${data.version},${tx.json(data)})`;
    });
    await audit(c, c.get('actor').id, 'DELETE', 'alert_rule', id);
    return { data: { ok: true } };
  });
  const TestRule = z
    .object({
      ruleId: z.uuid().optional(),
      eventId: z.uuid().optional(),
      conditions: RuleConditionsSchema.optional(),
    })
    .strict();
  addRoute(
    app,
    'post',
    '/api/v1/alert-rules/test',
    '测试规则（不发通知）',
    z.object({ matched: z.boolean(), reasons: z.array(z.string()) }),
    async (c) => {
      const input = await body(c, TestRule);
      const rule = input.ruleId ? await ruleById(c, input.ruleId) : null;
      const conditions = input.conditions ?? rule?.conditions ?? {};
      let eventId = input.eventId;
      if (!eventId) {
        const latest = await sql<
          { id: string }[]
        >`SELECT id FROM events WHERE data->>'dataMode'=${config.dataMode} ORDER BY first_seen_at DESC LIMIT 1`;
        eventId = latest[0]?.id;
      }
      if (!eventId) return { data: { matched: false, reasons: ['尚无事件可测试，请先运行采集'] } };
      const rows = await sql<
        { data: RuleEvent }[]
      >`SELECT data FROM events WHERE id=${eventId} AND data->>'dataMode'=${config.dataMode}`;
      if (!rows[0]) fail(404, '事件不存在');
      return { data: evaluateRule(conditions, rows[0].data) };
    },
    { body: TestRule },
  );
  addRoute(
    app,
    'get',
    '/api/v1/alerts',
    '规则触发记录',
    z.array(
      z.object({
        id: z.string(),
        ruleId: z.string(),
        ruleVersion: z.number(),
        eventId: z.string().nullable(),
        detectedAt: z.string(),
        reason: z.unknown(),
        priority: z.string().nullable(),
      }),
    ),
    async (c) => {
      const p = PaginationSchema.parse(c.req.query());
      const rows =
        await sql`SELECT a.* FROM alert_triggers a JOIN alert_rules r ON r.id=a.rule_id JOIN events e ON e.id=a.event_id WHERE e.data->>'dataMode'=${config.dataMode} AND r.owner_id=${c.get('actor').id} ORDER BY a.detected_at DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`;
      const count =
        await sql`SELECT count(*) n FROM alert_triggers a JOIN alert_rules r ON r.id=a.rule_id JOIN events e ON e.id=a.event_id WHERE e.data->>'dataMode'=${config.dataMode} AND r.owner_id=${c.get('actor').id}`;
      return {
        data: rows.map((r) => ({
          id: r.id,
          ruleId: r.rule_id,
          ruleVersion: r.rule_version,
          eventId: r.event_id,
          detectedAt: date(r.detected_at),
          reason: r.data?.reason ?? r.data?.reasons ?? null,
          priority: r.data?.priority ?? null,
        })),
        meta: meta(Number(count[0]!.n), p.page, p.pageSize),
      };
    },
  );
  addRoute(
    app,
    'patch',
    '/api/v1/sources/{id}',
    '启用或调整数据源',
    z.unknown(),
    async (c) => {
      const id = SourceIdSchema.parse(c.req.param('id'));
      const input = await body(
        c,
        z
          .object({
            enabled: z.boolean().optional(),
            intervalSeconds: z.number().int().min(10).max(86400).optional(),
          })
          .strict(),
      );
      const existing =
        await sql`SELECT * FROM data_sources WHERE id=${id} AND mode=${config.dataMode}`;
      if (!existing[0]) fail(404, '数据源不存在');
      const minimumInterval = MarketSourceMinimumIntervals[id];
      if (
        input.intervalSeconds !== undefined &&
        minimumInterval &&
        input.intervalSeconds < minimumInterval
      )
        fail(400, `该行情来源的轮询间隔不能低于 ${minimumInterval} 秒`);
      if (
        input.intervalSeconds !== undefined &&
        input.intervalSeconds < 60 &&
        (existing[0].data?.custom === true ||
          existing[0].data?.feedUrl ||
          /rss/i.test(id) ||
          /rss|atom/i.test(String(existing[0].connector_type)))
      )
        fail(400, 'RSS/Atom 订阅的轮询间隔不能低于 60 秒');
      await sql`UPDATE data_sources SET enabled=${input.enabled ?? existing[0].enabled},interval_seconds=${input.intervalSeconds ?? existing[0].interval_seconds},updated_at=now() WHERE id=${id}`;
      await audit(c, c.get('actor').id, 'UPDATE', 'source', id, input);
      return { data: (await sources()).find((s) => s.id === id) };
    },
    {
      body: z
        .object({
          enabled: z.boolean().optional(),
          intervalSeconds: z.number().int().min(10).max(86400).optional(),
        })
        .strict(),
    },
  );
  addRoute(
    app,
    'get',
    '/api/v1/notification-channels',
    '通知渠道与安全配置状态',
    z.array(NotificationConfigViewSchema),
    async (c) => {
      const rows =
        await sql`SELECT id,name,provider,enabled,data FROM notification_channels WHERE owner_id=${c.get('actor').id} ORDER BY provider`;
      return {
        data: rows.map((row) =>
          notificationConfigView({
            id: String(row.id),
            name: String(row.name),
            provider: String(row.provider),
            enabled: Boolean(row.enabled),
            data: row.data,
          }),
        ),
        meta: meta(rows.length, 1, 100),
      };
    },
  );
  addRoute(
    app,
    'patch',
    '/api/v1/notification-channels/{id}',
    '保存通知渠道配置',
    NotificationConfigViewSchema,
    async (c) => {
      await rateLimit(c, 'integration-config', 30, 300);
      const id = idParam(c);
      const input = await body(c, NotificationConfigPatchSchema);
      const row = (
        await sql`SELECT provider FROM notification_channels WHERE id=${id} AND owner_id=${c.get('actor').id}`
      )[0];
      if (!row) fail(404, '渠道不存在');
      if (
        (row.provider !== 'telegram' && (input.botToken || input.chatId)) ||
        (row.provider !== 'feishu' && input.webhookUrl) ||
        (row.provider !== 'bark' && input.serverUrl) ||
        (row.provider !== 'email' &&
          (input.smtpHost ||
            input.smtpPort ||
            input.smtpSecurity ||
            input.smtpUsername ||
            input.smtpPassword ||
            input.fromEmail ||
            input.toEmails))
      )
        fail(400, '凭据字段与通知渠道类型不匹配');
      if (input.botToken && !/^[a-zA-Z0-9:_-]+$/.test(input.botToken))
        fail(400, 'Telegram Bot Token 格式无效');
      if (
        input.webhookUrl &&
        !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(
          input.webhookUrl,
        )
      )
        fail(400, '飞书需要官方机器人 Webhook 地址');
      if (input.serverUrl && new URL(input.serverUrl).pathname === '/')
        fail(400, 'Bark 需要包含设备 Key 的完整 HTTPS 地址');
      if (
        input.smtpHost &&
        !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(input.smtpHost)
      )
        fail(400, 'SMTP 主机名格式无效');
      if (input.smtpUsername && /[\r\n]/.test(input.smtpUsername))
        fail(400, 'SMTP 用户名不得包含换行');
      if (input.smtpPassword && /[\r\n]/.test(input.smtpPassword))
        fail(400, 'SMTP 密码不得包含换行');
      for (const endpoint of [input.webhookUrl, input.serverUrl])
        if (endpoint) {
          try {
            await assertPublicHttpsUrl(endpoint);
          } catch {
            fail(400, '通知地址必须是可解析的公开 HTTPS 地址');
          }
        }
      const data = await saveNotificationConfig(c.get('actor').id, id, input);
      if (!data) fail(404, '渠道不存在');
      await audit(c, c.get('actor').id, 'UPDATE', 'notification_channel', id, {
        fields: Object.keys(input),
        enabled: data.enabled,
      });
      return { data };
    },
    { body: NotificationConfigPatchSchema },
  );
  addRoute(
    app,
    'post',
    '/api/v1/notification-channels/test',
    '发送手动测试通知',
    z.object({ id: z.uuid(), status: z.literal('PENDING') }),
    async (c) => {
      await rateLimit(c, 'notification-test', 5, 300);
      const input = await body(c, z.object({ channelId: z.uuid() }).strict());
      const channels =
        await sql`SELECT * FROM notification_channels WHERE id=${input.channelId} AND owner_id=${c.get('actor').id}`;
      const channel = channels[0];
      if (!channel) fail(404, '渠道不存在');
      if (!channel.enabled) fail(409, '渠道已禁用');
      if (
        config.dataMode !== 'fixture' &&
        !readNotificationConfig(String(channel.provider), channel.data).configured
      )
        fail(409, '渠道凭据尚未配置，请先保存渠道配置');
      const id = randomUUID();
      const now = new Date().toISOString();
      const data = {
        id,
        channelId: channel.id,
        eventId: null,
        title: 'Financial Radar · 渠道连接测试',
        body: '这是一条用户手动发起的渠道测试；平台接口接受不代表已阅读。',
        priority: 'P3',
        dataMode: config.dataMode,
        manualTest: true,
        queuedAt: now,
        status: 'PENDING',
        attempts: 0,
        acceptedAt: null,
        lastError: null,
      };
      await sql.begin(async (tx) => {
        await tx`INSERT INTO notifications(id,dedup_key,channel_id,status,data) VALUES(${id},${'manual:' + id},${channel.id},'PENDING',${tx.json(data)})`;
        await tx`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) VALUES(${randomUUID()},${'manual:' + id},'NOTIFY',${id})`;
      });
      await audit(c, c.get('actor').id, 'TEST', 'notification_channel', channel.id);
      return { data: { id, status: 'PENDING' } };
    },
    { body: z.object({ channelId: z.uuid() }).strict(), status: 202 },
  );
  addRoute(
    app,
    'get',
    '/api/v1/notifications',
    '通知投递历史',
    z.array(NotificationSchema),
    async (c) => {
      const p = PaginationSchema.parse(c.req.query());
      const status = c.req.query('status');
      if (status)
        z.enum(['PENDING', 'SENDING', 'SENT', 'FAILED', 'RETRYING', 'CANCELLED']).parse(status);
      const where = sql`n.data->>'dataMode'=${config.dataMode} AND ch.owner_id=${c.get('actor').id} AND (${!status} OR n.status=${status ?? ''})`;
      const [rows, count] = await Promise.all([
        sql`SELECT n.* FROM notifications n JOIN notification_channels ch ON ch.id=n.channel_id WHERE ${where} ORDER BY n.queued_at DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
        sql`SELECT count(*) n FROM notifications n JOIN notification_channels ch ON ch.id=n.channel_id WHERE ${where}`,
      ]);
      return {
        data: rows.map((r) =>
          NotificationSchema.parse({
            ...r.data,
            id: r.id,
            channelId: r.channel_id,
            eventId: r.event_id,
            status: r.status,
            attempts: r.attempts,
            queuedAt: date(r.queued_at),
            acceptedAt: date(r.accepted_at),
            lastError: r.last_error,
          }),
        ),
        meta: meta(Number(count[0]!.n), p.page, p.pageSize),
      };
    },
  );
  addRoute(
    app,
    'post',
    '/api/v1/notifications/{id}/retry',
    '重试失败通知',
    z.object({ id: z.uuid(), status: z.literal('PENDING') }),
    async (c) => {
      const id = idParam(c);
      const rows =
        await sql`UPDATE notifications n SET status='PENDING',next_attempt_at=now(),last_error=null WHERE n.id=${id} AND n.data->>'dataMode'=${config.dataMode} AND n.status IN ('FAILED','RETRYING') AND EXISTS(SELECT 1 FROM notification_channels ch WHERE ch.id=n.channel_id AND ch.owner_id=${c.get('actor').id} AND ch.enabled=true) RETURNING n.id`;
      if (!rows[0]) fail(409, '通知不存在、渠道禁用或状态不允许重试');
      await sql`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) VALUES(${randomUUID()},${'retry:' + id + ':' + Date.now()},'NOTIFY',${id})`;
      await audit(c, c.get('actor').id, 'RETRY', 'notification', id);
      return { data: { id, status: 'PENDING' } };
    },
    { status: 202 },
  );
  addRoute(app, 'get', '/api/v1/settings', '用户偏好', SettingsSchema, async (c) => {
    const rows = await sql`SELECT data FROM user_settings WHERE user_id=${c.get('actor').id}`;
    return { data: SettingsSchema.parse(rows[0]?.data ?? {}) };
  });
  addRoute(
    app,
    'patch',
    '/api/v1/settings',
    '保存用户偏好',
    SettingsSchema,
    async (c) => {
      const patch = await body(c, SettingsSchema.partial().strict());
      const rows = await sql`SELECT data FROM user_settings WHERE user_id=${c.get('actor').id}`;
      const merged = SettingsSchema.parse({ ...rows[0]?.data, ...patch });
      await sql`INSERT INTO user_settings(user_id,data) VALUES(${c.get('actor').id},${sql.json(merged)}) ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`;
      return { data: merged };
    },
    { body: SettingsSchema.partial().strict() },
  );
  const Watchlist = z.object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.string(),
    items: z.array(z.object({ id: z.uuid(), assetKey: z.string(), createdAt: z.string() })),
  });
  addRoute(app, 'get', '/api/v1/watchlists', '观察列表', z.array(Watchlist), async (c) => {
    const rows =
      await sql`SELECT * FROM watchlists WHERE owner_id=${c.get('actor').id} ORDER BY created_at`;
    const items =
      await sql`SELECT wi.* FROM watchlist_items wi JOIN watchlists w ON w.id=wi.watchlist_id WHERE w.owner_id=${c.get('actor').id}`;
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: date(r.created_at),
        items: items
          .filter((i) => i.watchlist_id === r.id)
          .map((i) => ({ id: i.id, assetKey: i.asset_key, createdAt: date(i.created_at) })),
      })),
    };
  });
  addRoute(
    app,
    'post',
    '/api/v1/watchlists',
    '新建观察列表',
    Watchlist,
    async (c) => {
      const input = await body(c, z.object({ name: z.string().trim().min(1).max(100) }).strict());
      const id = randomUUID();
      const rows =
        await sql`INSERT INTO watchlists(id,owner_id,name) VALUES(${id},${c.get('actor').id},${input.name}) RETURNING created_at`;
      return { data: { id, name: input.name, createdAt: date(rows[0]!.created_at), items: [] } };
    },
    { body: z.object({ name: z.string().min(1).max(100) }).strict() },
  );
  addRoute(
    app,
    'post',
    '/api/v1/watchlists/{id}/items',
    '添加观察资产',
    Ok,
    async (c) => {
      const id = idParam(c);
      const input = await body(
        c,
        z.object({ assetKey: z.string().trim().min(1).max(200) }).strict(),
      );
      await ownsWatchlist(c, id);
      await sql`INSERT INTO watchlist_items(id,watchlist_id,asset_key) VALUES(${randomUUID()},${id},${input.assetKey}) ON CONFLICT(watchlist_id,asset_key) DO NOTHING`;
      return { data: { ok: true } };
    },
    { body: z.object({ assetKey: z.string().min(1).max(200) }).strict() },
  );
  addRoute(
    app,
    'delete',
    '/api/v1/watchlists/{id}/items/{assetKey}',
    '移除观察资产',
    Ok,
    async (c) => {
      const id = idParam(c);
      await ownsWatchlist(c, id);
      const asset = z.string().max(200).parse(c.req.param('assetKey'));
      await sql`DELETE FROM watchlist_items WHERE watchlist_id=${id} AND asset_key=${asset}`;
      return { data: { ok: true } };
    },
  );
  const ReplayInput = z
    .object({ at: z.iso.datetime({ offset: true }), conditions: RuleConditionsSchema.default({}) })
    .strict();
  addRoute(
    app,
    'post',
    '/api/v1/replay',
    '历史信号回放（非收益回测）',
    z.unknown(),
    async (c) => {
      const input = await body(c, ReplayInput);
      const rows = await sql<
        { id: string; data: RuleEvent }[]
      >`SELECT id,data FROM events WHERE data->>'dataMode'=${config.dataMode} ORDER BY first_seen_at LIMIT 1000`;
      const evidence = rows.map((r) => {
        const snapshot = r.data as RuleEvent & {
          sourcePublishedAt?: string | null;
          collectedAt?: string;
        };
        const availableAt = new Date(
          Math.max(
            Date.parse(snapshot.firstSeenAt),
            snapshot.sourcePublishedAt ? Date.parse(snapshot.sourcePublishedAt) : 0,
            snapshot.collectedAt ? Date.parse(snapshot.collectedAt) : 0,
          ),
        ).toISOString();
        return { id: r.id, availableAt, event: r.data };
      });
      const result = replay(evidence, input.conditions, input.at);
      await audit(c, c.get('actor').id, 'REPLAY', 'events', null, {
        at: input.at,
        samples: rows.length,
      });
      return {
        data: {
          ...result,
          dataMode: config.dataMode,
          limitedTo: 1000,
          limitations: [...result.limitations, '仅重放存储的当时证据；未重建 ORDI 完整历史。'],
        },
      };
    },
    { body: ReplayInput },
  );
}
async function ownsWatchlist(c: ApiContext, id: string) {
  const rows =
    await sql`SELECT id FROM watchlists WHERE id=${id} AND owner_id=${c.get('actor').id}`;
  if (!rows[0]) fail(404, '观察列表不存在');
}
async function validateChannels(c: ApiContext, ids: string[]) {
  if (!ids.length) return;
  const rows =
    await sql`SELECT id FROM notification_channels WHERE owner_id=${c.get('actor').id} AND id IN ${sql(ids)}`;
  if (rows.length !== new Set(ids).size) fail(403, '通知渠道不属于当前用户');
}
