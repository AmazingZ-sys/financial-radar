import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql } from '../packages/database/src/index.js';
import {
  analyzeEvent,
  claimOutboxJobs,
  extendAnalysisOutboxLease,
  recoverLeases,
} from '../apps/worker/src/jobs.js';

/** Real PostgreSQL recovery checks using explicitly synthetic Fixture evidence only. */
export async function verifyAIStreamingRecovery() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('AI recovery verification requires a non-production Fixture database');
  let checks = 0;
  function check(value: unknown, message: string) {
    assert.ok(value, message);
    checks++;
  }
  const sourceId = `ai-streaming-fixture-${randomUUID()}`;
  const eventId = randomUUID();
  const rawId = randomUUID();
  const recentRunId = randomUUID();
  const expiredRunId = randomUUID();
  const noticeId = randomUUID();
  const analysisOutboxId = randomUUID();
  const aliasOutboxId = randomUUID();
  const notifyOutboxId = randomUUID();
  const channel = (await sql`SELECT id FROM notification_channels ORDER BY created_at LIMIT 1`)[0];
  assert.ok(channel, 'Seeded notification channel required for recovery verification');
  try {
    await sql`INSERT INTO data_sources(id,name,mode,enabled,data) VALUES(${sourceId},'AI streaming Fixture recovery','fixture',false,'{"dataMode":"fixture"}')`;
    await sql`INSERT INTO raw_items(id,source_id,external_id,payload,first_seen_at,collected_at) VALUES(${rawId},${sourceId},${rawId},'{"title":"Fixture streaming recovery evidence","dataMode":"fixture"}',now(),now())`;
    await sql`INSERT INTO events(id,fingerprint,source_id,external_id,title,event_type,severity,first_seen_at,data) VALUES(${eventId},${eventId},${sourceId},${eventId},'Fixture streaming recovery','fixture','P2',now(),'{"dataMode":"fixture","assets":[],"title":"Fixture streaming recovery"}')`;
    await sql`INSERT INTO event_sources(id,event_id,source_id,raw_item_id,url,data) VALUES(${randomUUID()},${eventId},${sourceId},${rawId},'https://example.invalid/fixture-ai-streaming','{"title":"Fixture streaming recovery evidence"}')`;
    await sql`INSERT INTO ai_analysis_runs(id,status,provider,model,prompt_version,cache_key,created_at,data) VALUES(${recentRunId},'RUNNING','fixture','fixture-recovery','fixture-recovery',${recentRunId},now()-interval '6 minutes',jsonb_build_object('leaseStartedAt',now()-interval '6 minutes')),(${expiredRunId},'RUNNING','fixture','fixture-recovery','fixture-recovery',${expiredRunId},now()-interval '16 minutes',jsonb_build_object('leaseStartedAt',now()-interval '16 minutes'))`;
    await sql`INSERT INTO notifications(id,dedup_key,channel_id,event_id,status,locked_until,data) VALUES(${noticeId},${noticeId},${String(channel.id)},${eventId},'SENDING',now()-interval '1 second','{"dataMode":"fixture"}')`;
    await sql`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id,created_at) VALUES(${analysisOutboxId},${analysisOutboxId},'ANALYZE',${eventId},'2000-01-01'),(${aliasOutboxId},${aliasOutboxId},'ANALYSIS',${eventId},'2000-01-01'),(${notifyOutboxId},${`notify:${noticeId}`},'NOTIFY',${noticeId},'2000-01-01')`;

    await recoverLeases();
    const leases =
      await sql`SELECT id,status,error FROM ai_analysis_runs WHERE id IN (${recentRunId},${expiredRunId})`;
    check(
      leases.find((row) => row.id === recentRunId)?.status === 'RUNNING',
      'A six-minute active analysis remains RUNNING beyond the old recovery threshold',
    );
    const expired = leases.find((row) => row.id === expiredRunId);
    check(
      expired?.status === 'FAILED' && String(expired.error).includes('budget reservation retained'),
      'An abandoned sixteen-minute analysis is recovered without discarding its reservation',
    );
    check(
      (await sql`SELECT status FROM notifications WHERE id=${noticeId}`)[0]?.status === 'RETRYING',
      'Notification recovery keeps its independent short lease',
    );

    const claimed = await claimOutboxJobs();
    for (const id of [analysisOutboxId, aliasOutboxId, notifyOutboxId])
      check(
        claimed.some((row) => row.id === id),
        'Fixture recovery outbox is claimed',
      );
    const outboxes =
      await sql`SELECT id,status,extract(epoch FROM(locked_until-now()))::float AS seconds FROM outbox_jobs WHERE id IN (${analysisOutboxId},${aliasOutboxId},${notifyOutboxId})`;
    for (const id of [analysisOutboxId, aliasOutboxId]) {
      const row = outboxes.find((entry) => entry.id === id)!;
      check(
        row.status === 'QUEUED' && Number(row.seconds) > 840 && Number(row.seconds) <= 900,
        'Both ANALYZE and ANALYSIS receive a fifteen-minute outbox lease',
      );
    }
    const noticeOutbox = outboxes.find((row) => row.id === notifyOutboxId)!;
    check(
      Number(noticeOutbox.seconds) > 90 && Number(noticeOutbox.seconds) <= 120,
      'NOTIFY retains its two-minute outbox lease',
    );
    await sql`UPDATE outbox_jobs SET locked_until=now()+interval '30 seconds' WHERE id=${analysisOutboxId}`;
    await extendAnalysisOutboxLease(analysisOutboxId);
    check(
      Number(
        (
          await sql`SELECT extract(epoch FROM(locked_until-now()))::float AS seconds FROM outbox_jobs WHERE id=${analysisOutboxId}`
        )[0]!.seconds,
      ) > 840,
      'Starting a queued analysis refreshes the complete lease after queue waiting',
    );

    await analyzeEvent(eventId);
    const firstRun = (await sql`SELECT id FROM ai_analysis_runs WHERE event_id=${eventId}`)[0]!;
    await sql`UPDATE ai_analysis_runs SET status='FAILED',error='Fixture prior attempt error',completed_at='2000-01-01',data=jsonb_set(data,'{leaseStartedAt}','"2000-01-01T00:00:00.000Z"') WHERE id=${String(firstRun.id)}`;
    const retryStarted = Date.now();
    await analyzeEvent(eventId);
    const retried = (
      await sql`SELECT status,error,completed_at,data FROM ai_analysis_runs WHERE id=${String(firstRun.id)}`
    )[0]!;
    check(
      retried.status === 'COMPLETED' && retried.error === null,
      'Retry removes prior failure state',
    );
    check(
      new Date(retried.completed_at as string).getTime() >= retryStarted - 1000,
      'Retry completion does not retain a previous attempt timestamp',
    );
    const retryData = retried.data as {
      leaseStartedAt: string;
      attempts: number;
      reservations: unknown[];
    };
    check(
      new Date(retryData.leaseStartedAt).getTime() >= retryStarted - 1000,
      'Retry refreshes leaseStartedAt instead of being recovered against its first attempt',
    );
    check(
      retryData.attempts === 2 && retryData.reservations.length === 2,
      'Retry retains a separate conservative reservation for each actual Fixture attempt',
    );
    console.log(`AI streaming recovery integration: ${checks} checks passed`);
    return checks;
  } finally {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM outbox_jobs WHERE entity_id IN (${eventId},${noticeId})`;
      await tx`DELETE FROM notification_attempts WHERE notification_id=${noticeId}`;
      await tx`DELETE FROM notifications WHERE id=${noticeId}`;
      await tx`DELETE FROM ai_analysis_runs WHERE id IN (${recentRunId},${expiredRunId}) OR event_id=${eventId}`;
      await tx`DELETE FROM event_sources WHERE event_id=${eventId}`;
      await tx`DELETE FROM events WHERE id=${eventId}`;
      await tx`DELETE FROM raw_items WHERE id=${rawId}`;
      await tx`DELETE FROM data_sources WHERE id=${sourceId}`;
    });
  }
}
