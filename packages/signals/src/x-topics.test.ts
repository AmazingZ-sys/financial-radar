import { describe, expect, it } from 'vitest';
import { collectXTopics, type XTopicPost } from './x-topics.js';

const now = '2026-11-05T10:00:00.000Z';
const settings = { keywords: [], candidateMinAuthors: 3, candidateWindowMinutes: 60 };
function post(
  id: string,
  text = `Original observation ${id} #Radar`,
  extra: Partial<XTopicPost> = {},
): XTopicPost {
  return {
    evidenceId: `evidence-${id}`,
    postId: `post-${id}`,
    authorId: `author-${id}`,
    text,
    publishedAt: '2026-11-05T09:30:00.000Z',
    firstSeenAt: '2026-11-05T09:31:00.000Z',
    ...extra,
  };
}

describe('X topic collection from explicit observed posts', () => {
  it('requires three distinct accounts and texts and preserves only the supplied evidence', () => {
    expect(collectXTopics([post('1'), post('2')], settings, now)).toEqual([]);
    const topics = collectXTopics([post('1'), post('2'), post('3')], settings, now);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toEqual({
      topicKey: 'hashtag:radar',
      label: '#radar',
      evidenceIds: ['evidence-1', 'evidence-2', 'evidence-3'],
      authorIds: ['author-1', 'author-2', 'author-3'],
      postIds: ['post-1', 'post-2', 'post-3'],
      earliestPublishedAt: '2026-11-05T09:30:00.000Z',
      latestPublishedAt: '2026-11-05T09:30:00.000Z',
      textExcerpt:
        'Original observation 3 #Radar\nOriginal observation 2 #Radar\nOriginal observation 1 #Radar',
    });
    expect(topics[0]).not.toHaveProperty('assetKey');
    expect(topics[0]).not.toHaveProperty('verificationStatus');
  });

  it('does not inflate support from repeated posts, repeated authors, or copied advertising text', () => {
    const samePost = [post('1'), post('2', undefined, { postId: 'post-1' }), post('3')];
    expect(collectXTopics(samePost, settings, now)).toEqual([]);
    const sameAuthor = [post('1'), post('2', undefined, { authorId: 'author-1' }), post('3')];
    expect(collectXTopics(sameAuthor, settings, now)).toEqual([]);
    const copied = [
      post('1', 'ＧＯ  #Radar  https://ads.example/1'),
      post('2', 'go #radar https://ads.example/2'),
      post('3', 'GO\n#RADAR www.ads.example/3'),
    ];
    expect(collectXTopics(copied, settings, now)).toEqual([]);
  });

  it('selects the earliest original deterministically when copied posts have different authors', () => {
    const input = [
      post('copy', 'Shared #Radar https://example.com/new', {
        publishedAt: '2026-11-05T09:40:00.000Z',
      }),
      post('first', 'shared #radar https://example.com/original'),
      post('other', 'Different original #Radar'),
    ];
    const threshold = { ...settings, candidateMinAuthors: 2 };
    const topics = collectXTopics(input, threshold, now);
    expect(topics[0]!.authorIds).toEqual(['author-first', 'author-other']);
    expect(topics).toEqual(collectXTopics(input.toReversed(), threshold, now));
  });

  it('ignores reposts and replies while allowing unique quote commentary', () => {
    const input = [
      post('1'),
      post('2'),
      post('repost', 'Reposted commentary #Radar', { isRepost: true }),
      post('reply', 'Reply commentary #Radar', { isReply: true }),
      post('empty-quote', 'https://x.com/author/status/123', { hashtags: ['Radar'] }),
    ];
    expect(collectXTopics(input, settings, now)).toEqual([]);
    input.push(post('quote', 'My own assessment #Radar https://x.com/author/status/123'));
    const topics = collectXTopics(input, settings, now);
    expect(topics[0]!.authorIds).toEqual(['author-1', 'author-2', 'author-quote']);
  });

  it.each(['', ' ', 'unknown'])('ignores unknown or absent author identity (%s)', (authorId) => {
    expect(
      collectXTopics([post('1'), post('2'), post('3', undefined, { authorId })], settings, now),
    ).toEqual([]);
  });

  it('keeps configured keywords, hashtags, and cashtags in separate normalized namespaces', () => {
    const input = [
      post('1', 'First ＲＡＤＡＲ #ＲＡＤＡＲ $ＲＡＤＡＲ'),
      post('2', 'Second Radar #Radar $Radar'),
      post('3', 'Third radar #radar $radar'),
    ];
    const topics = collectXTopics(input, { ...settings, keywords: ['ＲＡＤＡＲ', 'radar'] }, now);
    expect(topics.map((topic) => [topic.topicKey, topic.label])).toEqual([
      ['cashtag:radar', '$radar'],
      ['hashtag:radar', '#radar'],
      ['keyword:radar', 'radar'],
    ]);
  });

  it('uses explicit entities and literal keywords without making asset identities from unmarked tickers', () => {
    const input = [
      post('1', 'One Ethereum discussion and a launch?', { hashtags: ['ETH'], cashtags: ['SOL'] }),
      post('2', 'Two Ethereum observations and launch?', {
        hashtags: ['#ｅｔｈ'],
        cashtags: ['$sol'],
      }),
      post('3', 'Three Ethereum views and launch?', { hashtags: ['eth'], cashtags: ['sol'] }),
    ];
    const topics = collectXTopics(input, { ...settings, keywords: ['launch?'] }, now);
    expect(topics.map((topic) => topic.topicKey)).toEqual([
      'cashtag:sol',
      'hashtag:eth',
      'keyword:launch?',
    ]);
    expect(topics.some((topic) => topic.topicKey.includes('ethereum'))).toBe(false);
  });

  it('does not extract topics from URLs or numeric cash amounts', () => {
    const input = ['1', '2', '3'].map((id) =>
      post(id, `Different ${id} $100 https://example.com/#radar`),
    );
    expect(collectXTopics(input, settings, now)).toEqual([]);
  });

  it('accepts publication window boundaries and offsets while retaining real earliest/latest times', () => {
    const input = [
      post('1', undefined, { publishedAt: '2026-11-05T09:00:00.000Z' }),
      post('2', undefined, { publishedAt: '2026-11-05T17:30:00+08:00' }),
      post('3', undefined, { publishedAt: now, firstSeenAt: now }),
    ];
    expect(collectXTopics(input, settings, now)[0]).toMatchObject({
      earliestPublishedAt: '2026-11-05T09:00:00.000Z',
      latestPublishedAt: now,
    });
    expect(collectXTopics(input, { ...settings, candidateWindowMinutes: 30 }, now)).toEqual([]);
  });

  it.each([
    { publishedAt: null },
    { publishedAt: 'invalid' },
    { publishedAt: '2026-11-05T08:59:59.999Z' },
    { publishedAt: '2026-11-05T10:00:00.001Z' },
    { firstSeenAt: 'invalid' },
    { firstSeenAt: '2026-11-05T10:00:00.001Z' },
  ])('excludes evidence unavailable at the comparison clock (%j)', (extra) => {
    expect(
      collectXTopics([post('1'), post('2'), post('3', undefined, extra)], settings, now),
    ).toEqual([]);
  });

  it('orders by distinct author count, latest publication, then key and caps output at twenty topics', () => {
    const input = [
      post('popular-1', 'One #popular'),
      post('popular-2', 'Two #popular'),
      post('popular-3', 'Three #popular'),
      ...Array.from({ length: 22 }, (_, index) => [
        post(`topic-${index}-1`, `One #topic${String(index).padStart(2, '0')}`),
        post(`topic-${index}-2`, `Two #topic${String(index).padStart(2, '0')}`),
      ]).flat(),
      post('recent-1', 'One #recent', { publishedAt: '2026-11-05T09:59:00.000Z' }),
      post('recent-2', 'Two #recent', { publishedAt: '2026-11-05T09:59:00.000Z' }),
    ];
    const topics = collectXTopics(input, { ...settings, candidateMinAuthors: 2 }, now);
    expect(topics).toHaveLength(20);
    expect(topics.map((topic) => topic.topicKey).slice(0, 4)).toEqual([
      'hashtag:popular',
      'hashtag:recent',
      'hashtag:topic00',
      'hashtag:topic01',
    ]);
    expect(topics).toEqual(
      collectXTopics(input.toReversed(), { ...settings, candidateMinAuthors: 2 }, now),
    );
  });

  it('rejects invalid clocks and settings instead of creating unsupported candidates', () => {
    const input = [post('1'), post('2'), post('3')];
    expect(collectXTopics(input, settings, 'invalid')).toEqual([]);
    expect(collectXTopics(input, { ...settings, candidateMinAuthors: 0 }, now)).toEqual([]);
    expect(collectXTopics(input, { ...settings, candidateWindowMinutes: NaN }, now)).toEqual([]);
  });
});
