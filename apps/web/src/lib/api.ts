import { z } from 'zod';

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }),
});
const envelopeSchema = z.object({
  data: z.unknown(),
  meta: z
    .object({
      total: z.number().optional(),
      page: z.number().optional(),
      pageSize: z.number().optional(),
      dataMode: z.string().optional(),
      asOf: z.string().optional(),
    })
    .optional(),
});

export interface Meta {
  total?: number;
  page?: number;
  pageSize?: number;
  dataMode?: string;
  asOf?: string;
}
export interface Envelope<T> {
  data: T;
  meta?: Meta;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
let csrfToken = '';
export function setCsrfToken(value: string) {
  csrfToken = value;
}
const baseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') ||
  '/api/v1';
export async function api<T>(
  path: string,
  options: RequestInit = {},
  schema?: z.ZodType<T>,
): Promise<Envelope<T>> {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-CSRF-Token', csrfToken);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      credentials: 'include',
      signal: options.signal ?? AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError('无法连接服务，请检查网络后重试。', 0, 'NETWORK_ERROR');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('服务器返回了无法解析的响应。', response.status, 'INVALID_RESPONSE');
  }
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    if (response.status === 401 && path !== '/auth/me' && path !== '/auth/login')
      window.dispatchEvent(new Event('radar:unauthorized'));
    throw new ApiError(
      error.success ? error.data.error.message : '请求失败，请稍后重试。',
      response.status,
      error.success ? error.data.error.code : 'REQUEST_FAILED',
      error.success ? error.data.error.requestId : undefined,
    );
  }
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success)
    throw new ApiError('接口响应结构与约定不一致。', response.status, 'INVALID_RESPONSE');
  const result = schema
    ? schema.safeParse(envelope.data.data)
    : { success: true as const, data: envelope.data.data as T };
  if (!result.success)
    throw new ApiError('数据校验失败，请联系管理员。', response.status, 'INVALID_DATA');
  return { data: result.data, ...(envelope.data.meta ? { meta: envelope.data.meta } : {}) };
}
export function queryString(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') params.set(key, String(value));
  return params.size ? `?${params}` : '';
}
export const write = <T>(path: string, method: string, body?: unknown) =>
  api<T>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
