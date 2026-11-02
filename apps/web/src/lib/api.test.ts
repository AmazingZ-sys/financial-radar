import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, ApiError, setCsrfToken, write } from './api';
import { number, safeUrl } from './format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  setCsrfToken('');
});
describe('browser API boundary', () => {
  it.each([
    ['', '/api/v1/auth/login'],
    ['  \t  ', '/api/v1/auth/login'],
    ['  https://api.example.com/api/v1/  ', 'https://api.example.com/api/v1/auth/login'],
  ])(
    'routes login to the configured versioned API when its build value is %j',
    async (value, expectedUrl) => {
      vi.stubEnv('VITE_API_BASE_URL', value);
      vi.resetModules();
      const { api: configuredApi } = await import('./api');
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
      vi.stubGlobal('fetch', fetcher);
      await configuredApi('/auth/login', { method: 'POST' });
      expect(fetcher).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({ credentials: 'include', method: 'POST' }),
      );
    },
  );
  it('sends credentials and a session CSRF token on mutation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    setCsrfToken('test-csrf-token');
    await write('/settings', 'PATCH', { theme: 'dark' });
    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/settings');
    expect(options.credentials).toBe('include');
    expect(new Headers(options.headers).get('X-CSRF-Token')).toBe('test-csrf-token');
  });
  it('rejects malformed success data instead of replacing it with fixture', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { count: 'invented' } }), { status: 200 }),
        ),
    );
    await expect(api('/dashboard', {}, z.object({ count: z.number() }))).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
  });
  it('preserves error code and request correlation without exposing a stack', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'UNAVAILABLE', message: '数据源不可用', requestId: 'test-request' },
          }),
          { status: 503 },
        ),
      ),
    );
    await expect(api('/sources')).rejects.toMatchObject({
      status: 503,
      code: 'UNAVAILABLE',
      requestId: 'test-request',
    });
  });
  it('classifies network failure without synthesizing statistics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(api('/dashboard')).rejects.toBeInstanceOf(ApiError);
  });
});
describe('evidence presentation', () => {
  it('rejects executable and nonweb evidence URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('file:///etc/passwd')).toBeUndefined();
    expect(safeUrl('https://example.com/evidence')).toBe('https://example.com/evidence');
  });
  it('keeps unknown data distinct from a zero observation', () => {
    expect(number(null)).toBe('—');
    expect(number(0)).toBe('0');
  });
});
