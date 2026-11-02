import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { ErrorSchema, envelope, type DataMode } from '@radar/shared';
import { config } from '@radar/config';
import { HTTPException } from 'hono/http-exception';
export type Actor = { id: string; email: string; role: string; csrfToken: string };
export type ApiEnv = { Variables: { requestId: string; actor: Actor } };
export type ApiContext = Context<ApiEnv>;
export function fail(status: 400 | 401 | 403 | 404 | 409 | 429 | 503, message: string): never {
  throw new HTTPException(status, { message });
}
export const idParam = (c: ApiContext) => z.uuid().parse(c.req.param('id'));
export async function body<T>(c: ApiContext, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    fail(400, '请求正文必须为 JSON');
  }
  return schema.parse(value);
}
export function meta(total: number, page = 1, pageSize = 20, mode: DataMode = config.dataMode) {
  return { total, page, pageSize, dataMode: mode, asOf: new Date().toISOString() };
}
export function addRoute(
  app: OpenAPIHono<ApiEnv>,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  summary: string,
  schema: z.ZodType,
  handler: (c: ApiContext) => Promise<unknown> | unknown,
  options: { body?: z.ZodType; status?: 200 | 202; query?: z.ZodObject } = {},
) {
  const status = options.status ?? 200;
  const response = envelope(schema);
  const params = Object.fromEntries(
    [...path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1]!, z.string().min(1)]),
  );
  const request = {
    ...(Object.keys(params).length ? { params: z.object(params) } : {}),
    ...(options.body
      ? { body: { required: true, content: { 'application/json': { schema: options.body } } } }
      : {}),
    ...(options.query ? { query: options.query } : {}),
  };
  const route = createRoute({
    method,
    path,
    summary,
    tags: [path.split('/')[3] ?? 'system'],
    request,
    responses: {
      [status]: { description: '成功', content: { 'application/json': { schema: response } } },
      400: { description: '输入无效', content: { 'application/json': { schema: ErrorSchema } } },
      401: { description: '需要登录', content: { 'application/json': { schema: ErrorSchema } } },
      403: {
        description: '权限或 CSRF 校验失败',
        content: { 'application/json': { schema: ErrorSchema } },
      },
      429: {
        description: '请求频率超过限制',
        content: { 'application/json': { schema: ErrorSchema } },
      },
    },
  });
  app.openapi(route, async (c) => {
    const data = await handler(c);
    const parsed = response.safeParse(data);
    if (!parsed.success) throw new Error('API response schema mismatch');
    return c.json(parsed.data, status);
  });
}
