import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import {
  assertPublicHttpsUrl,
  fetchPublicHttps,
  fetchPublicHttpsStream,
  isPublicAddress,
} from './outbound.js';

describe('public integration network boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('rejects private, mapped IPv4, local and reserved addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.31.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '192.88.99.1',
      '::1',
      '::ffff:8.8.8.8',
      'fc00::1',
      '2001:db8::1',
      '2001:20::1',
      '2002:808:808::1',
      '3fff:1::1',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects unsafe syntax and mixed public/private DNS results before sending', async () => {
    for (const address of [
      'http://example.org',
      'https://user:pass@example.org',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
    ])
      await expect(assertPublicHttpsUrl(address)).rejects.toThrow();
    mocks.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(fetchPublicHttps('https://example.org')).rejects.toThrow('私有');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('pins the validated DNS answer and preserves 304 for conditional feeds', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    let pinned: unknown;
    mocks.request.mockImplementation((_url, options, callback) => {
      options.lookup('example.org', {}, (...result: unknown[]) => {
        pinned = result;
      });
      const req = new EventEmitter() as EventEmitter & { end(): void; setTimeout(): void };
      req.setTimeout = () => {};
      req.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: object;
        };
        response.statusCode = 304;
        response.headers = { etag: 'version-1' };
        callback(response);
        queueMicrotask(() => response.emit('end'));
      };
      return req;
    });
    const response = await fetchPublicHttps('https://example.org/feed');
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('version-1');
    expect(pinned).toEqual([null, '8.8.8.8', 4]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it('rejects redirects and oversized bodies without following a new endpoint', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    for (const status of [302, 200]) {
      mocks.request.mockImplementation((_url, _options, callback) => {
        const req = new EventEmitter() as EventEmitter & { end(): void; setTimeout(): void };
        req.setTimeout = () => {};
        req.end = () => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: object;
            destroy(): void;
          };
          response.statusCode = status;
          response.headers = { location: 'https://127.0.0.1/internal' };
          response.destroy = () => {};
          callback(response);
          if (status === 200)
            queueMicrotask(() => response.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1)));
        };
        return req;
      });
      await expect(fetchPublicHttps('https://example.org/feed')).rejects.toThrow(
        status === 302 ? '重定向' : '2MB',
      );
    }
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it('pins all validated IPv6 and IPv4 answers for connection fallback without resolving again', async () => {
    const approved = [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ];
    mocks.lookup.mockResolvedValue(approved);
    const resolved: unknown[] = [];
    mocks.request.mockImplementation((_url, options, callback) => {
      options.lookup('example.org', { all: true }, (...result: unknown[]) => resolved.push(result));
      options.lookup('example.org', {}, (...result: unknown[]) => resolved.push(result));
      const req = new EventEmitter() as EventEmitter & { end(): void; setTimeout(): void };
      req.setTimeout = () => {};
      req.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: object;
        };
        response.statusCode = 204;
        response.headers = {};
        callback(response);
        queueMicrotask(() => response.emit('end'));
      };
      return req;
    });
    await expect(fetchPublicHttps('https://example.org/feed')).resolves.toHaveProperty(
      'status',
      204,
    );
    expect(resolved).toEqual([
      [null, approved],
      [null, '1.1.1.1', 4],
    ]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
});

describe('public HTTPS streaming transport', () => {
  function setup(statusCode = 200) {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const upstream = Object.assign(new PassThrough(), {
      statusCode,
      headers: { 'content-type': 'text/event-stream' },
    });
    const req = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      write: vi.fn(),
      setTimeout: vi.fn(),
      destroy: vi.fn(),
    });
    req.end.mockImplementation(() => {
      const callback = mocks.request.mock.calls.at(-1)![2];
      callback(upstream);
    });
    mocks.request.mockReturnValue(req);
    return { upstream, req };
  }

  beforeEach(() => vi.clearAllMocks());

  it('returns headers before EOF and delivers chunks while retaining DNS pinning', async () => {
    const { upstream, req } = setup();
    const response = await fetchPublicHttpsStream('https://example.org/v1/chat/completions', {
      method: 'POST',
      body: '{"stream":true}',
    });
    expect(upstream.readableEnded).toBe(false);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(req.write).toHaveBeenCalledWith('{"stream":true}');
    const reader = response.body!.getReader();
    const first = reader.read();
    upstream.write('data: hello\n\n');
    expect(new TextDecoder().decode((await first).value)).toBe('data: hello\n\n');
    const last = reader.read();
    upstream.end('data: [DONE]\n\n');
    expect(new TextDecoder().decode((await last).value)).toBe('data: [DONE]\n\n');
    expect((await reader.read()).done).toBe(true);
    const options = mocks.request.mock.calls[0]![1];
    const pinned = vi.fn();
    options.lookup('example.org', {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it('closes the underlying response and request when the reader cancels', async () => {
    const { upstream, req } = setup();
    const response = await fetchPublicHttpsStream('https://example.org/v1');
    await response.body!.cancel();
    expect(upstream.destroyed).toBe(true);
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  it('errors a reader on a request abort after response headers', async () => {
    const { upstream, req } = setup();
    const response = await fetchPublicHttpsStream('https://example.org/v1');
    const pending = response.body!.getReader().read();
    req.emit('error', new Error('untrusted transport error')); // Native HTTPS emits on abort.
    await expect(pending).rejects.toThrow('外部 HTTPS 请求失败或超时');
    expect(upstream.destroyed).toBe(true);
  });

  it('rejects premature EOF and oversized streamed bodies', async () => {
    let { upstream } = setup();
    let response = await fetchPublicHttpsStream('https://example.org/v1');
    let pending = response.body!.getReader().read();
    upstream.destroy();
    await expect(pending).rejects.toThrow('中断');
    ({ upstream } = setup());
    response = await fetchPublicHttpsStream('https://example.org/v1');
    pending = response.body!.getReader().read();
    upstream.write(Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(pending).rejects.toThrow('2MB');
    expect(upstream.destroyed).toBe(true);
  });

  it('rejects redirects and aborted requests before sending any credentials', async () => {
    const { upstream } = setup(302);
    await expect(fetchPublicHttpsStream('https://example.org/v1')).rejects.toThrow('重定向');
    expect(upstream.destroyed).toBe(true);
    mocks.request.mockClear();
    await expect(
      fetchPublicHttpsStream('https://example.org/v1', { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
