import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { sql } from '@radar/database';
import { EventSchema } from '@radar/shared';
import { config } from '@radar/config';
import { addRoute, body, fail, idParam, type ApiEnv } from './http.js';
import { audit } from './security.js';
export function researchRoutes(app: OpenAPIHono<ApiEnv>) {
  const ReviewInput = z
    .object({ status: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(2000).default('') })
    .strict();
  addRoute(
    app,
    'post',
    '/api/v1/events/{id}/review',
    '人工复核AI分析（不改变来源或项目验证状态）',
    EventSchema,
    async (c) => {
      const id = idParam(c);
      const input = await body(c, ReviewInput);
      const review = {
        ...input,
        reviewerId: c.get('actor').id,
        reviewedAt: new Date().toISOString(),
      };
      const event = await sql.begin(async (tx) => {
        const row = (
          await tx`SELECT data FROM events WHERE id=${id} AND data->>'dataMode'=${config.dataMode} FOR UPDATE`
        )[0];
        if (!row) fail(404, '事件不存在');
        if (row.data.analysisStatus !== 'COMPLETED') fail(409, '分析尚未完成，无法人工复核');
        const stored = { ...row.data, review, updatedAt: review.reviewedAt };
        const data = EventSchema.parse(stored);
        await tx`UPDATE events SET data=${tx.json(stored)},updated_at=now() WHERE id=${id}`;
        await tx`UPDATE ai_analysis_runs SET data=data || ${tx.json({ reviewStatus: input.status, review })}::jsonb WHERE event_id=${id} AND status='COMPLETED' AND data->'result'=${tx.json(row.data.analysis)}::jsonb`;
        return data;
      });
      await audit(c, c.get('actor').id, 'REVIEW', 'event_analysis', id, { status: input.status });
      return { data: event };
    },
    { body: ReviewInput },
  );
  addRoute(
    app,
    'get',
    '/api/v1/projects/{id}/metrics',
    '项目历史指标（每条保留来源和观测时间）',
    z.array(
      z.object({ id: z.string(), sourceId: z.string(), observedAt: z.string(), data: z.unknown() }),
    ),
    async (c) => {
      const id = idParam(c);
      const exists = (
        await sql`SELECT id FROM projects WHERE id=${id} AND data->>'dataMode'=${config.dataMode}`
      )[0];
      if (!exists) fail(404, '项目不存在');
      const rows =
        await sql`SELECT m.id,m.source_id,m.observed_at,m.data FROM project_metrics m JOIN data_sources s ON s.id=m.source_id WHERE m.project_id=${id} AND s.mode=${config.dataMode} ORDER BY m.observed_at DESC LIMIT 500`;
      return {
        data: rows.map((r) => ({
          id: r.id,
          sourceId: r.source_id,
          observedAt: new Date(r.observed_at as string).toISOString(),
          data: r.data,
        })),
      };
    },
  );
  const Digest = z.object({
    day: z.string(),
    timezone: z.literal('UTC'),
    dataMode: z.enum(['fixture', 'live']),
    asOf: z.string(),
    method: z.literal('stored-evidence-and-analysis'),
    totalEvents: z.number(),
    categories: z.array(z.object({ name: z.string(), count: z.number() })),
    items: z.array(
      z.object({
        eventId: z.string(),
        title: z.string(),
        severity: z.string(),
        summary: z.string(),
        analysisStatus: z.string(),
        sourceUrls: z.array(z.string()),
        firstSeenAt: z.string(),
        riskWarnings: z.array(z.string()),
      }),
    ),
    limitations: z.array(z.string()),
  });
  addRoute(
    app,
    'get',
    '/api/v1/digests/daily',
    '每日金融摘要（只汇总持久化事实与已完成分析）',
    Digest,
    async (c) => {
      const day = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .parse(c.req.query('day') ?? new Date().toISOString().slice(0, 10));
      const start = new Date(day + 'T00:00:00.000Z');
      if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== day)
        fail(400, '日历日期无效');
      const end = new Date(start.getTime() + 86400_000);
      const rows =
        await sql`SELECT data FROM events WHERE first_seen_at>=${start} AND first_seen_at<${end} AND data->>'dataMode'=${config.dataMode} ORDER BY severity,first_seen_at DESC LIMIT 100`;
      const count = (
        await sql`SELECT count(*)::int n FROM events WHERE first_seen_at>=${start} AND first_seen_at<${end} AND data->>'dataMode'=${config.dataMode}`
      )[0]!;
      const categories = new Map<string, number>();
      const items = rows.map((r) => {
        const event = EventSchema.parse(r.data);
        for (const cat of event.categories) categories.set(cat, (categories.get(cat) ?? 0) + 1);
        const analysis = event.analysis as { summary?: string } | undefined;
        return {
          eventId: event.id,
          title: event.title,
          severity: event.severity,
          summary: analysis?.summary ?? event.description,
          analysisStatus: event.analysisStatus,
          sourceUrls: event.originalUrl ? [event.originalUrl] : [],
          firstSeenAt: event.firstSeenAt,
          riskWarnings: event.riskWarnings,
        };
      });
      return {
        data: {
          day,
          timezone: 'UTC' as const,
          dataMode: config.dataMode,
          asOf: new Date().toISOString(),
          method: 'stored-evidence-and-analysis' as const,
          totalEvents: Number(count.n),
          categories: [...categories].map(([name, count]) => ({ name, count })),
          items,
          limitations: [
            '仅汇总指定UTC日已存储事件（最多100条）；不等待同步AI调用。',
            '缺失来源和未完成分析保留原始摘要，不生成新事实或收益预测。',
          ],
        },
      };
    },
  );
}
