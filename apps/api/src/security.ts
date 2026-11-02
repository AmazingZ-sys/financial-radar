import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Redis } from 'ioredis';
import { sql, verifyPassword } from '@radar/database';
import { config } from '@radar/config';
import { z } from 'zod';
import { addRoute, body, fail, type ApiContext, type ApiEnv } from './http.js';
import type { OpenAPIHono } from '@hono/zod-openapi';
export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  enableOfflineQueue: false,
  retryStrategy: () => null,
});
redis.on('error', () => {});
const localLimits = new Map<string, { count: number; until: number }>();
async function limited(key: string, max: number, seconds: number): Promise<boolean> {
  try {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
    const n = (await redis.eval(
      "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end;return n",
      1,
      `api:limit:${key}`,
      seconds,
    )) as number;
    return n > max;
  } catch {
    if (config.nodeEnv === 'production') fail(503, '限流依赖暂不可用，请稍后重试');
    const now = Date.now();
    if (localLimits.size > 10000)
      for (const [k, v] of localLimits) if (v.until < now) localLimits.delete(k);
    const state = localLimits.get(key);
    const next =
      state && state.until > now
        ? { count: state.count + 1, until: state.until }
        : { count: 1, until: now + seconds * 1000 };
    localLimits.set(key, next);
    return next.count > max;
  }
}
export async function rateLimit(c: ApiContext, scope: string, max: number, seconds: number) {
  // Never trust client X-Forwarded-For: the host proxy must replace X-Real-IP.
  const ip = config.nodeEnv === 'production' ? (c.req.header('x-real-ip') ?? 'unknown') : 'local';
  if (await limited(`${scope}:${ip}`, max, seconds)) fail(429, '请求过于频繁，请稍后重试');
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const LoginSchema = z
  .object({ email: z.email().max(200), password: z.string().min(1).max(200) })
  .strict();
export function authRoutes(app: OpenAPIHono<ApiEnv>) {
  addRoute(
    app,
    'post',
    '/api/v1/auth/login',
    '管理员登录',
    z.object({ id: z.uuid(), email: z.email(), role: z.string(), csrfToken: z.string() }),
    async (c) => {
      const origin = c.req.header('origin');
      if (origin && origin !== config.webOrigin) fail(403, '来源未获授权');
      await rateLimit(c, 'login', 10, 900);
      const input = await body(c, LoginSchema);
      const rows = await sql<
        { id: string; email: string; role: string; password_hash: string; enabled: boolean }[]
      >`SELECT id,email,role,password_hash,enabled FROM users WHERE email=${input.email.toLowerCase()}`;
      const user = rows[0];
      // Equal expensive hash cost on nonexistent accounts reduces account enumeration.
      const valid = await verifyPassword(
        input.password,
        user?.password_hash ?? 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128),
      );
      if (!user || !user.enabled || !valid) fail(401, '邮箱或密码错误');
      const token = randomBytes(32).toString('hex');
      const csrfToken = randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 86400_000 * 7);
      await sql`INSERT INTO user_sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES(${randomUUID()},${user.id},${hash(token)},${csrfToken},${expires})`;
      setCookie(c, 'radar_session', token, {
        httpOnly: true,
        secure: config.secureCookie,
        sameSite: config.cookieSameSite,
        path: '/',
        expires,
        maxAge: 86400 * 7,
      });
      await audit(c, user.id, 'LOGIN', 'session', null);
      return { data: { id: user.id, email: user.email, role: user.role, csrfToken } };
    },
    { body: LoginSchema },
  );
  addRoute(
    app,
    'get',
    '/api/v1/auth/me',
    '当前用户',
    z.object({ id: z.uuid(), email: z.email(), role: z.string(), csrfToken: z.string() }),
    (c) => ({ data: c.get('actor') }),
  );
  addRoute(
    app,
    'post',
    '/api/v1/auth/logout',
    '退出登录',
    z.object({ ok: z.boolean() }),
    async (c) => {
      const token = getCookie(c, 'radar_session');
      if (token) await sql`DELETE FROM user_sessions WHERE token_hash=${hash(token)}`;
      deleteCookie(c, 'radar_session', {
        path: '/',
        secure: config.secureCookie,
        sameSite: config.cookieSameSite,
      });
      return { data: { ok: true } };
    },
  );
}
export async function authenticate(c: ApiContext) {
  const token = getCookie(c, 'radar_session');
  if (!token || !/^\w{64}$/.test(token)) fail(401, '请先登录');
  const rows = await sql<
    { id: string; email: string; role: string; csrf_token: string }[]
  >`SELECT u.id,u.email,u.role,s.csrf_token FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=${hash(token)} AND s.expires_at>now() AND u.enabled=true`;
  const user = rows[0];
  if (!user) fail(401, '登录状态已失效');
  c.set('actor', { id: user.id, email: user.email, role: user.role, csrfToken: user.csrf_token });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (user.role !== 'admin') fail(403, '需要管理员权限');
    if (c.req.header('origin') !== config.webOrigin) fail(403, '请求来源校验失败');
    const supplied = c.req.header('x-csrf-token') ?? '';
    if (
      supplied.length !== user.csrf_token.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(user.csrf_token))
    )
      fail(403, 'CSRF 校验失败');
    await rateLimit(c, `write:${user.id}`, 120, 60);
  }
}
export async function audit(
  c: ApiContext,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
) {
  await sql`INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,request_id,details) VALUES(${randomUUID()},${actorId},${action},${entityType},${entityId},${c.get('requestId')},${sql.json(details as never)})`;
}
