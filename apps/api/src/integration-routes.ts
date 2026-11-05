import { randomUUID } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { config, assertPublicHttpsUrl, fetchPublicHttpsStream } from '@radar/config';
import { requestChatCompletion } from '@radar/ai';
import { sql, readAIConfig, aiConfigView, saveAIConfig } from '@radar/database';
import {
  AIConfigPatchSchema,
  AIConfigViewSchema,
  AIConnectionTestSchema,
  AI_CONNECTION_TEST_REASONING_EFFORT,
} from '@radar/shared';
import { addRoute, body, fail, type ApiEnv } from './http.js';
import { audit, rateLimit } from './security.js';

export function integrationRoutes(app: OpenAPIHono<ApiEnv>) {
  addRoute(
    app,
    'get',
    '/api/v1/integrations/ai',
    'AI 服务配置（不回显密钥）',
    AIConfigViewSchema,
    async () => ({ data: aiConfigView(await readAIConfig()) }),
  );
  addRoute(
    app,
    'patch',
    '/api/v1/integrations/ai',
    '保存 AI 服务配置',
    AIConfigViewSchema,
    async (c) => {
      await rateLimit(c, 'integration-config', 30, 300);
      const patch = await body(c, AIConfigPatchSchema);
      if (patch.baseUrl) {
        try {
          await assertPublicHttpsUrl(patch.baseUrl);
        } catch {
          fail(400, 'AI 地址必须是可解析的公开 HTTPS 地址');
        }
      }
      const data = await saveAIConfig(patch);
      await audit(c, c.get('actor').id, 'UPDATE', 'ai_integration', null, {
        fields: Object.keys(patch),
        enabled: data.enabled,
      });
      return { data };
    },
    { body: AIConfigPatchSchema },
  );
  addRoute(
    app,
    'post',
    '/api/v1/integrations/ai/test',
    '测试已保存的 AI 模型连接',
    AIConnectionTestSchema,
    async (c) => {
      await rateLimit(c, 'ai-connection-test', 3, 300);
      const effective = await readAIConfig();
      if (config.dataMode === 'fixture')
        return {
          data: {
            status: 'skipped',
            message: 'Fixture 模式未调用真实 AI 服务；切换 live 后可测试。',
            model: effective.model,
            reasoningEffort: AI_CONNECTION_TEST_REASONING_EFFORT,
          },
        };
      if (!effective.enabled || !effective.apiKey || !effective.model)
        fail(409, '请先启用 AI 并保存模型和 API Key');
      const id = randomUUID();
      const reservedCost = effective.maxCallCostUsd;
      const allowed = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('financial-radar-ai-budget'))`;
        const usage = (
          await tx`SELECT coalesce(sum((reservation->>'cost')::numeric),0)::float AS cost,count(*)::int AS calls FROM ai_analysis_runs CROSS JOIN LATERAL jsonb_array_elements(coalesce(data->'reservations','[]'::jsonb)) AS reservation WHERE provider<>'fixture' AND (reservation->>'at')::timestamptz>=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`
        )[0]!;
        if (
          effective.dailyBudgetUsd <= 0 ||
          reservedCost <= 0 ||
          Number(usage.cost) + reservedCost > effective.dailyBudgetUsd ||
          Number(usage.calls) >= effective.maxDailyCalls
        )
          return false;
        const data = {
          kind: 'connection-test',
          reasoningEffort: AI_CONNECTION_TEST_REASONING_EFFORT,
          reservations: [{ at: new Date().toISOString(), cost: reservedCost }],
        };
        await tx`INSERT INTO ai_analysis_runs(id,status,provider,model,prompt_version,cache_key,estimated_cost,data) VALUES(${id},'RUNNING','openai-compatible',${effective.model},'connection-test-v1',${`connection-test:${id}`},${reservedCost},${tx.json(data)})`;
        return true;
      });
      if (!allowed) fail(409, 'AI 每日预算或调用额度不足，请检查预算设置');
      try {
        const completion = await requestChatCompletion(
          {
            baseUrl: effective.baseUrl,
            apiKey: effective.apiKey,
            model: effective.model,
            timeoutMs: effective.timeoutMs,
            reasoningEffort: AI_CONNECTION_TEST_REASONING_EFFORT,
            jsonMode: effective.jsonMode,
            maxTokens: 512,
            totalTimeoutMs: 60000,
            messages: [{ role: 'user', content: 'Connection test. Reply with JSON: {"ok":true}.' }],
          },
          (url, options) => fetchPublicHttpsStream(String(url), options),
        );
        if (!completion.content.trim()) throw new Error('AI 服务响应缺少有效 completion');
        await sql`UPDATE ai_analysis_runs SET status='COMPLETED',input_tokens=${completion.inputTokens},output_tokens=${completion.outputTokens},completed_at=now() WHERE id=${id}`;
        await audit(c, c.get('actor').id, 'TEST', 'ai_integration', id, {
          status: 'connected',
          reasoningEffort: AI_CONNECTION_TEST_REASONING_EFFORT,
        });
        return {
          data: {
            status: 'connected',
            message: '模型完成了一次真实测试请求；不代表新闻分析证据校验已通过。',
            model: effective.model,
            reasoningEffort: AI_CONNECTION_TEST_REASONING_EFFORT,
          },
        };
      } catch (error) {
        const safeMessages: Record<string, string> = {
          'AI provider 输出达到 token 上限': 'AI 服务测试输出达到 token 上限，请检查模型兼容性',
          'AI provider 流式响应未完整结束': 'AI 服务流式响应中断，未收到完整测试结果',
          'AI provider 等待数据超时': 'AI 服务等待首包或后续数据超时，请检查服务响应速度',
          'AI provider 请求超过总时长上限': 'AI 连接测试超过 60 秒总时长上限',
          'AI provider 响应缺少有效 completion': 'AI 服务响应缺少有效 completion',
          'AI 服务响应缺少有效 completion': 'AI 服务响应缺少有效 completion',
        };
        const httpStatus =
          error instanceof Error ? /^AI provider HTTP (\d{3})$/.exec(error.message)?.[1] : null;
        const message = httpStatus
          ? `AI 服务返回 HTTP ${httpStatus}`
          : (error instanceof Error && safeMessages[error.message]) ||
            'AI 连接测试失败，请检查地址、模型和密钥或稍后重试';
        await sql`UPDATE ai_analysis_runs SET status='FAILED',error=${message},completed_at=now() WHERE id=${id}`;
        fail(503, message);
      }
    },
  );
}
