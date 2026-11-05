export type XTopicPost = {
  evidenceId: string;
  postId: string;
  authorId: string;
  text: string;
  publishedAt: string | null;
  firstSeenAt: string;
  hashtags?: string[];
  cashtags?: string[];
  isRepost?: boolean;
  isReply?: boolean;
};

export type XTopic = {
  topicKey: string;
  label: string;
  evidenceIds: string[];
  authorIds: string[];
  postIds: string[];
  latestPublishedAt: string;
  earliestPublishedAt: string;
  textExcerpt: string;
};

type TopicSettings = {
  keywords: string[];
  candidateMinAuthors: number;
  candidateWindowMinutes: number;
};
type AvailablePost = XTopicPost & {
  publishedMs: number;
  firstSeenMs: number;
  normalizedText: string;
};

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const normalize = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const stripUrls = (value: string) => value.replace(/(?:https?:\/\/|www\.)\S+/giu, ' ');
const knownId = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.trim().toLowerCase() !== 'unknown';

function topicTags(post: AvailablePost, marker: '#' | '$'): string[] {
  const provided = marker === '#' ? post.hashtags : post.cashtags;
  const expression =
    marker === '#'
      ? /(?<![\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu
      : /(?<![\p{L}\p{N}_])\$([\p{L}\p{N}_]+)/gu;
  const fromText = [...post.normalizedText.matchAll(expression)].map((match) => match[1]!);
  return [
    ...new Set(
      [...(provided ?? []), ...fromText]
        .map((tag) => normalize(tag).replace(marker === '#' ? /^#/u : /^\$/u, ''))
        .filter(
          (tag) => /^[\p{L}\p{N}_]{1,100}$/u.test(tag) && (marker === '#' || /\p{L}/u.test(tag)),
        ),
    ),
  ];
}

/** Count distinct observed accounts and original texts, never independent organizations or assets. */
export function collectXTopics(
  posts: XTopicPost[],
  settings: TopicSettings,
  now: string,
): XTopic[] {
  const nowMs = Date.parse(now);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isInteger(settings.candidateMinAuthors) ||
    settings.candidateMinAuthors < 2 ||
    settings.candidateMinAuthors > 20 ||
    !Number.isInteger(settings.candidateWindowMinutes) ||
    settings.candidateWindowMinutes < 15 ||
    settings.candidateWindowMinutes > 60
  )
    return [];
  const cutoff = nowMs - settings.candidateWindowMinutes * 60_000;
  const keywords = [...new Set(settings.keywords.map(normalize).filter(Boolean))];
  const available: AvailablePost[] = [];
  for (const post of posts) {
    if (
      post.isRepost ||
      post.isReply ||
      !knownId(post.evidenceId) ||
      !knownId(post.postId) ||
      !knownId(post.authorId) ||
      typeof post.text !== 'string' ||
      typeof post.publishedAt !== 'string' ||
      typeof post.firstSeenAt !== 'string'
    )
      continue;
    const publishedMs = Date.parse(post.publishedAt);
    const firstSeenMs = Date.parse(post.firstSeenAt);
    const normalizedText = normalize(stripUrls(post.text.normalize('NFKC')));
    if (
      !Number.isFinite(publishedMs) ||
      !Number.isFinite(firstSeenMs) ||
      publishedMs < cutoff ||
      publishedMs > nowMs ||
      firstSeenMs > nowMs ||
      !normalizedText
    )
      continue;
    available.push({ ...post, publishedMs, firstSeenMs, normalizedText });
  }
  // The earliest observed original wins copied-text attribution, independent of input order.
  available.sort(
    (a, b) =>
      a.publishedMs - b.publishedMs ||
      a.firstSeenMs - b.firstSeenMs ||
      compareText(a.postId, b.postId) ||
      compareText(a.evidenceId, b.evidenceId) ||
      compareText(a.authorId, b.authorId) ||
      compareText(a.normalizedText, b.normalizedText),
  );
  const seenPosts = new Set<string>();
  const seenTexts = new Set<string>();
  const groups = new Map<string, { label: string; posts: AvailablePost[] }>();
  for (const post of available) {
    if (seenPosts.has(post.postId) || seenTexts.has(post.normalizedText)) continue;
    seenPosts.add(post.postId);
    seenTexts.add(post.normalizedText);
    const topics = new Map<string, string>();
    for (const keyword of keywords)
      if (post.normalizedText.includes(keyword)) topics.set(`keyword:${keyword}`, keyword);
    for (const tag of topicTags(post, '#')) topics.set(`hashtag:${tag}`, `#${tag}`);
    for (const tag of topicTags(post, '$')) topics.set(`cashtag:${tag}`, `$${tag}`);
    for (const [key, label] of topics) {
      const group = groups.get(key) ?? { label, posts: [] };
      group.posts.push(post);
      groups.set(key, group);
    }
  }

  const result: XTopic[] = [];
  for (const [topicKey, group] of groups) {
    const authorIds = [...new Set(group.posts.map((post) => post.authorId))].sort(compareText);
    if (
      authorIds.length < settings.candidateMinAuthors ||
      group.posts.length < settings.candidateMinAuthors
    )
      continue;
    const first = group.posts[0]!;
    const last = group.posts.at(-1)!;
    result.push({
      topicKey,
      label: group.label,
      evidenceIds: [...new Set(group.posts.map((post) => post.evidenceId))].sort(compareText),
      authorIds,
      postIds: group.posts.map((post) => post.postId).sort(compareText),
      latestPublishedAt: new Date(last.publishedMs).toISOString(),
      earliestPublishedAt: new Date(first.publishedMs).toISOString(),
      textExcerpt: group.posts
        .slice(-3)
        .reverse()
        .map((post) => post.text.slice(0, 240))
        .join('\n'),
    });
  }
  return result
    .sort(
      (a, b) =>
        b.authorIds.length - a.authorIds.length ||
        Date.parse(b.latestPublishedAt) - Date.parse(a.latestPublishedAt) ||
        compareText(a.topicKey, b.topicKey),
    )
    .slice(0, 20);
}
