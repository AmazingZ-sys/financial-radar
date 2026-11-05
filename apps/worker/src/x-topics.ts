import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { config } from '@radar/config';
import { sql, readXConfig } from '@radar/database';
import { EventSchema } from '@radar/shared';
import {
  collectXTopics,
  stableHash,
  inputsForEvent,
  scoreOpportunity,
  scoreRisk,
} from '@radar/signals';
import { initialAnalysisState, enqueueAnalysis } from './analysis-admission.js';

const json = (data: unknown) => sql.json(data as postgres.JSONValue);
/** Free grouping over durable evidence only; no social or AI network requests. */
export async function scanXTopics(at = new Date().toISOString()) {
  if (config.dataMode !== 'live') return 0;
  const settings = await readXConfig();
  if (!settings.enabled || settings.credentialError || !settings.usernames.length) return 0;
  const scope = stableHash(JSON.stringify([settings.usernames, settings.keywords]));
  const source = (
    await sql`SELECT enabled FROM data_sources WHERE id='x-search' AND mode='live'`
  )[0];
  if (!source?.enabled) return 0;
  const clock = Date.parse(at);
  if (!Number.isFinite(clock)) throw new Error('X 聚合时刻无效');
  const since = new Date(clock - settings.candidateWindowMinutes * 60000).toISOString();
  const rows =
    await sql`SELECT id,external_id,payload,published_at,first_seen_at FROM raw_items WHERE source_id='x-search' AND ((payload->'_integrationScopeSeenAt'->>${scope})::timestamptz<=${at}::timestamptz OR (payload->'_integrationScopeSeenAt' IS NULL AND payload->>'_integrationScope'=${scope})) AND first_seen_at<=${at}::timestamptz AND published_at BETWEEN ${since}::timestamptz AND ${at}::timestamptz ORDER BY published_at DESC,id LIMIT 500`;
  const topics = collectXTopics(
    rows.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      const refs = Array.isArray(payload.referencedPosts)
        ? (payload.referencedPosts as { type?: string }[])
        : [];
      return {
        evidenceId: String(row.id),
        postId: String(row.external_id),
        authorId: String(payload.authorId ?? ''),
        text: String(payload.text ?? ''),
        publishedAt: row.published_at ? new Date(row.published_at as string).toISOString() : null,
        firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
        hashtags: Array.isArray(payload.hashtags) ? (payload.hashtags as string[]) : [],
        cashtags: Array.isArray(payload.cashtags) ? (payload.cashtags as string[]) : [],
        isRepost: refs.some((ref) => ref.type === 'retweeted'),
        isReply: refs.some((ref) => ref.type === 'replied_to'),
      };
    }),
    settings,
    at,
  );
  let inserted = 0;
  for (const topic of topics) {
    const id = randomUUID();
    const normalized = {
      sourceId: 'x-search',
      externalId: `topic:${topic.topicKey}:${at}`,
      identity: `topic:${topic.topicKey}:${at}`,
      title: `X讨论候选 · ${topic.label} · ${topic.authorIds.length}位作者`,
      description: `所关注账号中，最近${settings.candidateWindowMinutes}分钟内有${topic.authorIds.length}位作者的${topic.postIds.length}条原创帖子讨论${topic.label}。这是讨论聚合，不代表全网热度突增、官方确认或可参与机会。\n${topic.textExcerpt}`,
      eventType: 'X_HOT_TOPIC',
      originalUrl: `https://x.com/i/web/status/${topic.postIds[0]}`,
      sourcePublishedAt: topic.latestPublishedAt,
      eventOccurredAt: null,
      assets: [],
      categories: ['crypto', 'social'],
      confidence: 0.65,
      severity: 'P2' as const,
      verificationStatus: 'UNVERIFIED' as const,
      dataMode: 'live' as const,
      metrics: {
        topicKey: topic.topicKey,
        uniqueAuthors: topic.authorIds.length,
        originalPostCount: topic.postIds.length,
        minimumAuthors: settings.candidateMinAuthors,
        windowMinutes: settings.candidateWindowMinutes,
      },
    };
    const inputs = inputsForEvent(normalized, at);
    const opportunity = scoreOpportunity(inputs.opportunity);
    const risk = scoreRisk(inputs.risk);
    const event = {
      ...normalized,
      id,
      firstSeenAt: at,
      collectedAt: at,
      normalizedAt: at,
      detectedAt: at,
      rawDataReference: topic.evidenceIds[0]!,
      fingerprint: `x-topic:${stableHash(topic.topicKey + ':' + at)}`,
      ...(await initialAnalysisState({
        ...normalized,
        firstSeenAt: at,
        evidenceIds: topic.evidenceIds,
      })),
      evidenceIds: topic.evidenceIds,
      opportunityScore: opportunity.score,
      riskScore: risk.score,
      opportunityBreakdown: opportunity,
      riskBreakdown: risk,
      riskWarnings: [
        '社交讨论尚未核实项目身份、合约安全与参与条件',
        ...risk.unknowns.map((key) => `${key}未知`),
      ],
      createdAt: at,
      updatedAt: at,
    };
    EventSchema.parse(event);
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'x-topic:' + topic.topicKey}))`;
      const recent =
        await tx`SELECT id FROM events WHERE source_id='x-search' AND event_type='X_HOT_TOPIC' AND data->>'dataMode'='live' AND data->'metrics'->>'topicKey'=${topic.topicKey} AND first_seen_at>${new Date(clock - 6 * 3600000).toISOString()}::timestamptz LIMIT 1`;
      if (recent.length) return;
      await tx`INSERT INTO events(id,fingerprint,source_id,external_id,title,event_type,severity,first_seen_at,data) VALUES(${id},${event.fingerprint},'x-search',${event.externalId},${event.title},'X_HOT_TOPIC','P2',${at},${json(event)})`;
      for (const rawId of topic.evidenceIds)
        await tx`INSERT INTO event_sources(id,event_id,source_id,raw_item_id,url,source_published_at,data) SELECT ${randomUUID()}::uuid,${id}::uuid,'x-search',r.id,r.payload->>'originalUrl',r.published_at,${json({ title: event.title, dataMode: 'live', derived: true })}::jsonb FROM raw_items r WHERE r.id=${rawId}::uuid AND r.source_id='x-search' ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO risk_assessments(id,event_id,score,version,data) VALUES(${randomUUID()},${id},${risk.score},${risk.version},${json(risk)})`;
      await enqueueAnalysis(tx, event);
      inserted++;
    });
  }
  return inserted;
}
