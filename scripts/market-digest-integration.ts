import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql } from '../packages/database/src/index.js';
import { sendNotification } from '../apps/worker/src/jobs.js';
import { runMarketDigest } from '../apps/worker/src/market-digest.js';

/** Two synthetic reporting days, through the real PostgreSQL scheduler and delivery path. */
export async function verifyMarketDigest() {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('Market digest integration requires a non-production Fixture database');
  const ownerId = randomUUID();
  const source = `fixture-digest-${ownerId}`;
  const other = `fixture-other-${ownerId}`;
  const activeChannel = randomUUID();
  const disabledChannel = randomUUID();
  const day = '2091-03-20';
  const yesterday = '2091-03-19';
  const tomorrow = '2091-03-21';
  const datedKeys = [day, tomorrow].map((date) => `market-digest:fixture:${date}:%`);
  const guard =
    await sql`SELECT id FROM notifications WHERE dedup_key LIKE ANY(${datedKeys}::text[])`;
  assert.equal(guard.length, 0, 'Synthetic reporting dates must be unused by the test database');

  let checks = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    checks++;
  };
  async function sample(
    asset: string,
    value: number,
    observedAt: string,
    options: {
      unit?: string;
      sourceId?: string;
      sourceDate?: string;
      firstSeenAt?: string;
      mode?: 'live' | 'fixture';
    } = {},
  ) {
    const sourceId = options.sourceId ?? source;
    const evidenceId = randomUUID();
    const firstSeenAt = options.firstSeenAt ?? observedAt;
    const metadata = {
      name: asset,
      rawDataReference: evidenceId,
      dataMode: options.mode ?? 'fixture',
      frequency: options.sourceDate ? 'daily' : 'tick',
      sourceDate: options.sourceDate ?? null,
    };
    await sql`INSERT INTO raw_items(id,source_id,external_id,payload,first_seen_at,collected_at)
      VALUES(${evidenceId},${sourceId},${evidenceId},'{"syntheticFixture":true}',${firstSeenAt},${firstSeenAt})`;
    await sql`INSERT INTO market_observations(id,asset_key,source_id,value,unit,observed_at,data)
      VALUES(${randomUUID()},${asset},${sourceId},${value},${options.unit ?? 'USD'},${observedAt},${sql.json(metadata)})`;
  }

  try {
    await sql`INSERT INTO users(id,email,password_hash) VALUES(${ownerId},${`${ownerId}@digest.fixture`},'fixture-only')`;
    await sql`INSERT INTO notification_channels(id,owner_id,provider,name,enabled) VALUES
      (${activeChannel},${ownerId},'telegram','Fixture daily digest',true),
      (${disabledChannel},${ownerId},'bark','Disabled fixture channel',false)`;
    await sql`INSERT INTO data_sources(id,name,mode) VALUES
      (${source},'Synthetic digest history','fixture'),(${other},'Alternate synthetic history','fixture')`;
    await sample('BTC', 100, `${yesterday}T01:55:00Z`);
    await sample('BTC', 888, `${yesterday}T01:56:00Z`, { unit: 'EUR' });
    await sample('BTC', 777, `${yesterday}T01:57:00Z`, { sourceId: other });
    await sample('BTC', 666, `${yesterday}T02:01:00Z`);
    await sample('BTC', 555, `${yesterday}T01:58:00Z`, { firstSeenAt: `${yesterday}T02:05:00Z` });
    await sample('BTC', 110, `${day}T01:55:00Z`);
    await sample('BTC', 444, `${day}T01:56:00Z`, { firstSeenAt: `${day}T02:01:00Z` });
    await sample('BTC', 333, `${day}T01:57:00Z`, { mode: 'live' });
    await sample('BTC', 222, `${day}T02:00:01Z`);
    await sample('ETH', 0, `${yesterday}T01:50:00Z`);
    await sample('ETH', 10, `${day}T01:50:00Z`);
    await sample('XAU', 1234, `${day}T01:50:00Z`);
    // Distinct business dates can arrive together. A late backfill must not replace the latest date.
    await sample('US10Y', 4, `${day}T01:10:00Z`, { sourceDate: '2091-03-16', unit: '%' });
    await sample('US10Y', 3, `${day}T01:11:00Z`, { sourceDate: '2091-03-17', unit: '%' });
    await sample('US10Y', 8, `${day}T01:12:00Z`, { sourceDate: '2091-03-15', unit: '%' });
    await sample('WTI', 65, `${day}T01:10:00Z`, { sourceDate: '2091-03-14' });
    await sample('WTI', 60, `${day}T01:11:00Z`, { sourceDate: '2091-03-17' });

    await runMarketDigest(new Date(`${day}T01:59:59.999Z`));
    check(
      !(await sql`SELECT id FROM notifications WHERE channel_id=${activeChannel}`).length,
      'Before Beijing 10:00 no digest is generated',
    );
    const at = new Date(`${day}T02:00:00Z`);
    await Promise.all([runMarketDigest(at), runMarketDigest(at)]);
    await runMarketDigest(new Date(`${day}T05:00:00Z`));
    const notices =
      await sql`SELECT * FROM notifications WHERE channel_id IN (${activeChannel},${disabledChannel})`;
    check(
      notices.length === 1 &&
        notices[0]!.channel_id === activeChannel &&
        notices[0]!.status === 'PENDING',
      'Concurrent workers and a later run queue a single digest for the enabled channel',
    );
    const notice = notices[0]!;
    check(
      notice.dedup_key === `market-digest:fixture:${day}:${activeChannel}` &&
        notice.data.dataMode === 'fixture' &&
        notice.event_id === null,
      'Mode, date and channel identify the durable fixture digest',
    );
    check(
      (
        await sql`SELECT id FROM outbox_jobs WHERE entity_id=${notice.id} AND kind='NOTIFY' AND status='PENDING'`
      ).length === 1,
      'The durable digest and a single notification outbox are persisted',
    );
    const rows = notice.data.rows as {
      assetKey: string;
      value: number;
      sourceId: string;
      previousValue: number | null;
      changePct: number | null;
      changeBps: number | null;
      sourceDate: string | null;
      previousSourceDate: string | null;
    }[];
    const row = (symbol: string) =>
      rows.find((item) => item.assetKey === symbol && item.sourceId === source);
    const btc = row('BTC');
    check(
      btc?.value === 110 && btc.previousValue === 100 && btc.changePct === 10,
      'Tick changes use comparable data known by each cutoff, with matching source, unit and mode',
    );
    check(row('ETH')?.changePct === null, 'Zero baseline yields an unknown percentage');
    check(row('XAU')?.changePct === null, 'Missing previous-day data yields an unknown percentage');
    const yieldRow = row('US10Y');
    check(
      yieldRow?.sourceDate === '2091-03-17' &&
        yieldRow.previousSourceDate === '2091-03-16' &&
        yieldRow.changePct === -25 &&
        yieldRow.changeBps === -100,
      'Daily yield uses business dates and reports relative percent and basis points separately',
    );
    check(
      row('WTI')?.changePct === null,
      'A missing prior calendar date cannot become a multi-day change',
    );
    check(
      notice.data.description.includes('BTC') &&
        notice.data.description.includes('+10.00%') &&
        notice.data.description.includes('2091-03-17') &&
        notice.data.body === notice.data.description,
      'The provider description and notification history expose the digest with daily data dates',
    );
    await sendNotification(String(notice.id));
    const sent = (
      await sql`SELECT status,last_error,accepted_at FROM notifications WHERE id=${notice.id}`
    )[0]!;
    check(
      sent.status === 'CANCELLED' &&
        String(sent.last_error).includes('SIMULATED') &&
        sent.accepted_at === null,
      'Fixture goes through the delivery worker without external acceptance',
    );
    await runMarketDigest(new Date(`${tomorrow}T07:00:00Z`));
    check(
      (
        await sql`SELECT id FROM notifications WHERE channel_id=${activeChannel} AND dedup_key=${`market-digest:fixture:${tomorrow}:${activeChannel}`}`
      ).length === 1,
      'A worker recovering after 10:00 creates the new day’s digest once',
    );
    console.log(`Daily market digest integration passed: ${checks} PostgreSQL checks (Fixture).`);
    return { checks };
  } finally {
    // Reporting is global, including the seeded test admin's enabled channels.
    // These two dates were reserved above so cleanup also covers their generated outboxes.
    await sql.begin(async (tx) => {
      const notices = tx`SELECT id FROM notifications WHERE dedup_key LIKE ANY(${datedKeys}::text[])`;
      await tx`DELETE FROM notification_attempts WHERE notification_id IN (${notices})`;
      await tx`DELETE FROM outbox_jobs WHERE entity_id IN (${notices})`;
      await tx`DELETE FROM notifications WHERE dedup_key LIKE ANY(${datedKeys}::text[])`;
      await tx`DELETE FROM notification_channels WHERE owner_id=${ownerId}`;
      await tx`DELETE FROM users WHERE id=${ownerId}`;
      await tx`DELETE FROM market_observations WHERE source_id IN (${source},${other})`;
      await tx`DELETE FROM raw_items WHERE source_id IN (${source},${other})`;
      await tx`DELETE FROM data_sources WHERE id IN (${source},${other})`;
    });
  }
}
