import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { sql } from '@radar/database';
import { ScoringConfigSchema, DEFAULT_SCORING_CONFIG } from '@radar/signals';
import { addRoute, body, fail, type ApiEnv } from './http.js';
import { audit } from './security.js';
export function scoringRoutes(app: OpenAPIHono<ApiEnv>) {
  addRoute(
    app,
    'get',
    '/api/v1/system/scoring',
    '当前机会与风险评分权重和版本',
    ScoringConfigSchema,
    async () => {
      const stored = (await sql`SELECT data FROM system_settings WHERE key='scoring-config'`)[0];
      return { data: ScoringConfigSchema.parse(stored?.data ?? DEFAULT_SCORING_CONFIG) };
    },
  );
  addRoute(
    app,
    'patch',
    '/api/v1/system/scoring',
    '更新评分版本（保留历史，不重算已有信号）',
    ScoringConfigSchema,
    async (c) => {
      const next = await body(c, ScoringConfigSchema);
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('financial-radar-scoring-config'))`;
        const oldRow = (await tx`SELECT data FROM system_settings WHERE key='scoring-config'`)[0];
        const old = ScoringConfigSchema.parse(oldRow?.data ?? DEFAULT_SCORING_CONFIG);
        for (const kind of ['opportunity', 'risk'] as const) {
          const versionKey = `scoring-history:${kind}:${next[kind].version}`;
          const oldVersionKey = `scoring-history:${kind}:${old[kind].version}`;
          const changed = Object.keys(old[kind].weights).some(
            (key) => Reflect.get(old[kind].weights, key) !== Reflect.get(next[kind].weights, key),
          );
          if (changed && old[kind].version === next[kind].version)
            fail(409, '修改权重必须使用新的评分版本');
          const used = (await tx`SELECT data FROM system_settings WHERE key=${versionKey}`)[0];
          if (
            used &&
            (used.data.version !== next[kind].version ||
              Object.keys(next[kind].weights).some(
                (key) =>
                  Reflect.get(used.data.weights, key) !== Reflect.get(next[kind].weights, key),
              ))
          )
            fail(409, '评分版本已对应其他权重，不能覆盖历史');
          await tx`INSERT INTO system_settings(key,data) VALUES(${oldVersionKey},${tx.json(old[kind])}) ON CONFLICT(key) DO NOTHING`;
          await tx`INSERT INTO system_settings(key,data) VALUES(${versionKey},${tx.json(next[kind])}) ON CONFLICT(key) DO NOTHING`;
        }
        await tx`INSERT INTO system_settings(key,data) VALUES('scoring-config',${tx.json(next)}) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=now()`;
      });
      await audit(c, c.get('actor').id, 'UPDATE', 'scoring-config', null, {
        opportunityVersion: next.opportunity.version,
        riskVersion: next.risk.version,
      });
      return { data: next };
    },
  );
  addRoute(
    app,
    'get',
    '/api/v1/system/scoring/history',
    '已使用的评分版本快照',
    z.array(z.object({ key: z.string(), data: z.unknown(), updatedAt: z.string() })),
    async () => {
      const rows =
        await sql`SELECT key,data,updated_at FROM system_settings WHERE key LIKE 'scoring-history:%' ORDER BY updated_at DESC LIMIT 100`;
      return {
        data: rows.map((row) => ({
          key: row.key,
          data: row.data,
          updatedAt: new Date(row.updated_at as string).toISOString(),
        })),
      };
    },
  );
}
