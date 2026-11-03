import { describe, expect, it, vi } from 'vitest';
import { parseTreasuryXml, TreasuryDailyConnector } from './treasury.js';
const xml =
  '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><updated>2026-11-01T01:03:58Z</updated><entry><updated>2026-11-01T01:03:58Z</updated><content><m:properties><d:NEW_DATE m:type="Edm.DateTime">2026-10-30T00:00:00</d:NEW_DATE><d:BC_2YEAR m:type="Edm.Double">4.78</d:BC_2YEAR><d:BC_10YEAR m:type="Edm.Double">5.24</d:BC_10YEAR><d:BC_30YEAR m:type="Edm.Double" m:null="true" /></m:properties></content></entry></feed>';
describe('Treasury daily yields retain source periods without fabricated publication times', () => {
  it('extracts the correct tenor and percentage unit, keeps missing values unknown', () => {
    const items = parseTreasuryXml(xml);
    expect(items).toHaveLength(2);
    expect(items[0]!.payload).toMatchObject({
      asset: 'US2Y',
      value: '4.78',
      sourceDate: '2026-10-30',
      unit: '%',
      frequency: 'daily',
      publicationTimeKnown: false,
    });
    expect(items[1]!.payload).toMatchObject({ asset: 'US10Y', value: '5.24' });
    expect(items.every((item) => item.publishedAt === null)).toBe(true);
    const event = new TreasuryDailyConnector().normalize(items[0]!);
    expect(event.sourcePublishedAt).toBeNull();
    expect(event.eventOccurredAt).toBeNull();
    expect(event.metrics?.precision).toBe(2);
    expect(event.metrics?.delayLabel).toContain('日度');
    expect(event.categories).toEqual(
      expect.arrayContaining(['macro', 'finance', '宏观', '美国国债']),
    );
  });
  it('does not use feed.updated or midnight data date as the announcement time', () => {
    const event = new TreasuryDailyConnector().normalize(parseTreasuryXml(xml)[0]!);
    expect(event.sourcePublishedAt).toBeNull();
    expect(event.metrics?.sourceDate).toBe('2026-10-30');
    expect(event.metrics?.value).toBe('4.78');
  });
  it('retains revision-specific identities and raw evidence', () => {
    const first = parseTreasuryXml(xml)[0]!;
    const revised = parseTreasuryXml(xml.replace('4.78', '4.79'))[0]!;
    expect(first.externalId).not.toBe(revised.externalId);
    expect(first.payload.rawEntry).toBeDefined();
  });
  it('rejects malformed XML and invalid numeric data instead of filling zero', () => {
    expect(() => parseTreasuryXml('<feed>')).toThrow();
    expect(() => parseTreasuryXml(xml.replace('4.78', 'NaN'))).toThrow('收益率');
  });
  it('fetches bounded previous/current months including raw XML evidence', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(xml))
      .mockResolvedValueOnce(new Response('<feed></feed>'));
    const result = await new TreasuryDailyConnector(
      fetcher,
      () => new Date('2026-11-02T01:00:00Z'),
    ).fetch();
    expect(result.items).toHaveLength(2);
    expect(result.cursor.sourceMonths).toEqual(['202610', '202611']);
    expect(result.items[0]!.payload.rawXml).toBe(xml);
    expect(fetcher.mock.calls[0]![0]).toContain('field_tdr_date_value_month=202610');
  });
});
