import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql } from '../packages/database/src/index.js';
import { RuleSchema, type AlertRule } from '../packages/shared/src/index.js';
import type { Connector, NormalizedEvent, RawItem } from '../packages/connectors/src/types.js';
import { persistEvent } from '../apps/worker/src/pipeline.js';
import { sendNotification } from '../apps/worker/src/jobs.js';

/** Isolated PostgreSQL evidence; Fixture sends and rejected synthetic live backlog never contact providers. */
export async function verifyNotificationPolicy() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('Notification policy integration requires a non-production Fixture database');
  const suffix = randomUUID();
  const sourceId = `notification-policy-synthetic-${suffix}`;
  const ownerId = randomUUID();
  const channelId = randomUUID();
  const savedMode = config.dataMode;
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  let checks = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    checks++;
  };
  const connector: Connector = {
    metadata: {
      id: sourceId,
      name: 'Synthetic notification acceptance',
      officialUrl: 'https://example.invalid/synthetic-notification',
      transport: 'pull',
      mode: 'fixture',
      categories: ['test'],
      trust: 0.95,
      pollIntervalSeconds: 60,
      licenseStatus: 'internal-research-only',
    },
    capabilities: { history: true, checkpoint: true, scope: 'watchlist', sourceTimestamp: true },
    rateLimit: { maxRequests: 1, windowMs: 1000, respectRetryAfter: true },
    initialize: async () => {},
    fetch: async () => ({ items: [], cursor: {} }),
    healthCheck: async () => ({ status: 'healthy', detail: 'Synthetic test only' }),
    shutdown: async () => {},
    normalize: (item) => item.payload.normalized as NormalizedEvent,
  };
  async function observation(eventType: string, overrides: Partial<NormalizedEvent> = {}) {
    const externalId = randomUUID();
    const rawId = randomUUID();
    const now = new Date().toISOString();
    const assetKey = `fixture:notification-policy:${suffix}:${externalId}`;
    const normalized: NormalizedEvent = {
      sourceId,
      externalId,
      title: `Synthetic ${eventType}`,
      description: 'Synthetic acceptance evidence; no real asset or investment opportunity',
      eventType,
      originalUrl: `https://example.invalid/synthetic-notification/${externalId}`,
      sourcePublishedAt: now,
      eventOccurredAt: null,
      assets: [assetKey],
      categories: ['test'],
      chain: 'Fixture',
      assetKey,
      identity: externalId,
      confidence: 0.95,
      severity: 'P2',
      verificationStatus: 'VERIFIED',
      dataMode: 'fixture',
      conditionsVerified: true,
      project: {
        assetKey,
        name: `Synthetic ${externalId}`,
        chain: 'Fixture',
        protocol: 'BRC-20',
        stage: 'ACTIVE',
        conditions: 'Explicit synthetic participation terms',
      },
      metrics: { observedAt: now, participantGrowthPct: 100 },
      ...overrides,
    };
    const item: RawItem = { externalId, payload: { normalized }, publishedAt: now };
    await sql`INSERT INTO raw_items(id,source_id,external_id,payload,published_at,first_seen_at,collected_at) VALUES(${rawId},${sourceId},${externalId},${json(item.payload)},${now},${now},${now})`;
    await persistEvent(connector, rawId, now, item);
    return (
      await sql`SELECT id,data FROM events WHERE source_id=${sourceId} AND external_id=${externalId}`
    )[0]!;
  }
  async function notices(eventId: string) {
    return sql`SELECT * FROM notifications WHERE event_id=${eventId} AND channel_id=${channelId} ORDER BY id`;
  }
  async function notice(id: string) {
    return (await sql`SELECT status,last_error,data FROM notifications WHERE id=${id}`)[0]!;
  }
  async function updateRule(rule: AlertRule, patch: Partial<AlertRule>) {
    const next = RuleSchema.parse({ ...rule, ...patch, version: rule.version + 1 });
    await sql`UPDATE alert_rules SET enabled=${next.enabled},version=${next.version},data=${json(next)} WHERE id=${rule.id}`;
    await sql`INSERT INTO alert_rule_versions(id,rule_id,version,data) VALUES(${randomUUID()},${rule.id},${next.version},${json(next)})`;
    return next;
  }
  try {
    await sql`INSERT INTO data_sources(id,name,mode,enabled,data) VALUES(${sourceId},'Synthetic notification policy integration','fixture',false,'{"syntheticTestEvidence":true}')`;
    await sql`INSERT INTO users(id,email,password_hash) VALUES(${ownerId},${`${suffix}@notification.fixture`},'not-a-login-hash')`;
    await sql`INSERT INTO notification_channels(id,owner_id,provider,name,enabled,data) VALUES(${channelId},${ownerId},'telegram','Synthetic policy channel',true,'{}')`;
    const rules: AlertRule[] = [];
    for (const includeRoutineEvents of [undefined, true]) {
      const now = new Date().toISOString();
      const rule = RuleSchema.parse({
        id: randomUUID(),
        ownerId,
        name: includeRoutineEvents ? 'Old explicit routine opt-in' : 'Old broad rule',
        conditions: {
          sourceIds: [sourceId],
          ...(includeRoutineEvents ? { includeRoutineEvents } : {}),
        },
        priority: 'P2',
        cooldownSeconds: 60,
        channelIds: [channelId],
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await sql`INSERT INTO alert_rules(id,owner_id,name,enabled,version,data) VALUES(${rule.id},${ownerId},${rule.name},true,1,${json(rule)})`;
      await sql`INSERT INTO alert_rule_versions(id,rule_id,version,data) VALUES(${randomUUID()},${rule.id},1,${json(rule)})`;
      rules.push(rule);
    }
    for (const eventType of [
      'PAIR_CREATED',
      'NEW_TOKEN_DEPLOYED',
      'MINT_CREATED',
      'MINT_STARTED',
      'TOKEN_STATE_SNAPSHOT',
    ]) {
      const event = await observation(eventType);
      check(
        (await notices(String(event.id))).length === 0,
        `${eventType} remains stored without notifications under old or opted-in rules`,
      );
    }
    const unverified = await observation('UNIQUE_PARTICIPANTS_SPIKE', {
      verificationStatus: 'UNVERIFIED',
    });
    check(
      (await notices(String(unverified.id))).length === 0,
      'Unverified derived momentum cannot become an opportunity notification',
    );
    const noTerms = await observation('PROJECT_LAUNCHED', { conditionsVerified: false });
    check(
      (await notices(String(noTerms.id))).length === 0,
      'Stage changes without verified terms cannot notify',
    );
    check(
      (
        await sql`SELECT id FROM alert_triggers WHERE rule_id=ANY(${rules.map((rule) => rule.id)}::uuid[])`
      ).length === 0,
      'Rejected observations create neither triggers nor notification outboxes',
    );

    const qualified = await observation('UNIQUE_PARTICIPANTS_SPIKE');
    const qualifiedNotices = await notices(String(qualified.id));
    check(qualifiedNotices.length === 2, 'Verified actionable momentum passes both existing rules');
    check(
      (
        await sql`SELECT id FROM outbox_jobs WHERE kind='NOTIFY' AND entity_id=ANY(${qualifiedNotices.map((row) => String(row.id))}::uuid[])`
      ).length === 2,
      'Opportunity notifications and recoverable outboxes commit together',
    );
    const firstQualified = qualifiedNotices[0]!;
    await sendNotification(String(firstQualified.id));
    const passed = await notice(String(firstQualified.id));
    check(
      passed.status === 'CANCELLED' &&
        String(passed.last_error).startsWith('SIMULATED') &&
        (passed.data.notificationRecheck as { matched: boolean }).matched,
      'A qualified queued opportunity passes send-time admission while Fixture prevents external delivery',
    );

    const secondQualified = qualifiedNotices.find((row) => row.id !== firstQualified.id)!;
    const secondTrigger = (
      await sql`SELECT rule_id FROM alert_triggers WHERE id=${String(secondQualified.data.triggerId)}`
    )[0]!;
    const secondRule = rules.find((rule) => rule.id === secondTrigger.rule_id)!;
    const stricterRule = await updateRule(secondRule, {
      conditions: { ...secondRule.conditions, minOpportunityScore: 100 },
    });
    await sendNotification(String(secondQualified.id));
    const tightened = await notice(String(secondQualified.id));
    check(
      tightened.status === 'CANCELLED' && String(tightened.last_error).includes('机会评分不满足'),
      'Queued notifications are cancelled when the current rule no longer matches',
    );
    await updateRule(stricterRule, { conditions: secondRule.conditions });

    const risk = await observation('LIQUIDITY_REMOVED', {
      verificationStatus: 'UNVERIFIED',
      conditionsVerified: false,
      riskFlags: ['LIQUIDITY_REMOVAL'],
    });
    const riskNotices = await notices(String(risk.id));
    check(
      riskNotices.length === 2 && Number(risk.data.riskScore) >= 85,
      'Structured severe risk remains independent of opportunity verification and score',
    );
    const disabledNotice = riskNotices[0]!;
    const disabledTrigger = (
      await sql`SELECT rule_id FROM alert_triggers WHERE id=${String(disabledNotice.data.triggerId)}`
    )[0]!;
    const disabledRule = RuleSchema.parse(
      (await sql`SELECT data FROM alert_rules WHERE id=${String(disabledTrigger.rule_id)}`)[0]!
        .data,
    );
    await updateRule(disabledRule, { enabled: false });
    await sendNotification(String(disabledNotice.id));
    check(
      String((await notice(String(disabledNotice.id))).last_error).includes('规则已停用'),
      'An automatic backlog item respects a disabled current rule',
    );
    await sendNotification(String(riskNotices[1]!.id));
    check(
      String((await notice(String(riskNotices[1]!.id))).last_error).startsWith('SIMULATED'),
      'Severe risk can pass send-time admission without waiting for AI',
    );

    // Exercise old live jobs with no triggerId: all data is explicitly synthetic and rejected before credentials/providers.
    config.dataMode = 'live';
    for (const [eventType, status] of [
      ['PAIR_CREATED', 'PENDING'],
      ['NEW_TOKEN_DEPLOYED', 'RETRYING'],
    ] as const) {
      const eventId = randomUUID();
      const id = randomUUID();
      const now = new Date().toISOString();
      const data = {
        ...qualified.data,
        id: eventId,
        eventType,
        dataMode: 'live',
        syntheticTestEvidence: true,
      };
      await sql`INSERT INTO events(id,fingerprint,source_id,external_id,title,event_type,severity,first_seen_at,data) VALUES(${eventId},${eventId},${sourceId},${eventId},'Synthetic legacy backlog',${eventType},'P2',${now},${json(data)})`;
      await sql`INSERT INTO notifications(id,dedup_key,channel_id,event_id,status,data) VALUES(${id},${id},${channelId},${eventId},${status},${json({ ...data, id, eventId, channelId })})`;
      await sendNotification(id);
      const rejected = await notice(id);
      check(
        rejected.status === 'CANCELLED' &&
          String(rejected.last_error).startsWith('通知发送前复查取消'),
        `${status} legacy ${eventType} is cancelled without triggerId or provider access`,
      );
      check(
        (
          await sql`SELECT id FROM notification_attempts WHERE notification_id=${id} AND outcome='CANCELLED' AND data->'notificationRecheck'->>'matched'='false'`
        ).length === 1,
        'Backlog cancellation preserves an explicit attempt and rejection evidence',
      );
      await sendNotification(id);
      check(
        (await sql`SELECT id FROM notification_attempts WHERE notification_id=${id}`).length === 1,
        'A cancelled automatic notification remains terminal',
      );
      const sentId = randomUUID();
      await sql`INSERT INTO notifications(id,dedup_key,channel_id,event_id,status,data) VALUES(${sentId},${sentId},${channelId},${eventId},'SENT',${json({ ...data, id: sentId, eventId, channelId })})`;
      await sendNotification(sentId);
      check(
        (await notice(sentId)).status === 'SENT' &&
          (await sql`SELECT id FROM notification_attempts WHERE notification_id=${sentId}`)
            .length === 0,
        'Previously SENT history is never rewritten by the new policy',
      );
    }
    config.dataMode = 'fixture';
    const manualId = randomUUID();
    await sql`INSERT INTO notifications(id,dedup_key,channel_id,status,data) VALUES(${manualId},${manualId},${channelId},'PENDING',${json({ id: manualId, title: 'Synthetic channel test', description: 'No real message', eventType: 'PAIR_CREATED', channelId, priority: 'P2', dataMode: 'fixture' })})`;
    await sendNotification(manualId);
    const manual = await notice(manualId);
    check(
      manual.status === 'CANCELLED' &&
        String(manual.last_error).startsWith('SIMULATED') &&
        (manual.data.notificationRecheck as { matched: boolean }).matched,
      'Manual channel tests without event_id remain independent of opportunity admission',
    );
    console.log(`Notification opportunity policy integration: ${checks} PostgreSQL checks passed`);
    return checks;
  } finally {
    config.dataMode = savedMode;
    await sql.begin(async (tx) => {
      await tx`DELETE FROM outbox_jobs WHERE entity_id IN (SELECT id FROM events WHERE source_id=${sourceId}) OR entity_id IN (SELECT id FROM notifications WHERE channel_id=${channelId} OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId}))`;
      await tx`DELETE FROM notification_attempts WHERE notification_id IN (SELECT id FROM notifications WHERE channel_id=${channelId} OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId}))`;
      await tx`DELETE FROM notifications WHERE channel_id=${channelId} OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM alert_triggers WHERE rule_id IN (SELECT id FROM alert_rules WHERE owner_id=${ownerId}) OR event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM alert_rule_versions WHERE rule_id IN (SELECT id FROM alert_rules WHERE owner_id=${ownerId})`;
      await tx`DELETE FROM alert_rules WHERE owner_id=${ownerId}`;
      await tx`DELETE FROM opportunity_signals WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM risk_assessments WHERE event_id IN (SELECT id FROM events WHERE source_id=${sourceId})`;
      await tx`DELETE FROM project_lifecycle_events WHERE project_id IN (SELECT id FROM projects WHERE asset_key LIKE ${`fixture:notification-policy:${suffix}:%`})`;
      await tx`DELETE FROM project_metrics WHERE source_id=${sourceId}`;
      await tx`DELETE FROM projects WHERE asset_key LIKE ${`fixture:notification-policy:${suffix}:%`}`;
      await tx`DELETE FROM event_sources WHERE source_id=${sourceId}`;
      await tx`DELETE FROM events WHERE source_id=${sourceId}`;
      await tx`DELETE FROM raw_items WHERE source_id=${sourceId}`;
      await tx`DELETE FROM data_sources WHERE id=${sourceId}`;
      await tx`DELETE FROM notification_channels WHERE id=${channelId}`;
      await tx`DELETE FROM users WHERE id=${ownerId}`;
    });
  }
}
