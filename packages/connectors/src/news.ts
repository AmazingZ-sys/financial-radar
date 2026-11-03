import { isIP } from 'node:net';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { fetchPublicHttps } from '@radar/config';
import { ResilientHttp, ConnectorError } from './http.js';
import type {
  Connector,
  Cursor,
  FetchResult,
  NormalizedEvent,
  RawItem,
  SourceMetadata,
} from './types.js';

export const NEWS_PRESETS = [
  {
    id: 'ecb-rss',
    name: '欧洲央行 · 政策与公告',
    categories: ['macro', 'finance'],
    feedUrl: 'https://www.ecb.europa.eu/rss/press.html',
    officialUrl: 'https://www.ecb.europa.eu/home/html/rss.en.html',
    description: '欧洲央行新闻稿、演讲、采访与记者会文字；官方发布时间不等于政策生效时间。',
    pollIntervalSeconds: 120,
    trust: 0.96,
    licenseStatus: 'official-public',
    verified: true,
  },
  {
    id: 'bbc-world-rss',
    name: 'BBC · 全球热点',
    categories: ['world'],
    feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    officialUrl: 'https://support.bbc.co.uk/platform/feeds/NewsFeeds.htm',
    description: 'BBC 全球新闻标题与摘要；内部研究使用，商业再分发需许可。',
    pollIntervalSeconds: 300,
    trust: 0.8,
    licenseStatus: 'internal-research-only',
    verified: false,
  },
  {
    id: 'bbc-business-rss',
    name: 'BBC · 财经市场',
    categories: ['finance', 'macro'],
    feedUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    officialUrl: 'https://support.bbc.co.uk/platform/feeds/NewsFeeds.htm',
    description: 'BBC 公司、经济与商业新闻；内部研究使用，商业再分发需许可。',
    pollIntervalSeconds: 300,
    trust: 0.8,
    licenseStatus: 'internal-research-only',
    verified: false,
  },
  {
    id: 'bbc-technology-rss',
    name: 'BBC · 科技动态',
    categories: ['technology'],
    feedUrl: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
    officialUrl: 'https://support.bbc.co.uk/platform/feeds/NewsFeeds.htm',
    description: 'BBC 科技与产业动态标题、摘要；内部研究使用，商业再分发需许可。',
    pollIntervalSeconds: 300,
    trust: 0.8,
    licenseStatus: 'internal-research-only',
    verified: false,
  },
] satisfies Array<NewsFeedConfig>;

