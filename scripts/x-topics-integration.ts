import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql, readXConfig, saveAIConfig, saveXConfig } from '../packages/database/src/index.js';
import { XRecentSearchConnector, type RawItem } from '../packages/connectors/src/index.js';
import { RuleSchema } from '../packages/shared/src/index.js';
import { stableHash } from '../packages/signals/src/index.js';
import { persistEvent, decideXResearchNotifications } from '../apps/worker/src/pipeline.js';
import { scanXTopics } from '../apps/worker/src/x-topics.js';

/** PostgreSQL acceptance using explicitly synthetic stored posts only, with no X or AI transport. */
export async function verifyXTopicPipeline() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('X topic integration requires a non-production Fixture database');
  const suffix = randomUUID().replaceAll('-', '');
  const topic = `accept${suffix}`;
  const ownerId = randomUUID();
  const channelId = randomUUID();
  const rawIds: string[] = [];
  const eventIds: string[] = [];
  const ruleIds: string[] = [];
  const keys = ['integrations:x', 'integrations:ai'];
  const savedSettings =
    await sql`SELECT key,data FROM system_settings WHERE key=ANY(${keys}::text[])`;
  const savedSource = (await sql`SELECT * FROM data_sources WHERE id='x-search'`)[0];
  const savedMode = config.dataMode;
  const savedCollectorSecret = config.xCollectorSecret;
  config.xCollectorSecret = 'synthetic-collector-secret-at-least-32-characters';
  const clock = Date.now() - 2_000;
  const at = new Date(clock).toISOString();
  const before = new Date(clock - 60_000).toISOString();
  const published = new Date(clock - 120_000).toISOString();
  const future = new Date(clock + 60_000).toISOString();
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  let checks = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    checks++;
  };
  const connector = new XRecentSearchConnector(
    {
      sessionCookies: 'auth_token=synthetic_auth_placeholder; ct0=synthetic_csrf_placeholder',
      collectorUrl: 'http://127.0.0.1:18888',
      collectorSecret: 'synthetic-collector-secret-at-least-32-characters',
      usernames: [`u${suffix.slice(0, 12)}`],
      keywords: [],
      maxResults: 10,
      pollIntervalSeconds: 900,
    },
    async () => {
      throw new Error('X integration must not make external requests');
    },
  );
  let scope = '';
  async function post(
    authorId: string,
    text: string,
    options: { publishedAt?: string | null; scope?: string; seenAt?: string; reply?: boolean } = {},
  ) {
    const id = randomUUID();
    rawIds.push(id);
    const externalId = `${clock}${rawIds.length.toString().padStart(3, '0')}`;
    const raw: RawItem = {
      externalId,
      publishedAt: options.publishedAt === undefined ? published : options.publishedAt,
      payload: {
        id: externalId,
        text,
        authorId,
        originalUrl: `https://x.com/i/web/status/${externalId}`,
        hashtags: [topic],
        referencedPosts: options.reply ? [{ type: 'replied_to', id: '1' }] : [],
        syntheticTestEvidence: true,
        _integrationScope: options.scope ?? scope,
        _integrationScopeSeenAt: { [options.scope ?? scope]: options.seenAt ?? before },
      },
    };
    await sql`INSERT INTO raw_items(id,source_id,external_id,payload,published_at,first_seen_at,collected_at) VALUES(${id},'x-search',${externalId},${json(raw.payload)},${raw.publishedAt},${before},${before})`;
    return { id, raw };
  }
  const notificationCount = async () =>
    Number(
      (await sql`SELECT count(*)::int n FROM notifications WHERE channel_id=${channelId}`)[0]!.n,
    );
  try {
    await sql`INSERT INTO data_sources(id,name,enabled,mode,data) VALUES('x-search','synthetic X acceptance',true,'live','{}') ON CONFLICT(id) DO UPDATE SET enabled=true,mode='live'`;
    await saveXConfig({
      enabled: true,
      sessionCookies: 'auth_token=synthetic_auth_placeholder; ct0=synthetic_csrf_placeholder',
      usernames: [`u${suffix.slice(0, 12)}`],
      keywords: [],
      dailyRequestLimit: 1,
      candidateMinAuthors: 3,
      candidateWindowMinutes: 30,
    });
    await saveAIConfig({
      enabled: true,
      apiKey: 'synthetic-never-sent',
      model: 'synthetic-never-called',
      maxDailyCalls: 0,
    });
    const settings = await readXConfig();
    scope = stableHash(JSON.stringify([settings.usernames, settings.keywords]));
    await sql`INSERT INTO users(id,email,password_hash) VALUES(${ownerId},${`${suffix}@x.fixture`},'not-a-login-hash')`;
    await sql`INSERT INTO notification_channels(id,owner_id,provider,name,enabled,data) VALUES(${channelId},${ownerId},'telegram','synthetic X acceptance',true,'{}')`;
    for (const priority of ['P0', 'P1', 'P2', 'P3'] as const) {
      const rule = RuleSchema.parse({
        id: randomUUID(),
        ownerId,
        name: `X acceptance ${priority}`,
        conditions: { sourceIds: ['x-search'], eventTypes: ['X_HOT_TOPIC'] },
        priority,
        channelIds: [channelId],
        cooldownSeconds: 60,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      ruleIds.push(rule.id);
      await sql`INSERT INTO alert_rules(id,owner_id,name,enabled,version,data) VALUES(${rule.id},${ownerId},${rule.name},true,1,${json(rule)})`;
    }
    const rawRule = RuleSchema.parse({
      id: randomUUID(),
      ownerId,
      name: 'Raw social opt-in remains research only',
      conditions: {
        sourceIds: ['x-search'],
        eventTypes: ['SOCIAL_POST'],
        includeRoutineEvents: true,
      },
      priority: 'P2',
      channelIds: [channelId],
      cooldownSeconds: 60,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    ruleIds.push(rawRule.id);
    await sql`INSERT INTO alert_rules(id,owner_id,name,enabled,version,data) VALUES(${rawRule.id},${ownerId},${rawRule.name},true,1,${json(rawRule)})`;
    const a = await post('101', `Synthetic first viewpoint #${topic}`);
    const b = await post('102', `Synthetic second viewpoint #${topic}`);
    const c = await post('103', `Synthetic third viewpoint #${topic}`, {
      scope: 'older-synthetic-scope',
    });
    await post('104', a.raw.payload.text as string);
    await post('105', `Synthetic unknown publication #${topic}`, { publishedAt: null });
    await post('106', `Synthetic future publication #${topic}`, { publishedAt: future });
    await post('107', `Synthetic stale publication #${topic}`, {
      publishedAt: new Date(clock - 3_600_000).toISOString(),
    });
    await post('108', `Synthetic reply #${topic}`, { reply: true });
    check(
      (await scanXTopics(at)) === 0,
      'Fixture does not create live X candidates from stored evidence',
    );
    config.dataMode = 'live';
    for (const item of [a, b, c]) {
      await persistEvent(connector, item.id, before, item.raw);
      const event = (
        await sql`SELECT id,data FROM events WHERE source_id='x-search' AND external_id=${item.raw.externalId}`
      )[0]!;
      eventIds.push(String(event.id));
      check(
        event.data.analysisStatus === 'SKIPPED' && event.data.verificationStatus === 'UNVERIFIED',
        'An individual post stays unverified and never queues AI',
      );
    }
    check(
      (await notificationCount()) === 0,
      'Raw social posts do not notify even with routine-event opt-in',
    );
    check(
      (await scanXTopics(at)) === 0,
      'Copies, replies, missing/future/stale times and another query scope cannot supply a third author',
    );
    await sql`UPDATE raw_items SET payload=jsonb_set(payload,'{_integrationScopeSeenAt}',payload->'_integrationScopeSeenAt' || ${json({ [scope]: future })}::jsonb) WHERE id=${c.id}`;
    check(
      (await scanXTopics(at)) === 0,
      'A post first encountered in this scope after the cutoff is not knowable yet',
    );
    await sql`UPDATE raw_items SET payload=jsonb_set(payload,'{_integrationScopeSeenAt}',payload->'_integrationScopeSeenAt' || ${json({ [scope]: before })}::jsonb) WHERE id=${c.id}`;
    check(
      (await scanXTopics(at)) === 1,
      'Re-observation in the current scope can aggregate three distinct original authors without rewriting original scope',
    );
    const candidate = (
      await sql`SELECT id,data FROM events WHERE source_id='x-search' AND event_type='X_HOT_TOPIC' AND data->'metrics'->>'topicKey'=${`hashtag:${topic}`}`
    )[0]!;
    eventIds.push(String(candidate.id));
    check(
      candidate.data.dataMode === 'live' &&
        candidate.data.verificationStatus === 'UNVERIFIED' &&
        candidate.data.severity === 'P2' &&
        candidate.data.metrics.uniqueAuthors === 3 &&
        candidate.data.metrics.originalPostCount === 3,
      'A discussion candidate preserves mode, risk boundary, original-post counts and unverified status',
    );
    check(
      (
        await sql`SELECT count(*)::int n FROM event_sources WHERE event_id=${String(candidate.id)}`
      )[0]!.n === 3,
      'Every counted original post is retained as durable candidate evidence',
    );
    check(
      (await notificationCount()) === 0,
      'Aggregation alone does not produce a research notification',
    );
    check((await scanXTopics(at)) === 0, 'A topic is emitted once during its six-hour cooldown');
    check(
      (await sql`SELECT id FROM ai_analysis_runs WHERE event_id=ANY(${eventIds}::uuid[])`)
        .length === 0,
      'Raw ingestion and free topic aggregation never attempt the model',
    );
    await sql.begin((tx) => decideXResearchNotifications(tx, candidate.data));
    check(
      (await notificationCount()) === 0,
      'Research notification admission rejects an unfinished analysis',
    );
    const completed = {
      ...candidate.data,
      analysisStatus: 'COMPLETED',
      analysis: {
        summary: 'Synthetic acceptance summary; no provider was called',
        syntheticTestEvidence: true,
      },
    };
    await sql`UPDATE events SET data=${json(completed)} WHERE id=${String(candidate.id)}`;
    await sql.begin((tx) => decideXResearchNotifications(tx, completed));
    check(
      (await notificationCount()) === 2,
      'Completed research reaches P2/P3 rules while P0/P1 rules remain blocked',
    );
    await sql.begin((tx) => decideXResearchNotifications(tx, completed));
    check(
      (await notificationCount()) === 2,
      'Replaying completed research cannot create duplicate notifications',
    );
    check(
      (
        await sql`SELECT count(*)::int n FROM outbox_jobs WHERE kind='NOTIFY' AND entity_id IN (SELECT id FROM notifications WHERE channel_id=${channelId})`
      )[0]!.n === 2,
      'Notification decisions and their recoverable outbox jobs commit together',
    );
    console.log(
      `X topic pipeline integration: ${checks} checks passed; synthetic stored evidence, no X/AI request`,
    );
    return checks;
  } finally {
    config.dataMode = savedMode;
    config.xCollectorSecret = savedCollectorSecret;
    const createdTopics =
      await sql`SELECT id FROM events WHERE source_id='x-search' AND event_type='X_HOT_TOPIC' AND data->'metrics'->>'topicKey'=${`hashtag:${topic}`}`;
    eventIds.push(...createdTopics.map((row) => String(row.id)));
    await sql.begin(async (tx) => {
      await tx`DELETE FROM outbox_jobs WHERE entity_id=ANY(${eventIds}::uuid[]) OR entity_id IN (SELECT id FROM notifications WHERE channel_id=${channelId})`;
      await tx`DELETE FROM notification_attempts WHERE notification_id IN (SELECT id FROM notifications WHERE channel_id=${channelId})`;
      await tx`DELETE FROM notifications WHERE channel_id=${channelId}`;
      await tx`DELETE FROM alert_triggers WHERE rule_id=ANY(${ruleIds}::uuid[])`;
      await tx`DELETE FROM alert_rule_versions WHERE rule_id=ANY(${ruleIds}::uuid[])`;
      await tx`DELETE FROM alert_rules WHERE owner_id=${ownerId}`;
      await tx`DELETE FROM ai_analysis_runs WHERE event_id=ANY(${eventIds}::uuid[])`;
      await tx`DELETE FROM risk_assessments WHERE event_id=ANY(${eventIds}::uuid[])`;
      await tx`DELETE FROM event_sources WHERE event_id=ANY(${eventIds}::uuid[])`;
      await tx`DELETE FROM events WHERE id=ANY(${eventIds}::uuid[])`;
      await tx`DELETE FROM raw_items WHERE id=ANY(${rawIds}::uuid[])`;
      await tx`DELETE FROM notification_channels WHERE id=${channelId}`;
      await tx`DELETE FROM users WHERE id=${ownerId}`;
      if (savedSource)
        await tx`UPDATE data_sources SET name=${String(savedSource.name)},enabled=${Boolean(savedSource.enabled)},mode=${String(savedSource.mode)},data=${json(savedSource.data)} WHERE id='x-search'`;
      else await tx`DELETE FROM data_sources WHERE id='x-search'`;
      await tx`DELETE FROM system_settings WHERE key=ANY(${keys}::text[])`;
      for (const row of savedSettings)
        await tx`INSERT INTO system_settings(key,data) VALUES(${String(row.key)},${json(row.data)})`;
    });
  }
}
