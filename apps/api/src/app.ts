import { researchRoutes } from './research-routes.js';
import { scoringRoutes } from './scoring-routes.js';
import { calendarRoutes } from './calendar-routes.js';
import { integrationRoutes } from './integration-routes.js';
import { sourceConfigRoutes } from './source-config-routes.js';
import { randomUUID } from 'node:crypto';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { sql } from '@radar/database';
import { config } from '@radar/config';
import { createLogger } from '@radar/observability';
import { addRoute, type ApiEnv } from './http.js';
import { authenticate, authRoutes, redis } from './security.js';
import { readRoutes } from './read-routes.js';
import { writeRoutes } from './write-routes.js';
const logger = createLogger('api');
export function createApp() {
  const app = new OpenAPIHono<ApiEnv>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: '请求格式不正确',
              requestId: c.get('requestId'),
            },
          },
          400,
        );
    },
  });
  app.use('*', async (c, next) => {
    const id = randomUUID();
    c.set('requestId', id);
    c.header('x-request-id', id);
    const started = Date.now();
    await next();
    logger.info(
      {
        requestId: id,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - started,
      },
      'request',
    );
  });
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: config.webOrigin,
      credentials: true,
      allowHeaders: ['Content-Type', 'X-CSRF-Token'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['X-Request-ID'],
    }),
  );
  app.use(
    '*',
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (c) =>
        c.json(
          {
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: '请求正文过大',
              requestId: c.get('requestId'),
            },
          },
          413,
        ),
    }),
  );
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/v1/auth/login' && c.req.method === 'POST') return next();
    await authenticate(c);
    await next();
  });
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? randomUUID();
    if (error instanceof z.ZodError)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: '字段格式或取值无效', requestId } },
        400,
      );
    if (error.message === '无法解密集成配置，请检查服务器加密密钥或重新保存凭据')
      return c.json(
        { error: { code: 'INTEGRATION_KEY_ERROR', message: error.message, requestId } },
        503,
      );
    if (error instanceof HTTPException) {
      const codes: Record<number, string> = {
        400: 'BAD_REQUEST',
        401: 'UNAUTHORIZED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        429: 'RATE_LIMITED',
        503: 'UNAVAILABLE',
      };
      return c.json(
        { error: { code: codes[error.status] ?? 'ERROR', message: error.message, requestId } },
        error.status,
      );
    }
    logger.error({ requestId, errorType: error.name }, 'request failed');
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: '服务暂时无法处理请求', requestId } },
      500,
    );
  });
  app.notFound((c) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: '接口不存在', requestId: c.get('requestId') } },
      404,
    ),
  );
  addRoute(
    app,
    'get',
    '/health',
    '存活检查',
    z.object({ status: z.literal('ok'), version: z.string() }),
    () => ({ data: { status: 'ok', version: config.version } }),
  );
  app.get('/ready', async (c) => {
    try {
      await sql`SELECT 1`;
      if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
      await redis.ping();
      return c.json({ data: { status: 'ready' } });
    } catch {
      return c.json(
        {
          error: {
            code: 'NOT_READY',
            message: '数据库或队列未就绪',
            requestId: c.get('requestId'),
          },
        },
        503,
      );
    }
  });
  authRoutes(app);
  sourceConfigRoutes(app);
  readRoutes(app);
  writeRoutes(app);
  integrationRoutes(app);
  calendarRoutes(app);
  scoringRoutes(app);
  researchRoutes(app);
  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Financial Radar API',
      version: '1.0.0',
      description:
        '所有业务端点使用 HttpOnly Session；写操作要求 Origin 与 X-CSRF-Token。Fixture 数据明确标记。',
    },
    servers: [{ url: '/' }],
  });
  return app;
}
