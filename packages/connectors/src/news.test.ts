import { describe, expect, it, vi } from 'vitest';
import { NewsRssConnector, NEWS_PRESETS, parseNewsFeed } from './news.js';
import { createRegistry, FedRssConnector, GitHubReleasesConnector } from './index.js';

const feedUrl = 'https://news.example.com/feed.xml';
describe('multi-domain RSS/Atom ingestion', () => {
  it('parses RSS summaries, keeps original items and preserves unknown publication time', () => {
    const items = parseNewsFeed(
      `<rss version="2.0"><channel>
      <item><guid>story-1</guid><title><![CDATA[Policy &amp; markets]]></title><description><![CDATA[<p>Brief summary</p>]]></description><link>https://news.example.com/policy</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item>
      <item><title>Unknown date</title><link>https://news.example.com/unknown</link><pubDate>invalid</pubDate></item>
      <item><guid>story-1</guid><title>Duplicate</title><link>https://news.example.com/policy</link></item>
    </channel></rss>`,
      feedUrl,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      externalId: 'story-1',
      publishedAt: '2026-11-03T10:00:00.000Z',
      payload: {
        title: 'Policy & markets',
        description: 'Brief summary',
        url: 'https://news.example.com/policy',
      },
    });
    expect(items[0]?.payload.rawItem).toHaveProperty('guid', 'story-1');
    expect(items[1]?.publishedAt).toBeNull();
  });
  it('supports Atom alternate links, relative links and entry identity', () => {
    const items = parseNewsFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>tag:publisher,2026:story-2</id><title>Technology news</title><summary>Summary only</summary>
      <link rel="self" href="https://news.example.com/api/2"/><link rel="alternate" href="/stories/2"/>
      <published>2026-11-03T10:00:00+02:00</published><content>Must not scrape full text</content>
    </entry></feed>`,
      feedUrl,
    );
    expect(items[0]).toMatchObject({
      externalId: 'tag:publisher,2026:story-2',
      publishedAt: '2026-11-03T08:00:00.000Z',
      payload: { description: 'Summary only', url: 'https://news.example.com/stories/2' },
    });
  });
  it('rejects DTD, custom entities, malformed XML, unsupported documents and overlarge payloads', () => {
    for (const xml of [
      '<!DOCTYPE rss [<!ENTITY a SYSTEM "file:///etc/passwd">]><rss/>',
      '<rss><channel>',
      '<html><body>not feed</body></html>',
      'x'.repeat(2_000_001),
    ]) {
      expect(() => parseNewsFeed(xml, feedUrl)).toThrow();
    }
    expect(() =>
      parseNewsFeed(`<rss><channel>${'<item/>'.repeat(501)}</channel></rss>`, feedUrl),
    ).toThrow('500');
    expect(parseNewsFeed('<rss><channel/></rss>', feedUrl)).toEqual([]);
  });
  it('never exposes scripts, local article links or credential-bearing URLs as evidence', () => {
    const items = parseNewsFeed(
      `<rss><channel>${['javascript:alert(1)', 'file:///etc/passwd', 'http://localhost/secret', 'https://127.0.0.1/secret', 'https://user:pass@news.example.com/private'].map((link) => `<item><title>Bad link</title><link>${link}</link></item>`).join('')}</channel></rss>`,
      feedUrl,
    );
    expect(items).toEqual([]);
  });
  it('keeps custom and editorial news unverified and never invents source dates', () => {
    const connector = new NewsRssConnector({
      id: 'custom-rss-test',
      name: 'Approved feed',
      feedUrl,
      categories: ['world'],
      pollIntervalSeconds: 60,
    });
    const item = parseNewsFeed(
      '<rss><channel><item><title>Story</title><link>https://news.example.com/story</link></item></channel></rss>',
      feedUrl,
    )[0]!;
    expect(connector.normalize(item)).toMatchObject({
      verificationStatus: 'UNVERIFIED',
      eventType: 'NEWS',
      dataMode: 'live',
      sourcePublishedAt: null,
      eventOccurredAt: null,
      categories: ['world'],
    });
    expect(connector.normalize(item).project).toBeUndefined();
    const dateOnly = parseNewsFeed(
      '<rss><channel><item><title>Calendar date only</title><link>https://news.example.com/date</link><pubDate>2026-11-03</pubDate></item></channel></rss>',
      feedUrl,
    )[0]!;
    expect(dateOnly.publishedAt).toBeNull();
  });
  it('uses conditional requests with explicit XML acceptance and bounded retry', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const connector = new NewsRssConnector(
      {
        id: 'custom-rss-test',
        name: 'Feed',
        feedUrl,
        categories: ['finance'],
        pollIntervalSeconds: 60,
      },
      fetcher,
    );
    const cursor = { etag: 'etag-1', lastModified: 'Tue, 03 Nov 2026 10:00:00 GMT' };
    expect(await connector.fetch(cursor)).toEqual({ items: [], cursor });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { 'If-None-Match': 'etag-1', 'If-Modified-Since': cursor.lastModified },
    });
  });
  it('registers real diverse providers only in live mode', () => {
    const live = createRegistry({ dataMode: 'live' }).list();
    expect(
      NEWS_PRESETS.every((preset) => live.some((source) => source.metadata.id === preset.id)),
    ).toBe(true);
    expect(
      live.find((source) => source.metadata.id === 'bbc-technology-rss')?.metadata.categories,
    ).toContain('technology');
    expect(
      createRegistry({ dataMode: 'fixture' })
        .list()
        .every((source) => source.metadata.mode === 'fixture'),
    ).toBe(true);
  });
  it('retains canonical event categories alongside existing rule category labels', () => {
    const item = {
      externalId: 'news-1',
      payload: {
        title: 'Policy announcement',
        description: 'Statement',
        url: 'https://www.federalreserve.gov/newsevents/pressreleases/example.htm',
      },
      publishedAt: null,
    };
    expect(new FedRssConnector().normalize(item).categories).toEqual(
      expect.arrayContaining(['macro', 'finance', '宏观', '美联储']),
    );
    expect(new GitHubReleasesConnector(undefined, 'owner/repo').metadata.categories).toEqual(
      expect.arrayContaining(['technology', 'crypto', '协议动态']),
    );
    for (const connector of createRegistry({ dataMode: 'live' }).list()) {
      expect(
        connector.metadata.categories.some((category) =>
          ['macro', 'finance', 'technology', 'world', 'crypto'].includes(category),
        ),
      ).toBe(true);
    }
  });
});
