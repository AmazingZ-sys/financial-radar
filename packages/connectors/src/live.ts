import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { ResilientHttp, ConnectorError } from './http.js';
import { normalizeDexScope, normalizeRepository } from './scope.js';
import type {
  Connector,
  SourceMetadata,
  Cursor,
  RawItem,
  FetchResult,
  NormalizedEvent,
  CapabilityDescriptor,
} from './types.js';

abstract class PullConnector implements Connector {
  abstract metadata: SourceMetadata;
  capabilities: CapabilityDescriptor = {
    history: false,
    checkpoint: true,
    scope: 'partial' as const,
    sourceTimestamp: true,
  };
  rateLimit = { maxRequests: 1, windowMs: 1000, respectRetryAfter: true };
  protected http = new ResilientHttp();
  async initialize() {}
  async healthCheck(): Promise<{
    status: 'healthy' | 'unconfigured' | 'degraded';
    detail: string;
  }> {
    return { status: 'healthy' as const, detail: '已初始化；真实连接健康由采集结果决定' };
  }
  async shutdown() {}
  abstract fetch(cursor?: Cursor): Promise<FetchResult>;
  abstract normalize(item: RawItem): NormalizedEvent;
  protected base(item: RawItem, input: Partial<NormalizedEvent>): NormalizedEvent {
    return {
      sourceId: this.metadata.id,
      externalId: item.externalId,
      title: '',
      description: '',
      eventType: 'OFFICIAL_ANNOUNCEMENT',
      originalUrl: this.metadata.officialUrl,
      sourcePublishedAt: item.publishedAt,
      eventOccurredAt: null,
      assets: [],
      categories: this.metadata.categories,
      confidence: this.metadata.trust,
      severity: 'P3',
      verificationStatus: 'VERIFIED',
      dataMode: 'live',
      ...input,
    };
  }
}
function validDate(value: unknown) {
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
function decimalString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const parts = text.split('.');
  const integer = parts[0] ?? '';
  const fraction = parts[1] ?? '';
  return `${integer.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '') || '0'}`;
}
function integerMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
function mintProgress(minted: string, max: string): number | null {
  const mintedNumber = Number(minted);
  const maxNumber = Number(max);
  if (!Number.isFinite(mintedNumber) || !Number.isFinite(maxNumber) || maxNumber <= 0) return null;
  return Math.min(100, Math.max(0, (mintedNumber / maxNumber) * 100));
}
function unixTime(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}
export class FedRssConnector extends PullConnector {
  metadata: SourceMetadata = {
    id: 'fed-rss',
    name: 'Federal Reserve · 官方公告',
    officialUrl: 'https://www.federalreserve.gov/feeds/feeds.htm',
    transport: 'pull',
    mode: 'live',
    categories: ['macro', 'finance', '宏观', '美联储'],
    trust: 0.98,
    pollIntervalSeconds: 60,
    licenseStatus: 'official-public',
  };
  async fetch(cursor: Cursor = {}): Promise<FetchResult> {
    const headers: Record<string, string> = {
      'User-Agent': 'FinancialRadar/1.0 (private research)',
      Accept: 'application/rss+xml, application/xml, text/xml',
    };
    if (typeof cursor.etag === 'string') headers['If-None-Match'] = cursor.etag;
    const response = await this.http.request('https://www.federalreserve.gov/feeds/press_all.xml', {
      headers,
    });
    if (response.status === 304) return { items: [], cursor };
    const text = await response.text();
    if (text.length > 2_000_000) throw new ConnectorError('RSS 过大', 'SCHEMA');
    const xml = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(text) as {
      rss?: { channel?: { item?: Record<string, unknown> | Record<string, unknown>[] } };
    };
    const list = xml.rss?.channel?.item;
    if (!list) throw new ConnectorError('RSS 缺少 item', 'SCHEMA');
    const items = (Array.isArray(list) ? list : [list]).map((item) => {
      const url = z.string().url().parse(item.link);
      if (new URL(url).hostname !== 'www.federalreserve.gov')
        throw new ConnectorError('非官方 Fed 链接', 'SCHEMA');
      return {
        externalId: url,
        payload: {
          title: z.string().parse(item.title),
          description: String(item.description ?? '').replace(/<[^>]*>/g, ''),
          url,
        },
        publishedAt: validDate(item.pubDate),
      };
    });
    return {
      items,
      cursor: { etag: response.headers.get('etag'), lastFetchedAt: new Date().toISOString() },
    };
  }
  normalize(item: RawItem) {
    return this.base(item, {
      title: String(item.payload.title),
      description: String(item.payload.description),
      originalUrl: String(item.payload.url),
      severity: 'P2',
      assets: ['USD', 'US10Y', 'XAU'],
      eventType: 'OFFICIAL_ANNOUNCEMENT',
    });
  }
}
const ReleaseSchema = z.object({
  id: z.number(),
  html_url: z.string().url(),
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable().optional(),
  published_at: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});
