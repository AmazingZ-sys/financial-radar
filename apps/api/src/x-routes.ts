import type { OpenAPIHono } from '@hono/zod-openapi';
import { ZodError } from 'zod';
import { config } from '@radar/config';
import {
  readXConfig,
  readXConfigView,
  saveXConfig,
  reserveXRequest,
  saveXTestResult,
  deferXRequestsUntil,
  XRequestDeferredError,
} from '@radar/database';
import { buildXQuery, ConnectorError, XRecentSearchConnector } from '@radar/connectors';
import {
  XConfigViewSchema,
  XConfigPatchSchema,
  XConnectionTestSchema,
  mergeXConfig,
  type XConnectionTest,
} from '@radar/shared';
import { addRoute, body, fail, type ApiEnv } from './http.js';
import { audit, rateLimit } from './security.js';

function safeTestFailure(error: unknown): { message: string; httpStatus: number | null } {
  if (error instanceof XRequestDeferredError)
    return {
      httpStatus: null,
      message: `尚未到下一次允许请求时间（${error.retryAt.toISOString()}）；本次未请求采集器或计数。`,
    };
  const httpStatus =
    error instanceof ConnectorError
      ? Number(/\bHTTP\s+(\d{3})\b/.exec(error.message)?.[1]) || null
      : null;
  const messages: Record<number, string> = {
    401: 'X 登录态已失效，请在管理页更新自己的 auth_token 和 ct0。',
    403: '自建采集器拒绝访问，请检查服务器共享密钥是否一致。',
    429: 'X 请求受到限流，请等待平台冷却后重试。',
    502: '自建采集器暂时未能读取有效的 X 数据，请查看采集服务状态后重试。',
    503: '自建 X 采集服务暂不可用，请检查服务是否启动。',
  };
  const localMessages: Record<string, string> = {
    X_CREDENTIAL_UNAVAILABLE: '保存的 X 登录态无法解密，请重新保存后测试。',
    X_CONFIGURATION_REQUIRED: '请先保存自己的 X 登录态和至少一个关注账号。',
    X_COLLECTOR_CONFIGURATION_REQUIRED:
      '自建采集服务尚未配置，请在服务器设置 X_COLLECTOR_URL 与 X_COLLECTOR_SECRET 并启动采集容器。',
    'X 今日请求上限已用尽；请调整上限或等待 UTC 次日':
      'X 今日请求上限已用尽；请调整上限或等待 UTC 次日。',
    'X 配置已更新，请使用最新配置重试': 'X 配置已更新，请使用最新配置重试。',
    'X 凭据或关注账号未配置，请重新保存后测试': '请先保存有效 X 登录态和关注账号。',
  };
  return {
    httpStatus,
    message:
      (httpStatus && messages[httpStatus]) ||
      (error instanceof Error && localMessages[error.message]) ||
      (error instanceof ConnectorError && error.classification === 'RATE_LIMIT'
        ? 'X 请求受到限流，请等待平台冷却后重试。'
        : 'X 连接测试失败，请检查登录态、自建采集服务和网络；不会切换到付费 API。'),
  };
}

