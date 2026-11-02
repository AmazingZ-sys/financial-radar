import { describe, expect, it, vi } from 'vitest';
import { ResilientHttp, retryAfterMs, ConnectorError } from './http.js';
import { FixtureConnector, fixtureEvents } from './fixture.js';
import {
  createRegistry,
  DexScreenerConnector,
  GitHubReleasesConnector,
  UniSatBrc20Connector,
} from './index.js';
import { normalizeDexScope, normalizeRepositories } from './scope.js';
describe('source boundaries and recovery', () => {
  it('Fixture remains explicit and checkpoint makes subsequent polls empty', async () => {
    const connector = new FixtureConnector();
    const first = await connector.fetch();
    expect(first.items).toHaveLength(5);
    expect((await connector.fetch(first.cursor)).items).toHaveLength(0);
    expect(first.items.map((raw) => connector.normalize(raw).dataMode)).toEqual(
      Array(5).fill('fixture'),
    );
    expect(fixtureEvents.every((e) => e.originalUrl.includes('example.invalid'))).toBe(true);
  });
  it('does not register fixture sources in live mode', () => {
    expect(
      createRegistry({ dataMode: 'live' })
        .list()
        .some((c) => c.metadata.mode === 'fixture'),
    ).toBe(false);
  });
  it('respects Retry-After and retries transient failures', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response('{}'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const http = new ResilientHttp(fetcher, sleep, () => 10000, 0);
    expect((await http.request('https://example.com')).ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(expect.any(Number));
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(2000);
  });
  it('does not truncate a long platform cooldown and retry too early', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } }));
    const sleep = vi.fn();
    await expect(
      new ResilientHttp(fetcher, sleep, () => 10000, 0).request('https://example.com'),
    ).rejects.toMatchObject({ classification: 'RATE_LIMIT', retryAfterMs: 3600000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('does not retry auth failures and opens circuit after repeated failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const http = new ResilientHttp(
      fetcher,
      async () => {},
      () => 10000,
      0,
    );
    for (let i = 0; i < 5; i++)
      await expect(http.request('https://example.com')).rejects.toBeInstanceOf(ConnectorError);
    await expect(http.request('https://example.com')).rejects.toThrow('熔断');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('parses Retry-After HTTP date and invalid headers safely', () => {
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:01 GMT', Date.parse('2026-01-01T00:00:00Z'))).toBe(
      1000,
    );
    expect(retryAfterMs('broken')).toBe(0);
  });
});
it('keeps rate-limit circuit open across separate persisted job invocations', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } }));
  const http = new ResilientHttp(
    fetcher,
    async () => {},
    () => 10000,
    0,
  );
  await expect(http.request('https://example.com')).rejects.toThrow();
  await expect(http.request('https://example.com')).rejects.toMatchObject({
    retryAfterMs: 3600000,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

describe('configured source scopes', () => {
  it('creates an isolated GitHub connector and checkpoint per repository', async () => {
    const registry = createRegistry({
      dataMode: 'live',
      githubRepositories: ['ordinals/ord', 'Unisat-Wallet/Unisat'],
    });
    const github = registry
      .list()
      .filter((connector) => connector.metadata.id.startsWith('github-releases'));
    expect(github.map((connector) => connector.metadata.id)).toEqual([
      'github-releases',
      'github-releases-unisat-wallet~unisat',
    ]);
    expect(
      new GitHubReleasesConnector(undefined, 'Unisat-Wallet/Unisat').metadata.officialUrl,
    ).toBe('https://github.com/unisat-wallet/unisat');
  });

  it('validates DEX chain and token scope without implying discovery', () => {
    expect(normalizeDexScope('ethereum', ['0x0000000000000000000000000000000000000001'])).toEqual({
      chain: 'ethereum',
      addresses: ['0x0000000000000000000000000000000000000001'],
    });
    expect(() => normalizeDexScope('ethereum', ['not-an-address'])).toThrow();
    expect(() => normalizeDexScope('unknown', [])).toThrow();
    expect(new DexScreenerConnector('solana', []).healthCheck()).resolves.toMatchObject({
      status: 'unconfigured',
    });
  });

  it('retains distinct DEX snapshots under a stable pair project without mixing pools', async () => {
    const connector = new DexScreenerConnector('ethereum', [
      '0x0000000000000000000000000000000000000001',
    ]);
    let poll = 0;
    const request = vi.fn(async () => {
      poll++;
      return new Response(
        JSON.stringify(
          ['pool-a', 'pool-b'].map((pairAddress, index) => ({
            pairAddress,
            url: `https://dexscreener.com/ethereum/${pairAddress}`,
            baseToken: { address: '0x0000000000000000000000000000000000000001', symbol: 'TOKEN' },
            liquidity: { usd: 1000 * poll + index },
            ...(index === 0 ? { volume: { h24: 2000 * poll } } : {}),
          })),
        ),
      );
    });
    (connector as unknown as { http: { request: typeof request } }).http = { request };
    const first = await connector.fetch();
    const second = await connector.fetch(first.cursor);
    const firstPool = connector.normalize(first.items[0]!);
    const laterPool = connector.normalize(second.items[0]!);
    const otherPool = connector.normalize(second.items[1]!);
    expect(firstPool.identity).toBe(first.items[0]!.externalId);
    expect(laterPool.identity).not.toBe(firstPool.identity);
    expect(firstPool.project?.assetKey).toBe('ethereum:pair:pool-a');
    expect(laterPool.project?.assetKey).toBe(firstPool.project?.assetKey);
    expect(otherPool.project?.assetKey).toBe('ethereum:pair:pool-b');
    expect(laterPool.metrics).toEqual({
      liquidityUsd: 2000,
      volumeUsd: 4000,
      volumeWindowSeconds: 86400,
    });
    expect(otherPool.metrics).toEqual({ liquidityUsd: 2001 });
    expect(laterPool.project).toMatchObject({ stage: 'TRADING', conditions: null });
    expect(laterPool.verificationStatus).toBe('UNVERIFIED');
    expect(laterPool.signalType).toBeUndefined();
    expect(laterPool.sourcePublishedAt).toBeNull();
    expect(connector.capabilities).toMatchObject({ scope: 'watchlist', sourceTimestamp: false });
    expect(new UniSatBrc20Connector().capabilities.sourceTimestamp).toBe(false);
  });

  it('normalizes UniSat snapshots with stable project and distinct observation identity', async () => {
    const connector = new UniSatBrc20Connector('test-key');
    let calls = 0;
    const body = (minted: string) => ({
      code: 0,
      data: {
        height: 900 + calls,
        detail: [
          {
            ticker: 'TEST',
            inscriptionId: 'abc123i0',
            deployTime: 1_700_000_000,
            minted,
            max: '100',
            holdersCount: 12,
          },
        ],
      },
    });
    (connector as unknown as { http: { request: () => Promise<Response> } }).http = {
      request: async () => {
        calls++;
        return new Response(JSON.stringify(body(calls > 2 ? '35.0000' : '25.0000')), {
          status: 200,
        });
      },
    };
    const first = await connector.fetch();
    const normalized = connector.normalize(first.items[0]!);
    expect(first.items[0]!.publishedAt).toBeNull();
    expect(normalized.sourcePublishedAt).toBeNull();
    expect(normalized.eventOccurredAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(normalized.project?.assetKey).toBe('bitcoin:brc20:test');
    expect(normalized.identity).toContain(':snapshot:');
    expect(normalized.metrics).toMatchObject({
      mintProgress: 25,
      minted: '25.0',
      max: '100.0',
      holders: 12,
      uniqueParticipants: null,
    });
    expect(normalized.metrics).not.toHaveProperty('participants');
    const second = await connector.fetch();
    expect(second.items[0]!.externalId).not.toBe(first.items[0]!.externalId);
    const normalizedSecond = connector.normalize(second.items[0]!);
    expect(normalizedSecond.project?.assetKey).toBe(normalized.project?.assetKey);
    expect(normalizedSecond.metrics).toMatchObject({ mintProgress: 35, minted: '35.0' });
  });

  it('rejects duplicate or malformed repository scopes', () => {
    expect(normalizeRepositories(['ORDINALS/ORD', 'ordinals/ord'])).toEqual(['ordinals/ord']);
    expect(() =>
      normalizeRepositories(Array.from({ length: 21 }, (_, index) => `owner${index}/repo`)),
    ).toThrow();
  });
});
