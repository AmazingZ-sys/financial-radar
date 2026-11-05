import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XRecentSearchConnector, buildXQuery, type XRecentSearchOptions } from './x.js';
import { ConnectorError } from './http.js';

const now = Date.parse('2026-11-05T10:00:00.000Z');
const oldId = '1800000000000000000';
const latestId = '1800000000000000020';
const pageTwoId = '1800000000000000005';
const options: XRecentSearchOptions = {
  sessionCookies: 'auth_token=synthetic-auth-only; ct0=synthetic-csrf-only',
  collectorUrl: 'http://127.0.0.1:8080',
  collectorSecret: 'synthetic-collector-secret-at-least-32',
  usernames: ['alice', 'bob'],
  keywords: ['new protocol'],
  pollIntervalSeconds: 900,
  maxResults: 10,
};
function post(id = latestId, extra: Record<string, unknown> = {}) {
  return {
    id,
    text: 'A new protocol #Research $TEST',
    authorId: '123456789',
    createdAt: '2026-11-05T09:55:00.000Z',
    originalUrl: `https://x.com/i/web/status/${id}`,
    hashtags: ['Research'],
    cashtags: ['TEST'],
    referencedPosts: [],
    ...extra,
  };
}
function page(posts: ReturnType<typeof post>[], hasMore = false) {
  return Response.json({ posts, hasMore });
}

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());

describe('X literal account search query', () => {
  it('normalizes and sorts the scope and quotes keywords without broadening it', () => {
    expect(
      buildXQuery({ usernames: ['@Alice', 'BOB', 'alice'], keywords: ['new protocol', '$TEST'] }),
    ).toBe('(from:alice OR from:bob) ("$TEST" OR "new protocol") -filter:retweets -filter:replies');
    expect(buildXQuery({ usernames: ['alice'], keywords: ['foo OR bar'] })).toContain(
      '"foo OR bar"',
    );
  });
  it.each(['from:other', '" OR from:other', '(bitcoin)', '-filter:retweets', 'has:links', 'a\\b'])(
    'rejects query operators and escaping in a keyword: %s',
    (keyword) =>
      expect(() => buildXQuery({ usernames: ['alice'], keywords: [keyword] })).toThrow(
        ConnectorError,
      ),
  );
  it('rejects invalid accounts, missing scopes and oversized queries', () => {
    for (const usernames of [[], ['https://x.com/alice'], ['alice OR bob'], ['a'.repeat(16)]])
      expect(() => buildXQuery({ usernames, keywords: [] })).toThrow(ConnectorError);
    expect(() =>
      buildXQuery({
        usernames: Array.from({ length: 20 }, (_, index) => `account_name_${index}`),
        keywords: ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)],
      }),
    ).toThrow('512');
  });
});