export function xRoutes(app: OpenAPIHono<ApiEnv>, fetcher: typeof fetch = fetch) {
  addRoute(
    app,
    'get',
    '/api/v1/integrations/x',
    'X 自建免费采集配置、请求上限和调试状态（不回显登录态）',
    XConfigViewSchema,
    async () => ({ data: await readXConfigView() }),
  );
  addRoute(
    app,
    'patch',
    '/api/v1/integrations/x',
    '保存 X 自建免费采集配置',
    XConfigViewSchema,
    async (c) => {
      await rateLimit(c, 'x-integration-config', 30, 300);
      const patch = await body(c, XConfigPatchSchema);
      if (patch.clearSessionCookies && patch.sessionCookies)
        fail(400, '不能同时写入和清除 X 登录态');
      const saved = await readXConfig();
      let effective;
      try {
        effective = mergeXConfig(saved, {
          ...patch,
          ...(patch.clearSessionCookies ? { enabled: false } : {}),
        });
      } catch {
        fail(400, 'X 采集间隔区间无效，最小值不得大于最大值（300–86400秒）');
      }
      const session = patch.clearSessionCookies
        ? ''
        : (patch.sessionCookies ?? saved.sessionCookies);
      if (effective.usernames.length) {
        try {
          buildXQuery({ usernames: effective.usernames, keywords: effective.keywords });
        } catch {
          fail(400, '账号和关键词构成的 X 查询超过限制，请缩小采集范围（最多512字符）');
        }
      }
      if (
        effective.enabled &&
        (!session || !effective.usernames.length || effective.dailyRequestLimit <= 0)
      )
        fail(400, '启用 X 采集前请保存有效登录态、至少一个关注账号和大于0的每日请求上限');
      try {
        await saveXConfig(patch);
      } catch (error) {
        if (error instanceof ZodError)
          fail(400, 'X 采集间隔区间无效，最小值不得大于最大值（300–86400秒）');
        if (
          error instanceof Error &&
          error.message === '启用采集前请配置有效登录态、关注账号和大于0的每日请求上限'
        )
          fail(400, error.message);
        throw error;
      }
      const data = await readXConfigView();
      await audit(c, c.get('actor').id, 'UPDATE', 'x_integration', null, {
        fields: Object.keys(patch),
        enabled: data.enabled,
      });
      return { data };
    },
    { body: XConfigPatchSchema },
  );
  addRoute(
    app,
    'post',
    '/api/v1/integrations/x/test',
    '测试已保存 X 配置，最多读取10条，不入库为业务事件或调用 AI',
    XConnectionTestSchema,
    async (c) => {
      await rateLimit(c, 'x-connection-test', 3, 300);
      let result: XConnectionTest = {
        dataMode: config.dataMode,
        status: 'skipped',
        message: 'Fixture 模式未访问自建 X 采集器或真实 X，也未调用 AI。',
        checkedAt: new Date().toISOString(),
        httpStatus: null,
        returnedPosts: 0,
        samples: [],
      };
      if (config.dataMode === 'live') {
        try {
          const effective = await readXConfig();
          if (effective.credentialError) throw new Error('X_CREDENTIAL_UNAVAILABLE');
          if (!config.xCollectorUrl || !config.xCollectorSecret)
            throw new Error('X_COLLECTOR_CONFIGURATION_REQUIRED');
          const connector = new XRecentSearchConnector(
            { ...effective, maxResults: 10 },
            fetcher,
            async () => {
              await reserveXRequest(effective, { requireEnabled: false });
            },
          );
          try {
            const health = await connector.healthCheck();
            if (health.status === 'unconfigured') throw new Error('X_CONFIGURATION_REQUIRED');
            const response = await connector.fetch();
            result = {
              dataMode: config.dataMode,
              status: 'connected',
              message: '自建免费采集器读取成功；样本仅用于调试，未触发业务采集、分析或通知。',
              checkedAt: new Date().toISOString(),
              httpStatus: connector.lastHttpStatus,
              returnedPosts: response.items.length,
              samples: response.items.slice(0, 3).map((item) => ({
                id: item.externalId,
                text: String(item.payload.text ?? '').slice(0, 1000),
                authorId: String(item.payload.authorId ?? ''),
                url: String(item.payload.originalUrl),
                sourcePublishedAt: item.publishedAt,
              })),
            };
          } finally {
            await connector.shutdown();
          }
        } catch (error) {
          if (error instanceof ConnectorError && error.classification === 'RATE_LIMIT') {
            const cooldown =
              Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
                ? error.retryAfterMs
                : 900_000;
            await deferXRequestsUntil(new Date(Date.now() + cooldown).toISOString());
          }
          result = {
            dataMode: config.dataMode,
            status: error instanceof XRequestDeferredError ? 'skipped' : 'failed',
            ...safeTestFailure(error),
            checkedAt: new Date().toISOString(),
            returnedPosts: 0,
            samples: [],
          };
        }
      }
      await saveXTestResult(result);
      await audit(c, c.get('actor').id, 'TEST', 'x_integration', null, {
        status: result.status,
        httpStatus: result.httpStatus,
        returnedPosts: result.returnedPosts,
      });
      return { data: result };
    },
  );
}
