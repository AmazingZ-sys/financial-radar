import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import {
  sql,
  readXConfig,
  readXConfigView,
  reserveXRequest,
  saveXConfig,
  XRequestDeferredError,
} from '../packages/database/src/index.js';
import type { createApp } from '../apps/api/src/app.js';

/** Real PostgreSQL/API checks; all credentials are synthetic and no X/AI request is sent. */
export async function verifyXManagement(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
) {
  if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
    throw new Error('X management integration requires a non-production Fixture database');
  const savedMode = config.dataMode;
  const savedEncryptionKey = config.integrationEncryptionKey;
  const savedCollectorSecret = config.xCollectorSecret;
  config.xCollectorSecret = 'synthetic-collector-secret-at-least-32-characters';
  const day = new Date().toISOString().slice(0, 10);
  const priorDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const usageKey = `x:usage:${day}`;
  const priorUsageKey = `x:usage:${priorDay}`;
  const keys = ['integrations:x', 'x:last-test', 'x:poll-state', usageKey, priorUsageKey];
  const saved = await sql`SELECT key,data FROM system_settings WHERE key=ANY(${keys}::text[])`;
  const savedSource = (await sql`SELECT next_poll_at FROM data_sources WHERE id='x-search'`)[0];
  const startedAt = new Date().toISOString();
  const token = `auth_token=${randomUUID().replaceAll('-', '')}; ct0=${randomUUID().replaceAll('-', '')}`;
  const replacementToken = `auth_token=${randomUUID().replaceAll('-', '')}; ct0=${randomUUID().replaceAll('-', '')}`;
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  const request = (path: string, body?: unknown, method = 'PATCH') =>
    app.request(`/api/v1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let checks = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    checks++;
  };
  const makeDue = async () => {
    await sql`UPDATE system_settings SET data=jsonb_set(data,'{nextRequestAt}',${json(new Date(Date.now() - 1_000).toISOString())}::jsonb) WHERE key='x:poll-state'`;
  };
  async function businessCounts() {
    return (
      await sql`SELECT (SELECT count(*)::int FROM raw_items) raw,(SELECT count(*)::int FROM events) events,(SELECT count(*)::int FROM ai_analysis_runs) analyses,(SELECT count(*)::int FROM notifications) notifications,(SELECT count(*)::int FROM outbox_jobs) outbox`
    )[0]!;
  }
  try {
    await sql`DELETE FROM system_settings WHERE key=ANY(${keys}::text[])`;
    check(
      (await app.request('/api/v1/integrations/x')).status === 401,
      'X configuration is protected by session authentication',
    );
    const csrf = await app.request('/api/v1/integrations/x', {
      method: 'PATCH',
      headers: { ...headers, 'X-CSRF-Token': 'invalid' },
      body: JSON.stringify({ enabled: true }),
    });
    check(csrf.status === 403, 'X configuration writes require CSRF');
    const badOrigin = await app.request('/api/v1/integrations/x/test', {
      method: 'POST',
      headers: { ...headers, Origin: 'https://attacker.invalid' },
    });
    check(badOrigin.status === 403, 'X connection tests require the configured Origin');
    const defaultsResponse = await request('/integrations/x', undefined, 'GET');
    const defaults = (await defaultsResponse.json()).data;
    check(
      defaultsResponse.status === 200 &&
        defaults.enabled === false &&
        defaults.sessionConfigured === false &&
        defaults.configOrigin === 'default' &&
        defaults.dataMode === 'fixture' &&
        defaults.dailyRequestLimit === 96 &&
        defaults.pollIntervalMinSeconds === 600 &&
        defaults.pollIntervalMaxSeconds === 1200 &&
        defaults.scheduling.nextRequestAt === null &&
        defaults.usernames.length === 0 &&
        defaults.source.enabled === false,
      'Unconfigured X stays disabled with honest Fixture/default state',
    );
    await sql`INSERT INTO system_settings(key,data) VALUES('integrations:x',${json({ enabled: true, usernames: ['legacy'], encryptedBearerToken: 'synthetic-obsolete-official-credential' })})`;
    const legacy = await readXConfigView();
    check(
      !legacy.enabled && !legacy.sessionConfigured && !legacy.credentialError,
      'An old official credential cannot enable the collector or masquerade as a login session',
    );
    await sql`DELETE FROM system_settings WHERE key='integrations:x'`;
    await sql`INSERT INTO system_settings(key,data) VALUES('x:last-test',${json({ dataMode: 'fixture', status: 'skipped', message: 'Synthetic legacy official test', checkedAt: startedAt, httpStatus: null, returnedPosts: 0, samples: [] })})`;
    check(
      (await readXConfigView()).lastTest === null,
      'A legacy official test result is not presented as a self-hosted collector test',
    );
    await sql`DELETE FROM system_settings WHERE key='x:last-test'`;
    check(
      (await request('/integrations/x', { enabled: true })).status === 400,
      'Collection cannot be enabled without a login session and followed accounts',
    );
    for (const invalid of [
      { usernames: ['https://x.com/alice'] },
      { keywords: ['bitcoin OR from:attacker'] },
      { pollIntervalSeconds: 299 },
      { pollIntervalMinSeconds: 900, pollIntervalMaxSeconds: 600 },
      { pollIntervalMinSeconds: 600.5 },
      { pollIntervalMaxSeconds: 86401 },
      { pollIntervalSeconds: 600, pollIntervalMinSeconds: 600 },
      { maxResults: 101 },
      { dailyRequestLimit: 501 },
      { candidateMinAuthors: 1 },
      { sessionCookies: 'auth_token=line\nbreak; ct0=synthetic' },
      { sessionCookies: 'auth_token=synthetic' },
      { sessionCookies: 'auth_token=synthetic; ct0=synthetic; extra=value' },
      { sessionCookies: 'auth_token=first; auth_token=second; ct0=synthetic' },
    ])
      check(
        (await request('/integrations/x', invalid)).status === 400,
        'Invalid X scope, pacing, quota, or credential fields are rejected',
      );
    const oversizedQuery = {
      usernames: Array.from({ length: 20 }, (_, index) => `user${String(index).padStart(11, '0')}`),
      keywords: Array.from({ length: 10 }, (_, index) => `topic${String(index).padStart(35, '0')}`),
    };
    check(
      (await request('/integrations/x', oversizedQuery)).status === 400,
      'A query longer than the 512-character query bound cannot be saved',
    );
    const savedResponse = await request('/integrations/x', {
      enabled: false,
      sessionCookies: token,
      usernames: ['@Alice', 'ALICE', 'bob'],
      keywords: ['Bitcoin', '$ETH'],
      pollIntervalMinSeconds: 600,
      pollIntervalMaxSeconds: 1200,
      maxResults: 20,
      dailyRequestLimit: 3,
      candidateMinAuthors: 2,
      candidateWindowMinutes: 30,
    });
    const savedView = (await savedResponse.json()).data;
    check(
      savedResponse.status === 200 &&
        savedView.sessionConfigured &&
        savedView.collectorConfigured &&
        savedView.configOrigin === 'database' &&
        JSON.stringify(savedView.usernames) === JSON.stringify(['alice', 'bob']) &&
        savedView.query.includes('from:alice') &&
        savedView.query.includes('from:bob'),
      'X configuration persists normalized accounts and a server-built query',
    );
    check(
      !JSON.stringify(savedView).includes(token) &&
        !JSON.stringify(savedView).includes(config.xCollectorSecret) &&
        !('sessionCookies' in savedView) &&
        !('collectorUrl' in savedView),
      'X configuration responses never echo the login session or server collector credentials',
    );
    const stored = (await sql`SELECT data FROM system_settings WHERE key='integrations:x'`)[0]!;
    check(
      !JSON.stringify(stored.data).includes(token) &&
        (await readXConfig()).sessionCookies === token,
      'X login session is encrypted at rest and recoverable only by the server',
    );
    const partialResponse = await request('/integrations/x', { pollIntervalMinSeconds: 900 });
    const partial = (await partialResponse.json()).data;
    check(
      partialResponse.status === 200 &&
        partial.pollIntervalSeconds === 900 &&
        partial.pollIntervalMinSeconds === 900 &&
        partial.pollIntervalMaxSeconds === 1200 &&
        partial.dailyRequestLimit === 3 &&
        partial.maxResults === 20 &&
        partial.candidateMinAuthors === 2 &&
        partial.candidateWindowMinutes === 30 &&
        JSON.stringify(partial.usernames) === JSON.stringify(['alice', 'bob']) &&
        (await readXConfig()).sessionCookies === token,
      'A partial X PATCH preserves omitted scope, quota, candidate, and credential settings',
    );
    check(
      (await request('/integrations/x', { enabled: true })).status === 200,
      'Complete X configuration can be enabled without contacting X during save',
    );
    const beforeDebug = await businessCounts();
    const fixtureTestResponse = await request('/integrations/x/test', undefined, 'POST');
    const fixtureTest = (await fixtureTestResponse.json()).data;
    check(
      fixtureTestResponse.status === 200 &&
        fixtureTest.status === 'skipped' &&
        fixtureTest.httpStatus === null &&
        fixtureTest.returnedPosts === 0 &&
        fixtureTest.samples.length === 0 &&
        (await readXConfigView()).usage.requests === 0,
      'Fixture connection tests skip X requests and consume no external request quota',
    );
    check(
      (await readXConfigView()).lastTest?.status === 'skipped',
      'The last connection-test result survives a fresh configuration read',
    );
    check(
      (await request('/integrations/x', { sessionCookies: token, clearSessionCookies: true }))
        .status === 400,
      'Setting and clearing a login session in the same write is rejected',
    );
    const firstClear = await request('/integrations/x', { clearSessionCookies: true });
    const firstCleared = (await firstClear.json()).data;
    check(
      firstClear.status === 200 &&
        !firstCleared.enabled &&
        !firstCleared.sessionConfigured &&
        (await readXConfig()).sessionCookies === '',
      'Clearing a login session atomically disables automatic collection',
    );
    check(
      (await request('/integrations/x', { enabled: true, sessionCookies: token })).status === 200,
      'A new session can be saved and enabled after a clear',
    );

    config.dataMode = 'live';
    config.xCollectorSecret = '';
    check(
      !(await readXConfigView()).collectorConfigured,
      'A missing server collector secret is reported as unconfigured',
    );
    await assert.rejects(() => reserveXRequest());
    checks++;
    config.xCollectorSecret = 'synthetic-collector-secret-at-least-32-characters';
    const effective = await readXConfig();
    const quota = await Promise.allSettled(
      Array.from({ length: 5 }, () => reserveXRequest(effective)),
    );
    check(
      quota.filter((result) => result.status === 'fulfilled').length === 1 &&
        quota.filter(
          (result) =>
            result.status === 'rejected' && result.reason instanceof XRequestDeferredError,
        ).length === 4 &&
        (await readXConfigView()).usage.requests === 1,
      'Concurrent replicas share one durable interval slot and deferred work consumes no quota',
    );
    await sql`UPDATE system_settings SET data=${json({ day, requests: 2 })} WHERE key=${usageKey}`;
    await makeDue();
    check(
      (await reserveXRequest(effective)) === 3,
      'An elapsed synthetic interval can reserve the final daily slot',
    );
    check(
      (await readXConfigView()).usage.requests === 3 &&
        (await readXConfigView()).usage.remaining === 0,
      'Persisted X usage reports the local workload cap without implying API fees',
    );
    const exhaustedResponse = await request('/integrations/x/test', undefined, 'POST');
    const exhausted = (await exhaustedResponse.json()).data;
    check(
      exhaustedResponse.status === 200 &&
        exhausted.status === 'failed' &&
        exhausted.httpStatus === null &&
        exhausted.returnedPosts === 0 &&
        exhausted.samples.length === 0 &&
        (await readXConfigView()).usage.requests === 3,
      'A quota-exhausted live test fails before the external request without inventing HTTP success',
    );
    assert.deepEqual(await businessCounts(), beforeDebug);
    checks++;
    await saveXConfig({ sessionCookies: replacementToken });
    await assert.rejects(() => reserveXRequest(effective));
    checks++;
    check(
      (await readXConfigView()).usage.requests === 3,
      'Stale in-memory credentials cannot consume quota after configuration changes',
    );
    await saveXConfig({ enabled: false, dailyRequestLimit: 5 });
    const disabled = await readXConfig();
    await assert.rejects(() => reserveXRequest(disabled));
    checks++;
    await makeDue();
    check(
      (await reserveXRequest(disabled, { requireEnabled: false })) === 4,
      'An explicitly requested debug test may reserve quota while automatic collection is disabled',
    );
    await sql`INSERT INTO system_settings(key,data) VALUES(${priorUsageKey},${json({ day: priorDay, requests: 500 })}) ON CONFLICT(key) DO UPDATE SET data=excluded.data`;
    await sql`DELETE FROM system_settings WHERE key=${usageKey}`;
    await makeDue();
    check(
      (await reserveXRequest(disabled, { requireEnabled: false })) === 1 &&
        (await readXConfigView()).usage.day === day &&
        (await readXConfigView()).usage.requests === 1,
      'The current UTC day starts its own request counter instead of consuming the prior day quota',
    );
    await saveXConfig({ dailyRequestLimit: 0 });
    await assert.rejects(() => reserveXRequest(undefined, { requireEnabled: false }));
    checks++;
    check(
      (await readXConfigView()).usage.requests === 1,
      'A zero daily request limit blocks new reservations without changing usage',
    );
    config.dataMode = 'fixture';
    await assert.rejects(() => reserveXRequest(undefined, { requireEnabled: false }));
    checks++;
    config.integrationEncryptionKey = `synthetic-wrong-key-${randomUUID()}`;
    const brokenResponse = await request('/integrations/x', undefined, 'GET');
    const broken = (await brokenResponse.json()).data;
    check(
      brokenResponse.status === 200 &&
        broken.credentialError === true &&
        broken.sessionConfigured === true &&
        !JSON.stringify(broken).includes(replacementToken),
      'Lost encryption credentials produce an honest non-secret configuration error state',
    );
    config.integrationEncryptionKey = savedEncryptionKey;
    const clearResponse = await request('/integrations/x', {
      enabled: false,
      clearSessionCookies: true,
    });
    const cleared = (await clearResponse.json()).data;
    check(
      clearResponse.status === 200 &&
        cleared.sessionConfigured === false &&
        (await readXConfig()).sessionCookies === '',
      'An explicit login session clear removes the server credential after disabling collection',
    );
    const audits =
      await sql`SELECT details FROM audit_logs WHERE entity_type='x_integration' AND created_at>=${startedAt}::timestamptz`;
    check(
      audits.length > 0 &&
        !JSON.stringify(audits).includes(token) &&
        !JSON.stringify(audits).includes(replacementToken),
      'X configuration and debug audit records never contain credential values',
    );
    console.log(`X management integration: ${checks} checks passed`);
    return checks;
  } finally {
    config.dataMode = savedMode;
    config.integrationEncryptionKey = savedEncryptionKey;
    config.xCollectorSecret = savedCollectorSecret;
    await sql.begin(async (tx) => {
      await tx`DELETE FROM system_settings WHERE key=ANY(${keys}::text[])`;
      for (const row of saved)
        await tx`INSERT INTO system_settings(key,data) VALUES(${String(row.key)},${json(row.data)})`;
      if (savedSource)
        await tx`UPDATE data_sources SET next_poll_at=${savedSource.next_poll_at ? new Date(savedSource.next_poll_at as string).toISOString() : null} WHERE id='x-search'`;
    });
  }
}
