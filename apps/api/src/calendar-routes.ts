import { randomUUID } from 'node:crypto';
import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { sql } from '@radar/database';
import { config } from '@radar/config';
import { PaginationSchema, DataModeSchema } from '@radar/shared';
import { addRoute, body, meta, fail, type ApiEnv } from './http.js';
import { audit } from './security.js';
const Time = z.iso.datetime({ offset: true });
export const CalendarInputSchema = z
  .object({
    sourceId: z.string().min(1).max(100),
    externalId: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    country: z.string().min(1).max(50),
    scheduledAt: Time,
    previousValue: z.string().max(100).nullable(),
    expectedValue: z.string().max(100).nullable(),
    actualValue: z.string().max(100).nullable(),
    importance: z.enum(['high', 'medium', 'low']),
    confirmed: z.boolean(),
    sourceUrl: z.url().refine((s) => new URL(s).protocol === 'https:', '来源必须HTTPS'),
    sourcePublishedAt: Time.nullable(),
    dataMode: DataModeSchema,
  })
  .strict();
export const CalendarSchema = CalendarInputSchema.extend({ id: z.uuid() });
const fixture = [
  {
    externalId: 'fixture-cpi',
    title: 'Fixture · 通胀数据发布测试',
    scheduledAt: '2026-11-03T12:30:00.000Z',
  },
  {
    externalId: 'fixture-rate',
    title: 'Fixture · 政策声明日历测试',
    scheduledAt: '2026-11-04T18:00:00.000Z',
  },
  {
    externalId: 'fixture-jobs',
    title: 'Fixture · 就业数据发布测试',
    scheduledAt: '2026-11-06T13:30:00.000Z',
  },
];
export async function initializeCalendarFixtures() {
  if (config.dataMode !== 'fixture') return;
  for (const input of fixture) {
    const event = CalendarSchema.parse({
      ...input,
      id: randomUUID(),
      sourceId: 'calendar-fixture',
      country: '美国',
      previousValue: null,
      expectedValue: null,
      actualValue: null,
      importance: 'high',
      confirmed: false,
      sourceUrl: 'https://example.invalid/fixtures/calendar',
      sourcePublishedAt: null,
      dataMode: 'fixture',
    });
    await sql`INSERT INTO economic_calendar(id,source_id,external_id,country,scheduled_at,data_mode,data) VALUES(${event.id},${event.sourceId},${event.externalId},${event.country},${event.scheduledAt},'fixture',${sql.json(event)}) ON CONFLICT(source_id,external_id,data_mode) DO NOTHING`;
  }
}
export function calendarRoutes(app: OpenAPIHono<ApiEnv>) {
  addRoute(
    app,
    'get',
    '/api/v1/calendar',
    '经济日历（未知字段为空，非官方预期不填充）',
    z.array(CalendarSchema),
    async (c) => {
      const p = PaginationSchema.parse(c.req.query());
      const country = z
        .string()
        .max(50)
        .parse(c.req.query('country') ?? '');
      const from = c.req.query('from');
      const to = c.req.query('to');
      if (from) Time.parse(from);
      if (to) Time.parse(to);
      if (from && to && Date.parse(from) > Date.parse(to)) fail(400, '开始时间不能晚于结束时间');
      const where = sql`data_mode=${config.dataMode} AND (${!country} OR country=${country}) AND scheduled_at>=${from ?? '1970-01-01T00:00:00Z'}::timestamptz AND scheduled_at<=${to ?? '9999-01-01T00:00:00Z'}::timestamptz`;
      const [rows, count] = await Promise.all([
        sql`SELECT data FROM economic_calendar WHERE ${where} ORDER BY scheduled_at LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
        sql`SELECT count(*)::int n FROM economic_calendar WHERE ${where}`,
      ]);
      return {
        data: rows.map((r) => CalendarSchema.parse(r.data)),
        meta: meta(Number(count[0]!.n), p.page, p.pageSize),
      };
    },
  );
  const ImportSchema = z.object({ items: z.array(CalendarInputSchema).min(1).max(100) }).strict();
  addRoute(
    app,
    'post',
    '/api/v1/calendar/import',
    '管理员导入可靠来源日历（不自动推定发布）',
    z.object({ imported: z.number() }),
    async (c) => {
      const input = await body(c, ImportSchema);
      if (input.items.some((i) => i.dataMode !== config.dataMode))
        fail(400, '导入数据模式与运行模式不一致');
      if (
        config.dataMode === 'live' &&
        input.items.some((i) => new URL(i.sourceUrl).hostname.endsWith('.invalid'))
      )
        fail(400, 'Live日历必须使用可靠的真实来源');
      await sql.begin(async (tx) => {
        for (const item of input.items) {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${item.sourceId + ':' + item.externalId + ':' + item.dataMode}))`;
          const id = randomUUID();
          const existing = (
            await tx`SELECT id FROM economic_calendar WHERE source_id=${item.sourceId} AND external_id=${item.externalId} AND data_mode=${item.dataMode}`
          )[0];
          const event = { ...item, id: existing?.id ?? id };
          await tx`INSERT INTO economic_calendar(id,source_id,external_id,country,scheduled_at,data_mode,data) VALUES(${event.id},${item.sourceId},${item.externalId},${item.country},${item.scheduledAt},${item.dataMode},${tx.json(event)}) ON CONFLICT(source_id,external_id,data_mode) DO UPDATE SET country=excluded.country,scheduled_at=excluded.scheduled_at,data=excluded.data,updated_at=now()`;
        }
      });
      await audit(c, c.get('actor').id, 'IMPORT', 'economic_calendar', null, {
        count: input.items.length,
        dataMode: config.dataMode,
      });
      return { data: { imported: input.items.length } };
    },
    { body: ImportSchema },
  );
}
