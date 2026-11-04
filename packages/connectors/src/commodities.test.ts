import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  EiaWtiDailyConnector,
  GoldPriceConnector,
  parseEiaWtiSeries,
  readEiaWtiZip,
} from './commodities.js';

const series = {
  series_id: 'PET.RWTC.D',
  name: 'Cushing, OK WTI Spot Price FOB',
  units: 'Dollars per Barrel',
  f: 'D',
  updated: '2026-11-03T14:45:00-0500',
  data: [
    ['20261102', 61.2],
    ['20261030', null],
    ['20261029', 62.11],
  ],
};
const zip = (contents: string, name = 'PET.txt') =>
  new Uint8Array(zipSync({ [name]: strToU8(contents) })).buffer;

describe('commodity market source contracts', () => {
  it('fetches public XAU quotes with supplier time and explicit ounce units', async () => {
    const quote = {
      name: 'Gold',
      price: 4012.34,
      symbol: 'XAU',
      currency: 'USD',
      updatedAt: '2026-11-04T01:00:00Z',
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(quote)));
    const connector = new GoldPriceConnector(fetcher);
    const raw = await connector.fetch();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.gold-api.com/price/XAU');
    const normalized = connector.normalize(raw.items[0]!);
    expect(normalized).toMatchObject({
      dataMode: 'live',
      sourcePublishedAt: quote.updatedAt,
      eventOccurredAt: null,
      assets: ['XAU'],
      metrics: { value: '4012.34', unit: 'USD/金衡盎司', frequency: 'quote' },
    });
    expect(raw.items[0]?.payload).toEqual(quote);
  });
  it('rejects missing quote timestamps and never fabricates a fallback', async () => {
    const connector = new GoldPriceConnector(
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ symbol: 'XAU', price: 12 }))),
    );
    await expect(connector.fetch()).rejects.toThrow();
  });
  it('keeps WTI source dates separate from publication and discovery time', async () => {
    const items = parseEiaWtiSeries(series);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      externalId: 'WTI:2026-11-02:61.2',
      publishedAt: null,
      payload: {
        sourceDate: '2026-11-02',
        originalRow: ['20261102', 61.2],
        originalSeries: { updated: series.updated },
      },
    });
    const normalized = new EiaWtiDailyConnector().normalize(items[1]!);
    expect(normalized).toMatchObject({
      sourcePublishedAt: null,
      eventOccurredAt: null,
      dataMode: 'live',
      metrics: { frequency: 'daily', sourceDate: '2026-11-02', unit: 'USD/桶' },
    });
    expect(parseEiaWtiSeries({ ...series, data: [['20200420', -36.98]] })[0]?.payload.value).toBe(
      '-36.98',
    );
    expect(() => parseEiaWtiSeries({ ...series, units: 'USD/gallon' })).toThrow();
    expect(() => parseEiaWtiSeries({ ...series, data: [['20260231', 10]] })).toThrow();
    expect(() => parseEiaWtiSeries({ ...series, data: [['20260101', 'bad']] })).toThrow();
  });
  it('preserves revision identities and bounds the initial history', () => {
    expect(parseEiaWtiSeries({ ...series, data: [['20261102', 61.3]] })[0]?.externalId).not.toBe(
      parseEiaWtiSeries(series)[1]?.externalId,
    );
    const history = Array.from({ length: 100 }, (_, i) => [
      new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10).replaceAll('-', ''),
      i + 1,
    ]);
    expect(parseEiaWtiSeries({ ...series, data: history })).toHaveLength(90);
  });
  it('extracts WTI from the documented archive and sends validators on subsequent polls', async () => {
    const bytes = zip(
      `${JSON.stringify({ series_id: 'OTHER', data: [] })}\n${JSON.stringify(series)}\n`,
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(bytes, {
          headers: { ETag: 'eia-version', 'Last-Modified': 'Tue, 03 Nov 2026 20:45:17 GMT' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const connector = new EiaWtiDailyConnector(fetcher);
    const first = await connector.fetch();
    expect(first.items).toHaveLength(2);
    expect(fetcher.mock.calls[0]?.[1].headers.Accept).toBe(
      'application/zip, application/x-zip-compressed, application/octet-stream, */*;q=0.1',
    );
    expect((await connector.fetch(first.cursor)).items).toHaveLength(0);
    expect(fetcher.mock.calls[1]?.[1].headers).toMatchObject({ 'If-None-Match': 'eia-version' });
  });
  it('fails on incomplete, mismatched and oversized archives', async () => {
    await expect(readEiaWtiZip(new Response(zip('{}\n')))).rejects.toThrow('缺少 WTI');
    await expect(
      readEiaWtiZip(new Response(zip(JSON.stringify(series), 'unexpected.txt'))),
    ).rejects.toThrow('结构');
    await expect(readEiaWtiZip(new Response('bad archive'))).rejects.toThrow();
    await expect(
      readEiaWtiZip(new Response('', { headers: { 'Content-Length': String(81 * 1024 * 1024) } })),
    ).rejects.toThrow('大小限制');
  });
  it('cancels a stalled archive body without waiting for a stalled cancellation handler', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel }));
    await expect(readEiaWtiZip(response, 10)).rejects.toThrow('超时');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
