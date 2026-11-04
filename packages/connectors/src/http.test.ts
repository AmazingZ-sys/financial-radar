import { describe, expect, it, vi } from 'vitest';
import { ResilientHttp } from './http.js';

describe('HTTP failure diagnostics and recovery', () => {
  it.each(['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'CERT_HAS_EXPIRED'])(
    'retains only the safe network code %s from fetch causes',
    async (code) => {
      const secret = 'https://rpc.invalid/private-token?api_key=do-not-log';
      const cause = Object.assign(new Error(secret), { code });
      const fetcher = vi.fn().mockRejectedValue(new TypeError(secret, { cause }));
      const http = new ResilientHttp(
        fetcher,
        async () => {},
        () => 1000,
        0,
      );
      const problem: unknown = await http
        .request(secret, {}, { attempts: 1 })
        .catch((error: unknown) => error);
      expect(problem).toMatchObject({
        message: `数据源网络错误或超时（${code}）`,
        classification: 'TRANSIENT',
      });
      expect(String(problem)).not.toContain(secret);
    },
  );

  it('does not copy arbitrary cause codes or messages into diagnostics', async () => {
    const error = Object.assign(new Error('secret-query?key=do-not-log'), {
      code: 'private-token',
    });
    const http = new ResilientHttp(
      vi.fn().mockRejectedValue(error),
      async () => {},
      () => 1000,
      0,
    );
    await expect(http.request('https://example.com', {}, { attempts: 1 })).rejects.toThrow(
      '数据源网络错误或超时（NETWORK_UNKNOWN）',
    );
  });

  it.each([
    [new DOMException('unsafe message', 'TimeoutError'), 'REQUEST_TIMEOUT'],
    [
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
      'REDIRECT_REJECTED',
    ],
  ])('distinguishes timeout and rejected redirects without error text', async (error, code) => {
    const http = new ResilientHttp(
      vi.fn().mockRejectedValue(error),
      async () => {},
      () => 1000,
      0,
    );
    await expect(http.request('https://example.com', {}, { attempts: 1 })).rejects.toThrow(
      `数据源网络错误或超时（${code}）`,
    );
  });

  it('keeps the HTTP refusal visible while open and clears it after a successful half-open probe', async () => {
    let now = 1000;
    const cancel = vi.fn();
    const fetcher = vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { status: 406 }),
    );
    const http = new ResilientHttp(
      fetcher,
      async () => {},
      () => now,
      0,
    );
    for (let index = 0; index < 5; index++)
      await expect(http.request('https://example.com')).rejects.toThrow('来源 HTTP 406');
    expect(cancel).toHaveBeenCalledTimes(5);
    await expect(http.request('https://example.com')).rejects.toMatchObject({
      message: '数据源熔断，等待半开探测；上次失败：来源 HTTP 406',
      retryAfterMs: 60_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
    now += 60_000;
    fetcher.mockImplementationOnce(async () => new Response('{}'));
    expect((await http.request('https://example.com')).status).toBe(200);
    expect(http.circuitState()).toEqual({ failures: 0, openUntil: 0 });
  });

  it('never shortens Retry-After when repeated failures open the circuit', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 500 }));
    const http = new ResilientHttp(
      fetcher,
      async () => {},
      () => 1000,
      0,
    );
    for (let index = 0; index < 4; index++)
      await expect(http.request('https://example.com', {}, { attempts: 1 })).rejects.toThrow(
        '来源 HTTP 500',
      );
    fetcher.mockImplementationOnce(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    );
    await expect(http.request('https://example.com', {}, { attempts: 1 })).rejects.toMatchObject({
      classification: 'RATE_LIMIT',
      retryAfterMs: 120_000,
    });
    expect(http.circuitState().openUntil).toBe(121_000);
    await expect(http.request('https://example.com')).rejects.toMatchObject({
      message: '数据源熔断，等待半开探测；上次失败：来源 HTTP 429',
      retryAfterMs: 120_000,
    });
  });
});
