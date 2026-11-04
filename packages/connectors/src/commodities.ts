import { Unzip, UnzipInflate } from 'fflate';
import { z } from 'zod';
import { ConnectorError, ResilientHttp } from './http.js';
import type {
  Connector,
  Cursor,
  FetchResult,
  NormalizedEvent,
  RawItem,
  SourceMetadata,
} from './types.js';

const goldQuote = z
  .object({
    symbol: z.literal('XAU'),
    currency: z.literal('USD').optional(),
    price: z.number().positive().finite(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .passthrough();

async function boundedText(response: Response, limit: number, timeoutMs: number) {
  if (!response.body) throw new ConnectorError('来源响应为空', 'SCHEMA');
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ConnectorError('来源响应读取超时', 'TRANSIENT'));
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) return text + decoder.decode();
      bytes += part.value.length;
      if (bytes > limit) throw new ConnectorError('来源响应过大', 'SCHEMA');
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class GoldPriceConnector implements Connector {
  metadata: SourceMetadata = {
    id: 'gold-api-xau',
    name: 'Gold API · 黄金现货报价',
    officialUrl: 'https://gold-api.com/docs',
    transport: 'pull',
    mode: 'live',
    categories: ['finance', 'gold', '黄金', '行情'],
    trust: 0.9,
    pollIntervalSeconds: 60,
    licenseStatus: 'internal-research-only',
  };
  capabilities = {
    history: false,
    checkpoint: true,
    scope: 'partial' as const,
    sourceTimestamp: true,
  };
  rateLimit = { maxRequests: 1, windowMs: 60000, respectRetryAfter: true };
  private readonly http: ResilientHttp;
  constructor(fetcher: typeof fetch = fetch) {
    this.http = new ResilientHttp(fetcher);
  }
  async initialize() {}
  async shutdown() {}
  async healthCheck() {
    return {
      status: 'healthy' as const,
      detail: '无需密钥；第三方报价每30秒更新，本系统每60秒采样；实际健康由采集结果决定',
    };
  }
  async fetch(cursor: Cursor = {}): Promise<FetchResult> {
    const response = await this.http.request('https://api.gold-api.com/price/XAU', {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'FinancialRadar/1.0 (private research)',
      },
    });
    const text = await boundedText(response, 100000, 10000);
    const quote = goldQuote.parse(JSON.parse(text));
    return {
      items: [
        {
          externalId: `XAU:${quote.updatedAt}:${quote.price}`,
          publishedAt: quote.updatedAt,
          payload: quote,
        },
      ],
      cursor: { ...cursor, lastUpdatedAt: quote.updatedAt },
    };
  }
  normalize(item: RawItem): NormalizedEvent {
    const quote = goldQuote.parse(item.payload);
    return {
      sourceId: this.metadata.id,
      externalId: item.externalId,
      title: '黄金现货 / USD 报价采样',
      description:
        'Gold API 第三方现货参考报价；每金衡盎司美元。来源时间为供应商最后取得数据的时间，不是交易所成交时间。',
      eventType: 'MARKET_SNAPSHOT',
      originalUrl: 'https://gold-api.com/assets/gold',
      sourcePublishedAt: quote.updatedAt,
      eventOccurredAt: null,
      assets: ['XAU'],
      categories: this.metadata.categories,
      confidence: this.metadata.trust,
      severity: 'P3',
      verificationStatus: 'VERIFIED',
      dataMode: 'live',
      metrics: {
        value: String(quote.price),
        name: '现货黄金',
        unit: 'USD/金衡盎司',
        frequency: 'quote',
        delayLabel: '第三方现货报价 · 供应商更新时间',
        precision: String(quote.price).split('.')[1]?.length ?? 0,
      },
    };
  }
}

export const EIA_WTI_BULK_URL = 'https://www.eia.gov/opendata/bulk/PET.zip';
const seriesSchema = z
  .object({
    series_id: z.literal('PET.RWTC.D'),
    name: z.string(),
    units: z.string(),
    f: z.literal('D'),
    data: z.array(z.tuple([z.string(), z.union([z.string(), z.number(), z.null()])])),
  })
  .passthrough();
const MAX_COMPRESSED_BYTES = 80 * 1024 * 1024;
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;

function sourceDate(raw: string) {
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (
    !/^\d{8}$/.test(raw) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new ConnectorError('EIA WTI 数据日期无效', 'SCHEMA');
  return date;
}
export function parseEiaWtiSeries(raw: unknown): RawItem[] {
  const series = seriesSchema.parse(raw);
  if (series.units !== 'Dollars per Barrel')
    throw new ConnectorError('EIA WTI 单位不匹配', 'SCHEMA');
  const { data, ...originalSeries } = series;
  const observations = new Map<string, RawItem>();
  for (const originalRow of data) {
    const [period, rawValue] = originalRow;
    const date = sourceDate(period);
    if (rawValue === null || rawValue === '' || rawValue === 'NA') continue;
    const value = String(rawValue);
    if (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
      throw new ConnectorError('EIA WTI 报价值无效', 'SCHEMA');
    observations.set(date, {
      externalId: `WTI:${date}:${value}`,
      publishedAt: null,
      payload: {
        asset: 'WTI',
        name: 'WTI 原油',
        value,
        sourceDate: date,
        originalSeries,
        originalRow,
      },
    });
  }
  const items = [...observations.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-90)
    .map(([, item]) => item);
  if (!items.length) throw new ConnectorError('EIA WTI 缺少有效日度观测', 'SCHEMA');
  return items;
}

/** The documented bulk archive has one PET.txt file of newline-delimited JSON.
 * Stop reading once its WTI daily series is found instead of loading the full archive. */
export async function readEiaWtiZip(response: Response, timeoutMs = 45000): Promise<RawItem[]> {
  if (Number(response.headers.get('content-length')) > MAX_COMPRESSED_BYTES)
    throw new ConnectorError('EIA 压缩文件超出大小限制', 'SCHEMA');
  if (!response.body) throw new ConnectorError('EIA 压缩文件为空', 'SCHEMA');
  let compressed = 0;
  let inflated = 0;
  let pending = '';
  let found: RawItem[] | undefined;
  let failure: Error | undefined;
  let files = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const consumeLine = (line: string) => {
    if (line.length > MAX_LINE_BYTES) throw new ConnectorError('EIA 数据行过大', 'SCHEMA');
    if (!line.includes('"PET.RWTC.D"')) return;
    const candidate: unknown = JSON.parse(line);
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as Record<string, unknown>).series_id === 'PET.RWTC.D'
    )
      found = parseEiaWtiSeries(candidate);
  };
  const unzip = new Unzip((file) => {
    files++;
    if (files > 1 || file.name !== 'PET.txt') {
      failure = new ConnectorError('EIA ZIP 文件结构不匹配', 'SCHEMA');
      return;
    }
    file.ondata = (error, chunk, final) => {
      if (failure || found) return;
      try {
        if (error) throw new ConnectorError('EIA ZIP 解压失败', 'SCHEMA');
        inflated += chunk.length;
        if (inflated > MAX_INFLATED_BYTES)
          throw new ConnectorError('EIA 解压数据超出大小限制', 'SCHEMA');
        pending += decoder.decode(chunk, { stream: !final });
        let newline = pending.indexOf('\n');
        while (newline >= 0 && !found) {
          consumeLine(pending.slice(0, newline).trim());
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
        if (pending.length > MAX_LINE_BYTES) throw new ConnectorError('EIA 数据行过大', 'SCHEMA');
        if (final && pending.trim() && !found) consumeLine(pending.trim());
      } catch (error) {
        failure = error instanceof Error ? error : new ConnectorError('EIA 数据解析失败', 'SCHEMA');
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ConnectorError('EIA 批量读取超时', 'TRANSIENT'));
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  try {
    while (!found && !failure) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) {
        unzip.push(new Uint8Array(), true);
        break;
      }
      compressed += part.value.length;
      if (compressed > MAX_COMPRESSED_BYTES)
        throw new ConnectorError('EIA 压缩文件超出大小限制', 'SCHEMA');
      // Bound each synchronous inflate allocation even if a fetcher emits one
      // very large compressed chunk; ondata enforces cumulative output limits.
      for (let offset = 0; offset < part.value.length && !found && !failure; offset += 16384)
        unzip.push(part.value.subarray(offset, offset + 16384));
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (failure) throw failure;
  if (!found) throw new ConnectorError('EIA 批量数据缺少 WTI 日度序列', 'SCHEMA');
  return found;
}

export class EiaWtiDailyConnector implements Connector {
  metadata: SourceMetadata = {
    id: 'eia-wti-daily',
    name: 'U.S. EIA · WTI 日度现货参考价',
    officialUrl: 'https://www.eia.gov/dnav/pet/hist/RWTCD.htm',
    transport: 'pull',
    mode: 'live',
    categories: ['macro', 'finance', 'oil', '原油', '行情'],
    trust: 0.98,
    pollIntervalSeconds: 3600,
    licenseStatus: 'official-public',
  };
  capabilities = {
    history: true,
    checkpoint: true,
    scope: 'partial' as const,
    sourceTimestamp: false,
  };
  rateLimit = { maxRequests: 1, windowMs: 3600000, respectRetryAfter: true };
  private readonly http: ResilientHttp;
  constructor(fetcher: typeof fetch = fetch) {
    this.http = new ResilientHttp(fetcher);
  }
  async initialize() {}
  async shutdown() {}
  async healthCheck() {
    return {
      status: 'healthy' as const,
      detail: '无需密钥；EIA WTI日度参考价，来源日已知、精确发布时间未知；实际健康由采集结果决定',
    };
  }
  async fetch(cursor: Cursor = {}): Promise<FetchResult> {
    const headers: Record<string, string> = {
      // EIA serves this archive as application/x-zip-compressed. Accept both
      // standard and legacy binary media types to avoid content negotiation 406.
      Accept: 'application/zip, application/x-zip-compressed, application/octet-stream, */*;q=0.1',
      'User-Agent': 'FinancialRadar/1.0 (private research)',
    };
    if (typeof cursor.etag === 'string') headers['If-None-Match'] = cursor.etag;
    else if (typeof cursor.lastModified === 'string')
      headers['If-Modified-Since'] = cursor.lastModified;
    const response = await this.http.request(
      EIA_WTI_BULK_URL,
      { headers },
      { timeoutMs: 45000, attempts: 2 },
    );
    if (response.status === 304) return { items: [], cursor };
    const items = await readEiaWtiZip(response);
    return {
      items,
      cursor: {
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        latestSourceDate: items.at(-1)?.payload.sourceDate,
        sampledAt: new Date().toISOString(),
      },
    };
  }
  normalize(item: RawItem): NormalizedEvent {
    const p = item.payload;
    return {
      sourceId: this.metadata.id,
      externalId: item.externalId,
      title: `WTI 原油 · ${p.sourceDate} 日度参考价`,
      description:
        '来源：U.S. Energy Information Administration，Cushing OK WTI Spot Price FOB；原始价格由EIA所列市场报告源整理。日度数据并非交易所实时报价，数据日期不代表精确发布时间。',
      eventType: 'MARKET_SNAPSHOT',
      originalUrl: this.metadata.officialUrl,
      sourcePublishedAt: null,
      eventOccurredAt: null,
      assets: ['WTI'],
      categories: this.metadata.categories,
      confidence: this.metadata.trust,
      severity: 'P3',
      verificationStatus: 'VERIFIED',
      dataMode: 'live',
      metrics: {
        value: String(p.value),
        name: 'WTI 原油',
        unit: 'USD/桶',
        frequency: 'daily',
        sourceDate: String(p.sourceDate),
        precision: String(p.value).split('.')[1]?.length ?? 0,
        delayLabel: 'EIA 日度参考价 · 发布时间未知',
      },
    };
  }
}
