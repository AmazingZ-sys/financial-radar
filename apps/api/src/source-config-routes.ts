import { randomUUID } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { sql } from '@radar/database';
import { config, assertPublicHttpsUrl } from '@radar/config';
import { createRegistry, NEWS_PRESETS, categoriesForSource } from '@radar/connectors';
import { SourceInputSchema, SourceCatalogSchema } from '@radar/shared';
import { addRoute, body, fail, meta, type ApiEnv } from './http.js';
import { audit, rateLimit } from './security.js';

export function sourceConfigRoutes(app: OpenAPIHono<ApiEnv>) {
  addRoute(
    app,
    'get',
    '/api/v1/sources/catalog',
    '可接入来源目录（live 能力）',
    z.array(SourceCatalogSchema),
    async () => {
      const registry = createRegistry({ ...config, dataMode: 'live' });
      const rows = await sql`SELECT id,enabled FROM data_sources WHERE mode='live'`;
      const state = new Map(rows.map((row) => [String(row.id), row]));
      const data = registry.list().map((connector) => {
        const source = connector.metadata;
        const preset = NEWS_PRESETS.find((feed) => feed.id === source.id);
        const row = state.get(source.id);
        return {
          id: source.id,
          name: source.name,
          categories: categoriesForSource(source.id, source.categories),
          description:
            preset?.description ??
            (source.id === 'fed-rss'
              ? '美联储官方政策与新闻公告。'
              : source.id.includes('treasury')
                ? '美国财政部日度利率；非实时债券行情。'
                : '已实现适配器；采集范围与所需凭据见来源说明。'),
          docsUrl: source.officialUrl,
          feedUrl:
            preset?.feedUrl ??
            (source.id === 'fed-rss' ? 'https://www.federalreserve.gov/feeds/press_all.xml' : null),
          intervalSeconds: source.pollIntervalSeconds,
          licenseStatus: source.licenseStatus,
          requiresConfiguration: ['unisat', 'dex', 'evm', 'solana'].some((prefix) =>
            source.id.startsWith(prefix),
          ),
          installed: config.dataMode === 'live' && Boolean(row),
          enabled: config.dataMode === 'live' && Boolean(row?.enabled),
        };
      });
      await registry.shutdown();
      return { data, meta: meta(data.length, 1, data.length) };
    },
  );
  addRoute(
    app,
    'post',
    '/api/v1/sources',
    '新增公开 RSS/Atom 来源',
    z.object({ id: z.string(), created: z.boolean() }),
    async (c) => {
      if (config.dataMode !== 'live')
        fail(409, 'Fixture 模式仅查看来源目录；新增真实订阅需部署为 live 模式');
      await rateLimit(c, 'source-create', 10, 60);
      const input = await body(c, SourceInputSchema);
      const feedUrl = new URL(input.feedUrl).href;
      try {
        await assertPublicHttpsUrl(feedUrl);
      } catch {
        fail(400, '订阅地址必须指向公开 HTTPS 服务，不能使用私网或保留地址');
      }
      const result = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`feed:${feedUrl}`}))`;
        const existing =
          await tx`SELECT id FROM data_sources WHERE mode='live' AND data->'feedConfig'->>'feedUrl'=${feedUrl}`;
        if (existing[0]) return { id: String(existing[0].id), created: false };
        const id = `custom-rss-${randomUUID()}`;
        const data = {
          description: '管理员配置的 RSS/Atom 订阅；来源内容与许可需核实。',
          docsUrl: feedUrl,
          feedUrl,
          custom: true,
          categories: input.categories,
          feedConfig: { ...input, feedUrl },
          keyConfigured: true,
          status: 'pending',
          capabilities: ['partial', 'checkpoint', 'RSS/Atom'],
          delayLabel: `${input.intervalSeconds}s轮询；新闻发布时间和端到端延迟由来源决定`,
          licenseStatus: 'authorization-required',
        };
        await tx`INSERT INTO data_sources(id,name,enabled,connector_type,mode,interval_seconds,data) VALUES(${id},${input.name},${input.enabled},'pull','live',${input.intervalSeconds},${tx.json(data)})`;
        return { id, created: true };
      });
      await audit(
        c,
        c.get('actor').id,
        result.created ? 'CREATE' : 'READ_EXISTING',
        'source',
        result.id,
        { categories: input.categories },
      );
      return { data: result };
    },
    { body: SourceInputSchema },
  );
}