const Brc20StatusSchema = z.object({
  code: z.number(),
  data: z.object({
    height: z.number().optional(),
    total: z.number().int().nonnegative().optional(),
    detail: z.array(
      z
        .object({
          ticker: z.string().optional(),
          tick: z.string().optional(),
          inscriptionId: z.string(),
          deployTime: z.number().optional(),
          deployBlocktime: z.number().optional(),
          minted: z.string().optional(),
          totalMinted: z.string().optional(),
          max: z.string().optional(),
          holdersCount: z.number().optional(),
        })
        .passthrough(),
    ),
  }),
});
const UNISAT_LOOKBACK_MS = 7 * 24 * 3600_000;
const UNISAT_MAX_SNAPSHOTS = 2000;
const UniSatCheckpointSchema = z.object({
  version: z.literal(2),
  batchSequence: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  snapshots: z.record(
    z.string(),
    z.object({
      fingerprint: z.string(),
      lastSeenAt: z.iso.datetime(),
      deployTime: z.number().int().nonnegative(),
    }),
  ),
});
export class GitHubReleasesConnector extends PullConnector {
  metadata: SourceMetadata = {
    id: 'github-releases',
    name: 'GitHub · 协议发布',
    officialUrl: 'https://github.com/ordinals/ord',
    transport: 'pull',
    mode: 'live',
    categories: ['technology', 'crypto', 'Bitcoin', '协议动态'],
    trust: 0.92,
    pollIntervalSeconds: 300,
    licenseStatus: 'official-public',
  };
  constructor(
    private token?: string,
    private repository = 'ordinals/ord',
  ) {
    super();
    this.repository = normalizeRepository(repository);
    this.metadata = {
      ...this.metadata,
      id:
        this.repository === 'ordinals/ord'
          ? 'github-releases'
          : `github-releases-${this.repository.replace('/', '~')}`,
      name: `GitHub · ${this.repository} 发布`,
      officialUrl: `https://github.com/${this.repository}`,
      categories:
        this.repository === 'ordinals/ord'
          ? ['technology', 'crypto', 'Bitcoin', '协议动态']
          : ['technology', 'crypto', '协议动态'],
    };
  }
  async fetch(cursor: Cursor = {}) {
    if (typeof cursor.repository === 'string' && cursor.repository !== this.repository)
      throw new ConnectorError('GitHub checkpoint 与仓库不匹配', 'SCHEMA');
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'FinancialRadar',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (typeof cursor.etag === 'string') headers['If-None-Match'] = cursor.etag;
    const response = await this.http.request(
      `https://api.github.com/repos/${this.repository}/releases?per_page=30`,
      { headers },
    );
    if (response.status === 304) return { items: [], cursor };
    const releases = z.array(ReleaseSchema).parse(await response.json());
    return {
      items: releases
        .filter((r) => !r.draft)
        .map((r) => ({
          externalId: String(r.id),
          publishedAt: validDate(r.published_at),
          payload: { ...r, repository: this.repository },
        })),
      cursor: {
        repository: this.repository,
        etag: response.headers.get('etag'),
        lastId: releases[0]?.id,
        remaining: response.headers.get('x-ratelimit-remaining'),
      },
    };
  }
  normalize(item: RawItem) {
    return this.base(item, {
      title: `${this.repository} · ${item.payload.name || item.payload.tag_name}`,
      description: String(item.payload.body ?? '').slice(0, 12000),
      originalUrl: String(item.payload.html_url),
      assets: this.repository === 'ordinals/ord' ? ['BTC'] : [],
      eventType: 'PROTOCOL_RELEASE',
      signalType: 'OFFICIAL_ANNOUNCEMENT',
      severity: 'P2',
    });
  }
}
const TickerSchema = z.object({
  trade_id: z.number(),
  price: z.string().regex(/^\d+(\.\d+)?$/),
  time: z.string(),
  volume: z.string().optional(),
});
export class CoinbaseMarketsConnector extends PullConnector {
  metadata: SourceMetadata = {
    id: 'coinbase-markets',
    name: 'Coinbase Exchange · 内部研究行情',
    officialUrl: 'https://docs.cdp.coinbase.com/exchange',
    transport: 'pull',
    mode: 'live',
    categories: ['crypto', '数字资产', '行情'],
    trust: 0.98,
    pollIntervalSeconds: 60,
    licenseStatus: 'internal-research-only',
  };
  capabilities = {
    history: false,
    checkpoint: true,
    scope: 'partial' as const,
    sourceTimestamp: true,
  };
  async fetch() {
    const items: RawItem[] = [];
    for (const symbol of ['BTC', 'ETH', 'SOL']) {
      const response = await this.http.request(
        `https://api.exchange.coinbase.com/products/${symbol}-USD/ticker`,
        { headers: { Accept: 'application/json', 'User-Agent': 'FinancialRadar' } },
      );
      const r = TickerSchema.parse(await response.json());
      items.push({
        externalId: `${symbol}:${r.trade_id}`,
        payload: { ...r, symbol },
        publishedAt: validDate(r.time),
      });
    }
    return { items, cursor: { fetchedAt: new Date().toISOString() } };
  }
  normalize(item: RawItem) {
    return this.base(item, {
      title: `${item.payload.symbol} / USD 行情采样`,
      description: 'Coinbase Exchange 最后成交快照，仅限内部研究。',
      eventType: 'MARKET_SNAPSHOT',
      assets: [String(item.payload.symbol)],
      originalUrl: `https://api.exchange.coinbase.com/products/${item.payload.symbol}-USD/ticker`,
      metrics: {
        value: String(item.payload.price),
        unit: 'USD',
        volume: String(item.payload.volume ?? ''),
      },
      eventOccurredAt: item.publishedAt,
    });
  }
}
export class UniSatBrc20Connector extends PullConnector {
  capabilities = {
    history: false,
    checkpoint: true,
    scope: 'partial' as const,
    sourceTimestamp: false,
  };
  metadata: SourceMetadata = {
    id: 'unisat-brc20',
    name: 'UniSat · BRC-20 部署索引',
    officialUrl: 'https://unisat.io/open-api',
    transport: 'pull',
    mode: 'live',
    categories: ['crypto', 'Bitcoin', 'BRC-20'],
    trust: 0.8,
    pollIntervalSeconds: 120,
    licenseStatus: 'authorization-required',
  };
  constructor(
    private apiKey?: string,
    fetcher: typeof fetch = fetch,
  ) {
    super();
    this.http = new ResilientHttp(fetcher, undefined, undefined, 1000);
  }
  async healthCheck() {
    return this.apiKey
      ? { status: 'healthy' as const, detail: '密钥已配置，采集结果决定连接健康' }
      : { status: 'unconfigured' as const, detail: '需要获授权 UniSat API Key' };
  }
  async fetch(cursor: Cursor = {}) {
    if (!this.apiKey) throw new ConnectorError('UniSat API Key 未配置', 'AUTH');
    const requestStatus = async (complete: 'no' | 'yes', limit: number, start = 0) => {
      const response = await this.http.request(
        `https://open-api.unisat.io/v1/indexer/brc20/status?start=${start}&limit=${limit}&sort=deploy&complete=${complete}`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      const body = Brc20StatusSchema.parse(await response.json());
      if (body.code !== 0) throw new ConnectorError('UniSat 返回业务错误', 'PERMANENT');
      return body;
    };
    // The API documents deploy sorting but not its direction. Read both ends
    // using its documented offset/total fields, then select by deployment time.
    const requestCandidates = async (complete: 'no' | 'yes', limit: number) => {
      const head = await requestStatus(complete, limit);
      const tail =
        head.data.total !== undefined && head.data.total > limit
          ? await requestStatus(complete, limit, head.data.total - limit)
          : null;
      const rows = [...head.data.detail, ...(tail?.data.detail ?? [])];
      return {
        rows: [...new Map(rows.map((row) => [row.inscriptionId, row])).values()],
        height: head.data.height ?? tail?.data.height ?? null,
      };
    };
    const incomplete = await requestCandidates('no', 50);
    const completed = await requestCandidates('yes', 20);
    const snapshotAt = Date.now();
    const observedAt = new Date(snapshotAt).toISOString();
    const cutoff = snapshotAt - UNISAT_LOOKBACK_MS;
    const recent = (rows: typeof incomplete.rows, limit: number) =>
      rows
        .filter((row) => {
          const time = row.deployTime ?? row.deployBlocktime;
          return (
            typeof time === 'number' &&
            Number.isSafeInteger(time) &&
            time * 1000 >= cutoff &&
            time * 1000 <= snapshotAt
          );
        })
        .sort(
          (a, b) =>
            (b.deployTime ?? b.deployBlocktime)! - (a.deployTime ?? a.deployBlocktime)! ||
            a.inscriptionId.localeCompare(b.inscriptionId),
        )
        .slice(0, limit);
    const rows = [...recent(incomplete.rows, 50), ...recent(completed.rows, 20)];
    const uniqueRows = [...new Map(rows.map((row) => [row.inscriptionId, row])).values()];
    const saved = UniSatCheckpointSchema.safeParse(cursor);
    const batchSequence = (saved.success ? saved.data.batchSequence : 0) + 1;
    const snapshots = new Map(
      Object.entries(saved.success ? saved.data.snapshots : {}).filter(
        ([, state]) => state.deployTime * 1000 >= cutoff && state.deployTime * 1000 <= snapshotAt,
      ),
    );
    const items: RawItem[] = [];
    for (const r of uniqueRows) {
      const deployTime = (r.deployTime ?? r.deployBlocktime)!;
      if (deployTime * 1000 < cutoff || deployTime * 1000 > snapshotAt) continue;
      const assetIdentity = `bitcoin:brc20:${String(r.ticker ?? r.tick ?? r.inscriptionId).toLowerCase()}`;
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            assetIdentity,
            r.inscriptionId,
            deployTime,
            decimalString(r.minted ?? r.totalMinted),
            decimalString(r.max),
            integerMetric(r.holdersCount),
          ]),
        )
        .digest('hex');
      const previous = snapshots.get(r.inscriptionId);
      snapshots.set(r.inscriptionId, { fingerprint, lastSeenAt: observedAt, deployTime });
      if (previous?.fingerprint === fingerprint) continue;
      items.push({
        // The committed batch sequence makes partial-batch retries idempotent
        // while allowing a genuine A -> B -> A state change to be observed.
        externalId: `${assetIdentity}:snapshot:v2:${batchSequence}:${r.inscriptionId}:${fingerprint}`,
        payload: {
          ...r,
          assetIdentity,
          observedAt,
          stateFingerprint: fingerprint,
          previousStateFingerprint: previous?.fingerprint ?? null,
          previousStateObservedAt: previous?.lastSeenAt ?? null,
        },
        publishedAt: null,
      });
    }
    return {
      items,
      cursor: {
        ...cursor,
        version: 2,
        batchSequence,
        snapshots: Object.fromEntries(
          [...snapshots.entries()]
            .sort((a, b) => b[1].lastSeenAt.localeCompare(a[1].lastSeenAt))
            .slice(0, UNISAT_MAX_SNAPSHOTS),
        ),
        checkedAt: observedAt,
        scope: 'recent-7d-latest-50-incomplete-plus-completed-20-head-tail',
        lookbackSeconds: UNISAT_LOOKBACK_MS / 1000,
        indexedHeight: incomplete.height ?? completed.height,
      },
    };
  }
  normalize(item: RawItem) {
    const name = String(item.payload.ticker ?? item.payload.tick ?? '未知');
    const assetKey = String(item.payload.assetIdentity ?? `bitcoin:brc20:${name.toLowerCase()}`);
    const minted = decimalString(item.payload.minted ?? item.payload.totalMinted);
    const max = decimalString(item.payload.max);
    const holders = integerMetric(item.payload.holdersCount);
    const progress = minted !== null && max !== null ? mintProgress(minted, max) : null;
    const deployTime = unixTime(item.payload.deployTime ?? item.payload.deployBlocktime);
    const snapshot = String(item.externalId.split(':snapshot:')[1] ?? item.externalId);
    return this.base(item, {
      title: `BRC-20 状态更新 · ${name}`,
      description:
        '索引器提供的近期部署状态；尚未验证项目官方身份与参与规则。仅监控近7天部署，最多50个未完成及20个已完成候选，状态变化时记录；不能保证全量。',
      eventType: 'TOKEN_STATE_SNAPSHOT',
      originalUrl: `https://unisat.io/inscription/${encodeURIComponent(String(item.payload.inscriptionId ?? name))}`,
      assets: [name],
      chain: 'Bitcoin',
      assetKey,
      identity: `${assetKey}:snapshot:${snapshot}`,
      confidence: 0.65,
      severity: 'P2',
      verificationStatus: 'UNVERIFIED',
      metrics: {
        observedAt: validDate(item.payload.observedAt),
        samplingMode: 'state-changes',
        stateFingerprint:
          typeof item.payload.stateFingerprint === 'string' ? item.payload.stateFingerprint : null,
        previousStateFingerprint:
          typeof item.payload.previousStateFingerprint === 'string'
            ? item.payload.previousStateFingerprint
            : null,
        previousStateObservedAt: validDate(item.payload.previousStateObservedAt),
        ...(progress === null ? {} : { mintProgress: progress }),
        minted,
        max,
        holders,
        uniqueParticipants: null,
      },
      eventOccurredAt: deployTime,
      riskFlags: ['UNVERIFIED_OFFICIAL', 'UNKNOWN_CONTRACT_RISK'],
      project: {
        assetKey,
        name,
        chain: 'Bitcoin',
        protocol: 'BRC-20',
        stage: 'UNVERIFIED',
        conditions: null,
      },
    });
  }
}
export class DexScreenerConnector extends PullConnector {
  capabilities = {
    history: false,
    checkpoint: true,
    scope: 'watchlist' as const,
    sourceTimestamp: false,
  };
  private lastSnapshotAt = 0;
  metadata: SourceMetadata = {
    id: 'dexscreener',
    name: 'DEX Screener · 已知资产池',
    officialUrl: 'https://docs.dexscreener.com/api/reference',
    transport: 'pull',
    mode: 'live',
    categories: ['crypto', 'DEX', '流动性'],
    trust: 0.75,
    pollIntervalSeconds: 60,
    licenseStatus: 'authorization-required',
  };
  constructor(
    private chain = 'solana',
    private addresses: string[] = [],
  ) {
    super();
    const scope = normalizeDexScope(chain, addresses);
    this.chain = scope.chain;
    this.addresses = scope.addresses;
  }
  async healthCheck() {
    return this.addresses.length
      ? { status: 'healthy' as const, detail: '仅监控已配置 token，非全链扫描' }
      : { status: 'unconfigured' as const, detail: '尚未配置获授权观察资产' };
  }
  async fetch(cursor: Cursor = {}) {
    if (!this.addresses.length) return { items: [], cursor };
    const response = await this.http.request(
      `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(this.chain)}/${this.addresses.slice(0, 30).map(encodeURIComponent).join(',')}`,
    );
    const pairs = z
      .array(
        z
          .object({
            pairAddress: z.string(),
            url: z.string().url(),
            baseToken: z.object({ address: z.string(), symbol: z.string() }),
            liquidity: z.object({ usd: z.number().nonnegative().optional() }).optional(),
            volume: z.object({ h24: z.number().nonnegative().optional() }).optional(),
            priceUsd: z.string().optional(),
            pairCreatedAt: z.number().optional(),
          })
          .passthrough(),
      )
      .parse(await response.json());
    const snapshotAt = Math.max(Date.now(), this.lastSnapshotAt + 1);
    this.lastSnapshotAt = snapshotAt;
    return {
      items: pairs.map((r) => ({
        externalId: `${r.pairAddress}:${new Date(snapshotAt).toISOString()}`,
        payload: r,
        publishedAt: null,
      })),
      cursor: { sampledAt: new Date().toISOString() },
    };
  }
  normalize(item: RawItem) {
    const p = item.payload;
    const token = p.baseToken as { symbol: string; address: string };
    const assetKey = `${this.chain}:pair:${String(p.pairAddress)}`;
    const volume = (p.volume as { h24?: number } | undefined)?.h24;
    return this.base(item, {
      title: `${token.symbol} · 池流动性快照`,
      description: '已知资产池采样；采样时间不代表新池创建时间，缺少源发布时间。',
      eventType: 'LIQUIDITY_SNAPSHOT',
      originalUrl: String(p.url),
      assets: [token.symbol],
      chain: this.chain,
      assetKey,
      identity: item.externalId,
      confidence: 0.65,
      verificationStatus: 'UNVERIFIED',
      metrics: {
        liquidityUsd: (p.liquidity as { usd?: number } | undefined)?.usd ?? null,
        ...(typeof volume === 'number' && Number.isFinite(volume) && volume >= 0
          ? { volumeUsd: volume, volumeWindowSeconds: 86400 }
          : {}),
      },
      project: {
        assetKey,
        name: `${token.symbol} · ${String(p.pairAddress)}`,
        chain: this.chain,
        protocol: 'DEX',
        stage: 'TRADING',
        conditions: null,
      },
    });
  }
}