export type NewsFeedConfig = {
  id: string;
  name: string;
  categories: string[];
  feedUrl: string;
  officialUrl?: string;
  description?: string;
  pollIntervalSeconds: number;
  trust?: number;
  licenseStatus?: SourceMetadata['licenseStatus'];
  verified?: boolean;
};
export function categoriesForSource(id: string, categories: string[]): string[] {
  if (NEWS_PRESETS.some((feed) => feed.id === id) || id.startsWith('custom-rss-'))
    return categories;
  if (id === 'fed-rss' || id.includes('treasury'))
    return [...new Set(['macro', 'finance', ...categories])];
  if (id.startsWith('github')) return [...new Set(['technology', 'crypto', ...categories])];
  return [...new Set(['crypto', ...categories])];
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function list(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}
function text(value: unknown): string {
  const raw =
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : textNode(value);
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, '')
    .trim();
}
function textNode(value: unknown): string {
  const node = record(value);
  return typeof node['#text'] === 'string' ? node['#text'] : '';
}
function published(value: unknown): string | null {
  const raw = text(value);
  // A calendar date or a timezone-less string cannot establish a publication instant.
  if (!/\d{1,2}:\d{2}/.test(raw) || !/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(raw)) return null;
  const time = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function articleUrl(value: unknown, feedUrl: string): string | null {
  try {
    const url = new URL(text(value), feedUrl);
    if (!text(value) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return null;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(host) || !host.includes('.') || /\.(?:localhost|local|internal|invalid)$/.test(host))
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
/** Feed links are evidence only; no article fetch or full-text scraping occurs. */
export function parseNewsFeed(xml: string, feedUrl: string): RawItem[] {
  if (Buffer.byteLength(xml) > 2_000_000) throw new ConnectorError('RSS/Atom 超过2MB', 'SCHEMA');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw new ConnectorError('RSS/Atom 禁止 DTD 与实体声明', 'SCHEMA');
  if (XMLValidator.validate(xml) !== true)
    throw new ConnectorError('RSS/Atom XML 格式无效', 'SCHEMA');
  const parsed = record(
    new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      processEntities: false,
      parseTagValue: false,
      trimValues: true,
    }).parse(xml),
  );
  const rss = record(record(parsed.rss).channel);
  const atom = record(parsed.feed);
  if (!parsed.rss && !parsed.feed)
    throw new ConnectorError('仅支持 RSS 2.0 或 Atom 订阅', 'SCHEMA');
  if (parsed.rss && !Object.hasOwn(record(parsed.rss), 'channel'))
    throw new ConnectorError('RSS 缺少 channel', 'SCHEMA');
  const entries = parsed.rss ? list(rss.item) : list(atom.entry);
  if (entries.length > 500) throw new ConnectorError('RSS/Atom 条目数超过500', 'SCHEMA');
  const items: RawItem[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = record(value);
    const title = text(entry.title).slice(0, 1000);
    const link = parsed.rss
      ? entry.link
      : list(entry.link)
          .map(record)
          .find((item) => !item['@_rel'] || item['@_rel'] === 'alternate')?.['@_href'];
    const url = articleUrl(link, feedUrl);
    if (!title || !url) continue;
    const externalId = (text(entry.guid ?? entry.id) || url).slice(0, 2000);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    items.push({
      externalId,
      payload: {
        title,
        url,
        description: text(entry.description ?? entry.summary).slice(0, 4000),
        rawItem: entry,
      },
      publishedAt: published(entry.pubDate ?? entry.published ?? entry.updated ?? entry.date),
    });
  }
  return items;
}

export class NewsRssConnector implements Connector {
  metadata: SourceMetadata;
  capabilities = {
    history: false,
    checkpoint: true,
    scope: 'partial' as const,
    sourceTimestamp: true,
  };
  rateLimit = { maxRequests: 1, windowMs: 60_000, respectRetryAfter: true };
  private http: ResilientHttp;
  constructor(
    public readonly feed: NewsFeedConfig,
    fetcher: typeof fetch = (input, init) =>
      fetchPublicHttps(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        init,
      ),
  ) {
    this.metadata = {
      id: feed.id,
      name: feed.name,
      categories: feed.categories,
      officialUrl: feed.officialUrl ?? feed.feedUrl,
      transport: 'pull',
      mode: 'live',
      trust: feed.trust ?? 0.5,
      pollIntervalSeconds: Math.max(60, feed.pollIntervalSeconds),
      licenseStatus: feed.licenseStatus ?? 'authorization-required',
    };
    this.http = new ResilientHttp(fetcher, undefined, undefined, 60_000);
  }
  async initialize() {}
  async shutdown() {}
  async healthCheck() {
    return {
      status: 'healthy' as const,
      detail: this.feed.description ?? '管理员订阅；来源与许可需自行核实，连接状态由实际采集决定',
    };
  }
  async fetch(cursor: Cursor = {}): Promise<FetchResult> {
    const headers: Record<string, string> = {
      'User-Agent': 'FinancialRadar/1.0 (private research)',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
    };
    if (typeof cursor.etag === 'string') headers['If-None-Match'] = cursor.etag;
    if (typeof cursor.lastModified === 'string') headers['If-Modified-Since'] = cursor.lastModified;
    const response = await this.http.request(this.feed.feedUrl, { headers }, { attempts: 1 });
    if (response.status === 304) return { items: [], cursor };
    return {
      items: parseNewsFeed(await response.text(), this.feed.feedUrl),
      cursor: {
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        lastFetchedAt: new Date().toISOString(),
      },
    };
  }
  normalize(item: RawItem): NormalizedEvent {
    if (
      this.feed.verified &&
      new URL(String(item.payload.url)).hostname !== new URL(this.feed.feedUrl).hostname
    )
      throw new ConnectorError('官方订阅条目链接不属于已核实来源', 'SCHEMA');
    return {
      sourceId: this.metadata.id,
      externalId: item.externalId,
      title: String(item.payload.title),
      description: String(item.payload.description),
      originalUrl: String(item.payload.url),
      sourcePublishedAt: item.publishedAt,
      eventOccurredAt: null,
      assets: [],
      categories: this.metadata.categories,
      eventType: this.feed.verified ? 'OFFICIAL_ANNOUNCEMENT' : 'NEWS',
      confidence: this.metadata.trust,
      severity: 'P3',
      verificationStatus: this.feed.verified ? 'VERIFIED' : 'UNVERIFIED',
      dataMode: 'live',
    };
  }
}
