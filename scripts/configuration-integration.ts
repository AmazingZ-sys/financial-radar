import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql, readAIConfig, readNotificationConfig } from '../packages/database/src/index.js';
import { NewsRssConnector } from '../packages/connectors/src/index.js';
import type { createApp } from '../apps/api/src/app.js';
import { registry, runIngestion, synchronizeCustomSources } from '../apps/worker/src/pipeline.js';
import { analyzeEvent, sendNotification } from '../apps/worker/src/jobs.js';

/** Real PostgreSQL/API verification; synthetic feed transport never reaches the internet. */
export async function verifyConfiguration(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
) {
  let checks = 0;
  function check(value: unknown, message: string) {
    assert.ok(value, message);
    checks++;
  }
  const secret = `integration-placeholder-${randomUUID()}`;
  const rootKeyBefore = config.integrationEncryptionKey;
  const modeBefore = config.dataMode;
  const apiKeyBefore = config.aiApiKey;
  const oldAI = (await sql`SELECT data FROM system_settings WHERE key='integrations:ai'`)[0];
  const channels = await sql`SELECT * FROM notification_channels ORDER BY provider`;
  const telegram = channels.find((row) => row.provider === 'telegram')!;
  const feishu = channels.find((row) => row.provider === 'feishu')!;
  const bark = channels.find((row) => row.provider === 'bark')!;
  const fakeFeedUrl = `https://1.1.1.1/integration-${randomUUID()}.xml`;
  let sourceId: string | undefined;
  const brokenNoticeId = randomUUID();
  const request = (path: string, body?: unknown, method = 'PATCH') =>
    app.request(`/api/v1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const noCsrf = await app.request('/api/v1/integrations/ai', {
      method: 'PATCH',
      headers: { ...headers, 'X-CSRF-Token': 'invalid' },
      body: JSON.stringify({ name: 'forbidden' }),
    });
    check(noCsrf.status === 403, 'Integration credentials require CSRF');
    for (const baseUrl of [
      'https://127.0.0.1/v1',
      'https://169.254.169.254/v1',
      'https://1.1.1.1/v1?api_key=forbidden',
    ]) {
      check(
        (await request('/integrations/ai', { baseUrl })).status === 400,
        'Unsafe or query-credential AI endpoint rejected',
      );
    }
    const saved = await request('/integrations/ai', {
      name: 'Integration relay',
      enabled: true,
      baseUrl: 'https://1.1.1.1/integration/v1',
      model: 'integration-model',
      apiKey: secret,
      jsonMode: false,
      timeoutMs: 9000,
      dailyBudgetUsd: 2,
      maxCallCostUsd: 0.05,
    });
    check(saved.status === 200, 'Relay settings saved through authenticated API');
    const view = await saved.json();
    check(
      view.data.apiKeyConfigured &&
        view.data.configOrigin === 'database' &&
        view.data.jsonMode === false &&
        !JSON.stringify(view).includes(secret),
      'Config view reports saved state without returning API key',
    );
    const stored = (await sql`SELECT data FROM system_settings WHERE key='integrations:ai'`)[0]!;
    check(!JSON.stringify(stored).includes(secret), 'AI API key encrypted at rest');
    config.aiApiKey = '';
    check(
      (await readAIConfig()).apiKey === secret,
      'Worker reads saved credentials with empty environment',
    );
    await request('/integrations/ai', { apiKey: '', name: 'Integration updated' });
    check(
      (await readAIConfig()).apiKey === secret,
      'Blank API key preserves existing encrypted key',
    );
    const test = await request('/integrations/ai/test', undefined, 'POST');
    check(
      test.status === 200 && (await test.json()).data.status === 'skipped',
      'Fixture AI test never calls a real provider',
    );

    const notification = await request(`/notification-channels/${telegram.id}`, {
      botToken: secret,
      chatId: '-100000000',
    });
    check(notification.status === 200, 'Notification credentials can be saved from console API');
    check(!(await notification.text()).includes(secret), 'Notification write never echoes token');
    const channelData = (
      await sql`SELECT data FROM notification_channels WHERE id=${telegram.id}`
    )[0]!.data;
    check(!JSON.stringify(channelData).includes(secret), 'Notification token encrypted at rest');
    check(
      readNotificationConfig('telegram', channelData).botToken === secret,
      'Worker reads saved notification credentials',
    );
    const webhook = `https://1.1.1.1/webhook/${secret}`;
    check(
      (await request(`/notification-channels/${feishu.id}`, { webhookUrl: webhook })).status ===
        400,
      'Feishu requires an official webhook endpoint',
    );
    check(
      (await request(`/notification-channels/${bark.id}`, { serverUrl: webhook })).status === 200,
      'Bark channel accepts server configuration',
    );
    const channelList = await app.request('/api/v1/notification-channels', { headers });
    check(
      !(await channelList.text()).includes(secret),
      'Channel list does not reveal webhook or token',
    );
    await request(`/notification-channels/${telegram.id}`, { botToken: '' });
    check(
      readNotificationConfig(
        'telegram',
        (await sql`SELECT data FROM notification_channels WHERE id=${telegram.id}`)[0]!.data,
      ).botToken === secret,
      'Blank token retains old credential',
    );
    await request(`/notification-channels/${telegram.id}`, { clearCredentials: true });
    check(
      !readNotificationConfig(
        'telegram',
        (await sql`SELECT data FROM notification_channels WHERE id=${telegram.id}`)[0]!.data,
      ).configured,
      'Explicit credential clear does not fall back to environment',
    );

    // A changed root key must permit explicit replacement rather than trapping the installation.
    config.integrationEncryptionKey = 'integration-replacement-root-key-32-characters';
    const broken = await app.request('/api/v1/integrations/ai', { headers });
    check(broken.status === 503, 'Undecryptable credentials return a safe actionable error');
    const fixtureAnalysis = (
      await sql`SELECT id FROM events WHERE data->>'dataMode'='fixture' AND data->>'analysisStatus'='COMPLETED' LIMIT 1`
    )[0]!;
    await analyzeEvent(String(fixtureAnalysis.id));
    check(
      (await sql`SELECT data FROM events WHERE id=${fixtureAnalysis.id}`)[0]!.data
        .analysisStatus === 'COMPLETED',
      'Fixture analysis remains available when unrelated live credentials cannot decrypt',
    );
    check(
      (await request('/integrations/ai', { apiKey: secret })).status === 200,
      'Explicit new key repairs obsolete ciphertext',
    );
    await request('/integrations/ai', { clearApiKey: true });
    check(!(await readAIConfig()).apiKey, 'Explicit API key clear persists');
    await request('/integrations/ai', { apiKey: secret });
    const damagedChannels = await app.request('/api/v1/notification-channels', { headers });
    const damagedViews = await damagedChannels.json();
    check(
      damagedChannels.status === 200 &&
        damagedViews.data.some(
          (row: { id: string; configured: boolean }) => row.id === telegram.id && !row.configured,
        ),
      'Damaged channel credentials remain editable without exposing ciphertext',
    );
    check(
      (await app.request('/api/v1/system/status', { headers })).status === 200,
      'Damaged notification credentials do not hide system status',
    );

    const catalog = await app.request('/api/v1/sources/catalog', { headers });
    const listing = await catalog.json();
    check(
      catalog.status === 200 && listing.meta.dataMode === 'fixture',
      'Live catalog available in Fixture without mode confusion',
    );
    for (const category of ['world', 'technology', 'finance', 'macro'])
      check(
        listing.data.some((row: { categories: string[] }) => row.categories.includes(category)),
        `Catalog includes ${category} sources`,
      );
    check(
      listing.data.every((row: { enabled: boolean }) => !row.enabled),
      'Fixture catalog never claims live sources enabled',
    );
    const sourceInput = {
      name: 'Integration synthetic RSS',
      feedUrl: fakeFeedUrl,
      categories: ['world', 'finance'],
      intervalSeconds: 300,
    };
    check(
      (await request('/sources', sourceInput, 'POST')).status === 409,
      'Fixture refuses real source creation',
    );
    config.dataMode = 'live';
    await sql`UPDATE notification_channels SET enabled=true WHERE id=${telegram.id}`;
    await sql`INSERT INTO notifications(id,dedup_key,channel_id,data) VALUES(${brokenNoticeId},${'integration-broken:' + brokenNoticeId},${telegram.id},${sql.json({ title: 'Integration synthetic broken configuration', description: 'No external transport should run', priority: 'P3', dataMode: 'live' })})`;
    await sendNotification(brokenNoticeId);
    const failedNotice = (
      await sql`SELECT status,locked_until,last_error FROM notifications WHERE id=${brokenNoticeId}`
    )[0]!;
    check(
      failedNotice.status === 'FAILED' &&
        failedNotice.locked_until === null &&
        failedNotice.last_error.includes('配置'),
      'Bad encrypted channel fails durably and releases lease without external send',
    );
    check(
      (
        await sql`SELECT outcome FROM notification_attempts WHERE notification_id=${brokenNoticeId}`
      )[0]?.outcome === 'FAILED',
      'Broken channel attempt preserves failure audit',
    );
    check(
      (await request('/sources', { ...sourceInput, feedUrl: 'https://127.0.0.1/news.xml' }, 'POST'))
        .status === 400,
      'Private-network RSS URL rejected',
    );
    const created = await request('/sources', sourceInput, 'POST');
    const source = await created.json();
    check(created.status === 200 && source.data.created, 'Custom source saved in PostgreSQL');
    sourceId = source.data.id as string;
    const duplicate = await request('/sources', sourceInput, 'POST');
    const duplicateSource = await duplicate.json();
    check(
      duplicateSource.data.id === sourceId && !duplicateSource.data.created,
      'Duplicate feed creation idempotent',
    );
    await synchronizeCustomSources();
    check(Boolean(registry.get(sourceId)), 'Running worker discovers new source without restart');
    const xml = `<rss version="2.0"><channel><item><guid>${sourceId}</guid><title>Integration synthetic news</title><description>Test transport only</description><link>https://example.com/${sourceId}</link></item></channel></rss>`;
    function injectTransport() {
      registry.remove(sourceId!);
      registry.register(
        new NewsRssConnector(
          {
            id: sourceId!,
            name: sourceInput.name,
            categories: sourceInput.categories,
            feedUrl: fakeFeedUrl,
            pollIntervalSeconds: 300,
          },
          async () => new Response(xml),
        ),
      );
    }
    injectTransport();
    const ingested = await runIngestion(sourceId);
    check(ingested.inserted === 1, 'Synthetic news contract traverses real ingestion pipeline');
    const eventRow = (await sql`SELECT id,data FROM events WHERE source_id=${sourceId}`)[0]!;
    const event = eventRow.data;
    check(
      event.eventType === 'NEWS' && event.verificationStatus === 'UNVERIFIED',
      'Custom news keeps verification and event type honest',
    );
    check(
      event.sourcePublishedAt === null && Boolean(event.firstSeenAt),
      'Missing source time remains null with separate discovery time',
    );
    check(
      event.analysisStatus === 'PENDING',
      'Saved AI credentials enqueue analysis even without environment API key',
    );
    config.dataMode = 'fixture';
    await analyzeEvent(String(eventRow.id));
    check(
      (await sql`SELECT data FROM events WHERE id=${eventRow.id}`)[0]!.data.analysisStatus ===
        'PENDING',
      'Fixture worker does not overwrite retained live events with synthetic AI',
    );
    config.dataMode = 'live';
    await request('/integrations/ai', { enabled: false });
    const fixtureEvent = (
      await sql`SELECT id,data FROM events WHERE data->>'dataMode'='fixture' AND data->>'analysisStatus'='COMPLETED' LIMIT 1`
    )[0]!;
    await analyzeEvent(String(fixtureEvent.id));
    check(
      (await sql`SELECT data FROM events WHERE id=${fixtureEvent.id}`)[0]!.data.analysisStatus ===
        fixtureEvent.data.analysisStatus,
      'Live worker ignores retained Fixture AI jobs after mode switch',
    );
    injectTransport();
    check(
      (await runIngestion(sourceId)).inserted === 0,
      'Repeated RSS items do not duplicate events',
    );
    check(
      (await request(`/sources/${sourceId}`, { intervalSeconds: 10 })).status === 400,
      'Custom RSS cannot poll faster than 60 seconds',
    );
    await request(`/sources/${sourceId}`, { enabled: false });
    await synchronizeCustomSources();
    check(
      (await runIngestion(sourceId)).skipped,
      'Disabling a source is respected by queued ingestion',
    );
    const auditRows =
      await sql`SELECT details FROM audit_logs WHERE entity_type IN ('ai_integration','notification_channel') AND details::text LIKE ${'%' + secret + '%'}`;
    check(auditRows.length === 0, 'Configuration audit contains no submitted credentials');
    console.log(
      `Configuration integration passed: ${checks} PostgreSQL/API checks; synthetic feed transport, no external sends.`,
    );
  } finally {
    config.integrationEncryptionKey = rootKeyBefore;
    config.dataMode = modeBefore;
    config.aiApiKey = apiKeyBefore;
    await sql`DELETE FROM notification_attempts WHERE notification_id=${brokenNoticeId}`;
    await sql`DELETE FROM notifications WHERE id=${brokenNoticeId}`;
    if (sourceId) {
      registry.remove(sourceId);
      const events = await sql`SELECT id FROM events WHERE source_id=${sourceId}`;
      for (const event of events) {
        await sql`DELETE FROM outbox_jobs WHERE entity_id=${event.id}`;
        await sql`DELETE FROM risk_assessments WHERE event_id=${event.id}`;
        await sql`DELETE FROM ai_analysis_runs WHERE event_id=${event.id}`;
        await sql`DELETE FROM event_sources WHERE event_id=${event.id}`;
        await sql`DELETE FROM events WHERE id=${event.id}`;
      }
      await sql`DELETE FROM raw_items WHERE source_id=${sourceId}`;
      await sql`DELETE FROM source_checkpoints WHERE source_id=${sourceId}`;
      await sql`DELETE FROM source_health_records WHERE source_id=${sourceId}`;
      await sql`DELETE FROM ingestion_runs WHERE source_id=${sourceId}`;
      await sql`DELETE FROM data_sources WHERE id=${sourceId}`;
    }
    await sql`DELETE FROM system_settings WHERE key='integrations:ai'`;
    if (oldAI)
      await sql`INSERT INTO system_settings(key,data) VALUES('integrations:ai',${sql.json(oldAI.data)})`;
    for (const channel of channels)
      await sql`UPDATE notification_channels SET name=${channel.name},enabled=${channel.enabled},data=${sql.json(channel.data)} WHERE id=${channel.id}`;
  }
}
