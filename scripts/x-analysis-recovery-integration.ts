import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql } from '../packages/database/src/index.js';
import { analyzeEvent, reconcileAnalysisBacklog } from '../apps/worker/src/jobs.js';

/** PostgreSQL regression using only Fixture AI and explicitly synthetic social evidence.
 * A temporary live-mode replay verifies recovery without reading a provider configuration. */
export async function verifyXAnalysisRecovery() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('X analysis recovery requires a non-production Fixture database');
  const savedMode = config.dataMode;
  const sourceId = `x-ai-recovery-fixture-${randomUUID()}`;
  const userId = randomUUID();
  const ruleId = randomUUID();
  const channelId = randomUUID();
  const eventId = randomUUID();
  const rawId = randomUUID();
  const outboxId = randomUUID();
  const now = new Date().toISOString();
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  let checks = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    checks++;
  };
  const storedEvent = async () =>
    (await sql`SELECT data FROM events WHERE id=${eventId}`)[0]!.data as Record<string, unknown>;
  const storedRun = async () =>
    (await sql`SELECT status,data FROM ai_analysis_runs WHERE event_id=${eventId}`)[0]!;
  try {
    await sql`INSERT INTO users(id,email,password_hash,enabled) VALUES(${userId},${`${userId}@example.invalid`},'synthetic-disabled-user',false)`;
    await sql`INSERT INTO user_settings(user_id,data) VALUES(${userId},${json({ timezone: 'invalid/synthetic-timezone', notifications: { quietStart: 1, quietEnd: 2, minimumPriority: 'P2' } })})`;
    await sql`INSERT INTO data_sources(id,name,mode,enabled,data) VALUES(${sourceId},'Fixture X analysis recovery','fixture',false,'{"syntheticTestEvidence":true}')`;
    await sql`INSERT INTO notification_channels(id,owner_id,name,provider,enabled,data) VALUES(${channelId},${userId},'Fixture X recovery channel','telegram',true,'{}')`;
    const rule = {
      id: ruleId,
      ownerId: userId,
      name: 'Fixture X recovery rule',
      enabled: true,
      version: 1,
      conditions: { eventTypes: ['X_HOT_TOPIC'], sourceIds: [sourceId] },
      priority: 'P2',
      cooldownSeconds: 60,
      channelIds: [channelId],
      createdAt: now,
      updatedAt: now,
    };
    await sql`INSERT INTO alert_rules(id,owner_id,name,enabled,data) VALUES(${ruleId},${userId},${rule.name},true,${json(rule)})`;
    const event = {
      id: eventId,
      sourceId,
      externalId: eventId,
      title: 'Synthetic X recovery topic',
      description: 'Fixture evidence only; no real social observation or opportunity',
      eventType: 'X_HOT_TOPIC',
      dataMode: 'fixture',
      syntheticTestEvidence: true,
      assets: [],
      categories: ['social'],
      firstSeenAt: now,
      sourcePublishedAt: now,
      confidence: 0.5,
      verificationStatus: 'UNVERIFIED',
      opportunityScore: 0,
      riskScore: 50,
      analysisStatus: 'PENDING',
    };
    await sql`INSERT INTO events(id,fingerprint,source_id,external_id,title,event_type,severity,first_seen_at,data) VALUES(${eventId},${eventId},${sourceId},${eventId},${event.title},'X_HOT_TOPIC','P2',${now},${json(event)})`;
    await sql`INSERT INTO raw_items(id,source_id,external_id,payload,first_seen_at,collected_at) VALUES(${rawId},${sourceId},${rawId},'{"text":"Explicitly synthetic social evidence","syntheticTestEvidence":true}',${now},${now})`;
    await sql`INSERT INTO event_sources(id,event_id,source_id,raw_item_id,url,data) VALUES(${randomUUID()},${eventId},${sourceId},${rawId},'https://example.invalid/synthetic-x-recovery','{"title":"Synthetic X recovery evidence"}')`;
    await sql`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) VALUES(${outboxId},${outboxId},'ANALYZE',${eventId})`;

    await assert.rejects(() => analyzeEvent(eventId), RangeError);
    checks++;
    let run = await storedRun();
    check(
      run.status === 'COMPLETED' && (await storedEvent()).analysisStatus === 'COMPLETED',
      'Notification failure cannot roll back or mark a completed provider result failed',
    );
    const originalResult = JSON.stringify((run.data as Record<string, unknown>).result);
    check(
      (await sql`SELECT status FROM outbox_jobs WHERE id=${outboxId}`)[0]?.status === 'PENDING' &&
        (await sql`SELECT id FROM notifications WHERE event_id=${eventId}`).length === 0,
      'Notification failure leaves durable analysis work retryable without partial notices',
    );

    // Simulate event projection recovery while its provider result is already cached.
    await sql`UPDATE events SET data=data || '{"analysisStatus":"PENDING"}'::jsonb WHERE id=${eventId}`;
    await assert.rejects(() => analyzeEvent(eventId), RangeError);
    checks++;
    run = await storedRun();
    check(
      run.status === 'COMPLETED' &&
        (await storedEvent()).analysisStatus === 'COMPLETED' &&
        Number((run.data as Record<string, unknown>).attempts) === 1 &&
        ((run.data as Record<string, unknown>).reservations as unknown[]).length === 1,
      'Cached completion also commits before notifications without another provider reservation',
    );

    await sql`UPDATE user_settings SET data=jsonb_set(data,'{timezone}','"UTC"') WHERE user_id=${userId}`;
    const staleAt = new Date(Date.now() - 7_200_000).toISOString();
    await sql`UPDATE events SET first_seen_at=${staleAt},data=data || ${json({ dataMode: 'live', firstSeenAt: staleAt, sourcePublishedAt: staleAt })}::jsonb WHERE id=${eventId}`;
    config.dataMode = 'live';
    await reconcileAnalysisBacklog();
    check(
      (await sql`SELECT status FROM outbox_jobs WHERE id=${outboxId}`)[0]?.status === 'PENDING',
      'Expired candidate cleanup preserves completed X work awaiting its notification phase',
    );
    await analyzeEvent(eventId);
    await analyzeEvent(eventId);
    run = await storedRun();
    check(
      run.status === 'COMPLETED' &&
        JSON.stringify((run.data as Record<string, unknown>).result) === originalResult &&
        Number((run.data as Record<string, unknown>).attempts) === 1 &&
        (await sql`SELECT id FROM ai_analysis_runs WHERE event_id=${eventId}`).length === 1,
      'Completed live replay retains the original result and never invokes a paid provider',
    );
    check(
      (await sql`SELECT id FROM notifications WHERE event_id=${eventId}`).length === 1 &&
        (await sql`SELECT id FROM alert_triggers WHERE event_id=${eventId}`).length === 1 &&
        (await sql`SELECT status FROM outbox_jobs WHERE id=${outboxId}`)[0]?.status === 'COMPLETED',
      'Replayed notification phase creates exactly one notice and retires analysis work after success',
    );
    console.log(`X analysis recovery integration: ${checks} checks passed`);
    return checks;
  } finally {
    config.dataMode = savedMode;
    await sql.begin(async (tx) => {
      await tx`DELETE FROM outbox_jobs WHERE entity_id=${eventId} OR entity_id IN (SELECT id FROM notifications WHERE event_id=${eventId})`;
      await tx`DELETE FROM notification_attempts WHERE notification_id IN (SELECT id FROM notifications WHERE event_id=${eventId})`;
      await tx`DELETE FROM notifications WHERE event_id=${eventId}`;
      await tx`DELETE FROM alert_triggers WHERE event_id=${eventId}`;
      await tx`DELETE FROM alert_rules WHERE id=${ruleId}`;
      await tx`DELETE FROM notification_channels WHERE id=${channelId}`;
      await tx`DELETE FROM user_settings WHERE user_id=${userId}`;
      await tx`DELETE FROM users WHERE id=${userId}`;
      await tx`DELETE FROM ai_analysis_runs WHERE event_id=${eventId}`;
      await tx`DELETE FROM event_sources WHERE event_id=${eventId}`;
      await tx`DELETE FROM events WHERE id=${eventId}`;
      await tx`DELETE FROM raw_items WHERE id=${rawId}`;
      await tx`DELETE FROM data_sources WHERE id=${sourceId}`;
    });
  }
}