describe('X self-hosted bounded collection', () => {
  it('calls only the internal collector with a local reservation and fixed 15-minute window', async () => {
    const order: string[] = [];
    const quota = vi.fn(async () => {
      order.push('quota');
    });
    const fetcher = vi.fn(async () => {
      order.push('fetch');
      return page([post()]);
    });
    const connector = new XRecentSearchConnector(options, fetcher, quota);
    const result = await connector.fetch();
    expect(connector.lastHttpStatus).toBe(200);
    expect(order).toEqual(['quota', 'fetch']);
    expect(quota).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/search');
    expect(url).not.toContain('api.x.com');
    expect(url).not.toContain(options.sessionCookies);
    expect(url).not.toContain(options.collectorSecret);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Bearer ${options.collectorSecret}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      query: '(from:alice OR from:bob) ("new protocol") -filter:retweets -filter:replies',
      sessionCookies: options.sessionCookies,
      maxResults: 10,
      startTime: '2026-11-05T09:45:00.000Z',
      endTime: '2026-11-05T10:00:00.000Z',
    });
    expect(result.cursor).toEqual({ sinceId: latestId });
  });
  it('persists a fixed pagination window and advances sinceId only after the complete batch', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([post()], true))
      .mockResolvedValueOnce(page([post(pageTwoId)]));
    const first = await new XRecentSearchConnector(options, fetcher).fetch({ sinceId: oldId });
    expect(first.cursor).toEqual({
      sinceId: oldId,
      baseSinceId: oldId,
      pendingNewestId: latestId,
      beforeId: latestId,
      endTime: '2026-11-05T10:00:00.000Z',
    });
    vi.spyOn(Date, 'now').mockReturnValue(now + 900_000);
    const second = await new XRecentSearchConnector(options, fetcher).fetch(first.cursor);
    const request = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(request).toMatchObject({
      sinceId: oldId,
      beforeId: latestId,
      endTime: '2026-11-05T10:00:00.000Z',
    });
    expect(request.startTime).toBeUndefined();
    expect(second.cursor).toEqual({ sinceId: latestId });
  });
  it('preserves the initial lookback during paging and keeps an empty completed checkpoint', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([post()], true))
      .mockResolvedValueOnce(page([post(pageTwoId)]))
      .mockResolvedValueOnce(page([]));
    const connector = new XRecentSearchConnector(options, fetcher);
    const first = await connector.fetch();
    expect(first.cursor).toMatchObject({
      startTime: '2026-11-05T09:45:00.000Z',
      pendingNewestId: latestId,
    });
    await connector.fetch(first.cursor);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      startTime: '2026-11-05T09:45:00.000Z',
      endTime: '2026-11-05T10:00:00.000Z',
      beforeId: latestId,
    });
    expect((await connector.fetch({ sinceId: latestId })).cursor).toEqual({ sinceId: latestId });
  });
  it('rejects a repeated or regressing beforeId page instead of looping', async () => {
    const fetcher = vi.fn().mockResolvedValue(page([post()], true));
    await expect(
      new XRecentSearchConnector(options, fetcher).fetch({
        sinceId: oldId,
        baseSinceId: oldId,
        pendingNewestId: latestId,
        beforeId: latestId,
        endTime: '2026-11-05T10:00:00.000Z',
      }),
    ).rejects.toThrow('分页没有向前推进');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    post(oldId),
    post(latestId, { createdAt: '2026-11-05T10:00:00.000Z' }),
    post(latestId, { originalUrl: 'https://example.com/fabricated-source' }),
  ])('rejects evidence outside the saved ID/time bounds or with a forged URL: %j', async (raw) => {
    const connector = new XRecentSearchConnector(options, vi.fn().mockResolvedValue(page([raw])));
    await expect(connector.fetch({ sinceId: oldId })).rejects.toMatchObject({
      classification: 'SCHEMA',
    });
  });
  it('rejects a result before the initial source time window', async () => {
    const connector = new XRecentSearchConnector(
      options,
      vi.fn().mockResolvedValue(page([post(latestId, { createdAt: '2026-11-05T09:44:59.000Z' })])),
    );
    await expect(connector.fetch()).rejects.toMatchObject({ classification: 'SCHEMA' });
  });
  it('deduplicates actual post evidence while preserving author, tags, quotes and publication time', async () => {
    const raw = post(latestId, {
      hashtags: ['Research', 'Research'],
      referencedPosts: [{ id: oldId, type: 'quoted' }],
    });
    const connector = new XRecentSearchConnector(
      options,
      vi.fn().mockResolvedValue(page([raw, raw])),
    );
    const result = await connector.fetch();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.payload).toMatchObject({
      authorId: raw.authorId,
      hashtags: ['Research'],
      cashtags: ['TEST'],
      referencedPosts: [{ id: oldId, type: 'quoted' }],
    });
    expect(connector.normalize(result.items[0]!)).toMatchObject({
      eventType: 'SOCIAL_POST',
      identity: `x:${latestId}`,
      severity: 'P3',
      verificationStatus: 'UNVERIFIED',
      dataMode: 'live',
      assets: [],
      sourcePublishedAt: raw.createdAt,
      metrics: { authorId: raw.authorId },
    });
    expect(connector.normalize(result.items[0]!).project).toBeUndefined();
  });
  it('excludes retweets and replies even if returned despite query exclusions', async () => {
    const connector = new XRecentSearchConnector(
      options,
      vi
        .fn()
        .mockResolvedValue(
          page([
            post(latestId, { referencedPosts: [{ id: oldId, type: 'retweeted' }] }),
            post(pageTwoId, { referencedPosts: [{ id: oldId, type: 'replied_to' }] }),
          ]),
        ),
    );
    expect(await connector.fetch()).toEqual({ items: [], cursor: { sinceId: latestId } });
  });
  it('allows a genuine empty result without inventing a checkpoint', async () => {
    const connector = new XRecentSearchConnector(
      options,
      vi.fn(async () => page([])),
    );
    expect(await connector.fetch()).toEqual({ items: [], cursor: {} });
    expect((await connector.fetch({ sinceId: oldId })).cursor).toEqual({ sinceId: oldId });
  });
  it.each([
    { sessionCookies: '' },
    { usernames: [] },
    { sessionCookies: 'auth_token=only' },
    { sessionCookies: 'auth_token=a; ct0=b; extra=c' },
    { collectorSecret: '' },
    { collectorUrl: 'https://api.x.com' },
    { collectorUrl: 'http://example.com' },
    { collectorUrl: 'http://127.0.0.1:8080/?cookie=oops' },
  ])('rejects missing/unsafe configuration locally: %j', async (invalid) => {
    const fetcher = vi.fn();
    const quota = vi.fn();
    const connector = new XRecentSearchConnector({ ...options, ...invalid }, fetcher, quota);
    expect((await connector.healthCheck()).status).toBe('unconfigured');
    await expect(connector.fetch()).rejects.toMatchObject({ classification: 'AUTH' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
  });
  it('performs health checks without a network call or consuming local quota', async () => {
    const fetcher = vi.fn();
    const quota = vi.fn();
    expect((await new XRecentSearchConnector(options, fetcher, quota).healthCheck()).status).toBe(
      'healthy',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
  });
  it('does not call the collector if the quota rejects or the cursor is malformed', async () => {
    const fetcher = vi.fn();
    const problem = new ConnectorError('今日本地采集次数已用尽', 'RATE_LIMIT', 60000);
    const quota = vi.fn().mockRejectedValue(problem);
    const connector = new XRecentSearchConnector(options, fetcher, quota);
    await expect(connector.fetch()).rejects.toBe(problem);
    for (const cursor of [
      { sinceId: 'invalid' },
      { nextToken: 'legacy-official-token' },
      { beforeId: latestId },
      { beforeId: latestId, baseSinceId: oldId, endTime: '2026-11-05T10:00:00.000Z' },
      {
        beforeId: latestId,
        baseSinceId: oldId,
        startTime: '2026-11-05T09:00:00.000Z',
        pendingNewestId: latestId,
        endTime: '2026-11-05T10:00:00.000Z',
      },
    ])
      await expect(connector.fetch(cursor)).rejects.toMatchObject({ classification: 'SCHEMA' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(quota).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [502, 'TRANSIENT'],
    [503, 'TRANSIENT'],
  ])(
    'classifies HTTP %i without retries or credential-bearing details',
    async (status, classification) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(`private ${options.sessionCookies} ${options.collectorSecret}`, {
          status: Number(status),
        }),
      );
      const quota = vi.fn(async () => undefined);
      const connector = new XRecentSearchConnector(options, fetcher, quota);
      const error = await connector.fetch().catch((problem: unknown) => problem);
      expect(error).toMatchObject({ classification });
      expect(String(error)).not.toContain('synthetic-auth');
      expect(String(error)).not.toContain(options.collectorSecret);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(quota).toHaveBeenCalledTimes(1);
    },
  );
  it('honors the collector rate-limit cooldown', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '120' } }));
    await expect(new XRecentSearchConnector(options, fetcher).fetch()).rejects.toMatchObject({
      classification: 'RATE_LIMIT',
      retryAfterMs: 120000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sanitizes network failures and never falls back to any paid endpoint', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(`private ${options.sessionCookies}`));
    const error = await new XRecentSearchConnector(options, fetcher)
      .fetch()
      .catch((problem: unknown) => problem);
    expect(error).toMatchObject({ classification: 'TRANSIENT' });
    expect(String(error)).not.toContain('synthetic-auth');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8080/v1/search');
  });
  it.each([
    { posts: [post(latestId, { authorId: undefined })], hasMore: false },
    { posts: [post(latestId, { createdAt: undefined })], hasMore: false },
    { posts: [post(latestId, { createdAt: '2026-11-05' })], hasMore: false },
    { posts: [], hasMore: true },
    {},
  ])('rejects incomplete evidence or malformed responses: %j', async (body) => {
    await expect(
      new XRecentSearchConnector(options, vi.fn().mockResolvedValue(Response.json(body))).fetch(),
    ).rejects.toMatchObject({ classification: 'SCHEMA' });
  });
  it('rejects oversized declared and chunked responses before JSON parsing', async () => {
    for (const response of [
      new Response('not-json', { headers: { 'content-length': '2000001' } }),
      new Response('x'.repeat(2000001)),
    ])
      await expect(
        new XRecentSearchConnector(options, vi.fn().mockResolvedValue(response)).fetch(),
      ).rejects.toThrow('2MB');
  });
});
