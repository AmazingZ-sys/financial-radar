import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ResilientHttp, ConnectorError } from './http.js';
import type { Connector, SourceMetadata, Cursor, RawItem, NormalizedEvent } from './types.js';
const maturities = [
  { field: 'BC_2YEAR', asset: 'US2Y', name: '美国2年期国债' },
  { field: 'BC_10YEAR', asset: 'US10Y', name: '美国10年期国债' },
  { field: 'BC_30YEAR', asset: 'US30Y', name: '美国30年期国债' },
] as const;
export function parseTreasuryXml(xml: string): RawItem[] {
  if (xml.length > 10_000_000 || XMLValidator.validate(xml) !== true)
    throw new ConnectorError('Treasury XML无效或过大', 'SCHEMA');
  const body = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    processEntities: false,
  }).parse(xml) as { feed?: { entry?: unknown | unknown[] } };
  if (!Object.prototype.hasOwnProperty.call(body, 'feed'))
    throw new ConnectorError('Treasury XML缺少feed', 'SCHEMA');
  if (!body.feed || typeof body.feed !== 'object') return [];
  const entries = body.feed.entry
    ? Array.isArray(body.feed.entry)
      ? body.feed.entry
      : [body.feed.entry]
    : [];
  const items: RawItem[] = [];
  for (const entry of entries) {
    const record = entry as { content?: { properties?: Record<string, unknown> } };
    const fields = record.content?.properties;
    if (!fields) throw new ConnectorError('Treasury XML缺少properties', 'SCHEMA');
    const cell = (field: string) => {
      const raw = fields[field];
      return typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['#text']
        : raw;
    };
    const date = String(cell('NEW_DATE') ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)))
      throw new ConnectorError('Treasury数据日期无效', 'SCHEMA');
    for (const maturity of maturities) {
      const raw = cell(maturity.field);
      if (raw == null || raw === '') continue; // Missing maturity is unknown, never zero-filled.
      const value = String(raw);
      if (!/^-?\d+(\.\d+)?$/.test(value))
        throw new ConnectorError('Treasury收益率值无效', 'SCHEMA');
      items.push({
        externalId: `${maturity.asset}:${date}:${value}`,
        publishedAt: null,
        payload: {
          asset: maturity.asset,
          name: maturity.name,
          value,
          sourceDate: date,
          frequency: 'daily',
          publicationTimeKnown: false,
          unit: '%',
          precision: value.includes('.') ? value.split('.')[1]!.length : 0,
          originalFields: fields,
          rawEntry: entry,
        },
      });
    }
  }
  return items;
}
export class TreasuryDailyConnector implements Connector {
  metadata: SourceMetadata = {
    id: 'treasury-daily',
    name: 'U.S. Treasury · 日度收益率',
    officialUrl: 'https://home.treasury.gov/treasury-daily-interest-rate-xml-feed',
    transport: 'pull',
    mode: 'live',
    categories: ['宏观', '美国国债'],
    trust: 0.99,
    pollIntervalSeconds: 3600,
    licenseStatus: 'official-public',
  };
  capabilities = {
    history: true,
    checkpoint: true,
    scope: 'partial' as const,
    sourceTimestamp: false,
  };
  rateLimit = { maxRequests: 1, windowMs: 1000, respectRetryAfter: true };
  private http: ResilientHttp;
  constructor(
    fetcher: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
  ) {
    this.http = new ResilientHttp(fetcher);
  }
  async initialize() {}
  async shutdown() {}
  async healthCheck() {
    return {
      status: 'healthy' as const,
      detail: '官方日度参考收益率，含2Y/10Y/30Y；来源日已知、精确发布时间未知，不是实时成交行情',
    };
  }
  async fetch(cursor: Cursor = {}) {
    const now = this.now();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const previous = new Date(Date.UTC(year, month - 1, 1));
    const months = [
      ...new Set([
        `${previous.getUTCFullYear()}${String(previous.getUTCMonth() + 1).padStart(2, '0')}`,
        `${year}${String(month + 1).padStart(2, '0')}`,
      ]),
    ];
    const items: RawItem[] = [];
    for (const sourceMonth of months) {
      const sourceUrl = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${sourceMonth}`;
      const response = await this.http.request(sourceUrl, {
        headers: {
          Accept: 'application/xml, text/xml',
          'User-Agent': 'FinancialRadar/1.0 (private research)',
        },
      });
      const xml = await response.text();
      for (const item of parseTreasuryXml(xml))
        items.push({ ...item, payload: { ...item.payload, sourceUrl, rawXml: xml } });
    }
    // Date is a source data period, not an exact publication timestamp. Revisit current/previous months for revisions.
    return {
      items,
      cursor: {
        ...cursor,
        lastSampledAt: now.toISOString(),
        sourceMonths: months,
        coverage: '2Y/10Y/30Y-current-and-previous-month',
      },
    };
  }
  normalize(item: RawItem): NormalizedEvent {
    const p = item.payload;
    return {
      sourceId: this.metadata.id,
      externalId: item.externalId,
      title: `${p.name} · ${p.sourceDate} 日度参考收益率`,
      description:
        '美国财政部日度Par Yield Curve参考值，单位为百分比。来源只提供数据日期，精确对外发布时间未知；不代表实时债券成交价。',
      eventType: 'MARKET_SNAPSHOT',
      originalUrl: String(p.sourceUrl ?? this.metadata.officialUrl),
      sourcePublishedAt: null,
      eventOccurredAt: null,
      assets: [String(p.asset)],
      categories: this.metadata.categories,
      confidence: 0.99,
      severity: 'P3',
      verificationStatus: 'VERIFIED',
      dataMode: 'live',
      metrics: {
        value: String(p.value),
        name: String(p.name),
        unit: '%',
        frequency: 'daily',
        sourceDate: String(p.sourceDate),
        precision: Number(p.precision),
        delayLabel: '日度参考收益率 · 发布时间未知',
        publicationTimeKnown: 'false',
      },
    };
  }
}
