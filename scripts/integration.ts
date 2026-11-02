import { verifyModeIsolation } from './mode-isolation.js';
import { verifyHistoricalPipeline } from './history-integration.js';
import { initializeCalendarFixtures } from '../apps/api/src/calendar-routes.js';
import assert from 'node:assert/strict';
import { config } from '../packages/config/src/index.js';
import { sql, closeDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { initializeSources, registry, runIngestion } from '../apps/worker/src/pipeline.js';
import {
  runOutboxOnce,
  recoverLeases,
  heartbeat,
  sendNotification,
} from '../apps/worker/src/jobs.js';
import { createApp } from '../apps/api/src/app.js';
import { redis } from '../apps/api/src/security.js';
import { randomUUID } from 'node:crypto';
if (config.nodeEnv === 'production' || config.dataMode !== 'fixture')
  throw new Error('Integration suite requires a non-production Fixture database');
const app = createApp();
let checks = 0;
function check(condition: unknown, message: string) {
  assert.ok(condition, message);
  checks++;
}
async function counts() {
  const rows =
    await sql`SELECT (SELECT count(*)::int FROM raw_items) raw,(SELECT count(*)::int FROM events) events,(SELECT count(*)::int FROM projects) projects,(SELECT count(*)::int FROM opportunity_signals) signals,(SELECT count(*)::int FROM notifications) notifications`;
  return rows[0]!;
}
try {
  await migrate();
  await migrate();
  await initializeCalendarFixtures();
  check(
    (await sql`SELECT count(*)::int n FROM _radar_migrations`)[0]!.n >= 1,
    'Migration ledger is repeatable',
  );
  await initializeSources();
  for (const connector of registry.list()) await runIngestion(connector.metadata.id);
  const before = await counts();
  check(
    Number(before.events) >= 5 && Number(before.projects) >= 4,
    'Fixture passed through actual PostgreSQL pipeline',
  );
  // Replay the same external items, rather than relying on a completed cursor to return nothing.
  await sql`UPDATE source_checkpoints SET cursor='{}'::jsonb WHERE source_id='chain-fixture'`;
  await runIngestion('chain-fixture');
  const after = await counts();
  assert.deepEqual(
    after,
    before,
    'Raw items/events/signals/projects/notifications remain idempotent',
  );
  checks++;
  await runOutboxOnce();
  const realSent =
    await sql`SELECT id FROM notifications WHERE data->>'dataMode'='fixture' AND status='SENT'`;
  check(realSent.length === 0, 'Fixture never sends a real platform message');
  const analyses = await sql`SELECT id FROM events WHERE data->>'analysisStatus'='COMPLETED'`;
  check(analyses.length >= 1, 'Structured Fixture AI persisted with evidence');
  await heartbeat({ waiting: 0, active: 0, failed: 0, delayed: 0 });
  const unauthorized = await app.request('/api/v1/events');
  check(unauthorized.status === 401, 'Business routes require authentication');
  const login = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: config.webOrigin },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  check(login.status === 200, 'Administrator can sign in');
  const signedIn = (await login.json()) as { data: { csrfToken: string } };
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  check(cookie?.startsWith('radar_session='), 'Session uses an HttpOnly cookie');
  check(login.headers.get('set-cookie')?.includes('HttpOnly'), 'Cookie is HttpOnly');
  const headers = {
    Cookie: cookie!,
    Origin: config.webOrigin,
    'Content-Type': 'application/json',
    'X-CSRF-Token': signedIn.data.csrfToken,
  };
  const badCsrf = await app.request('/api/v1/alert-rules', {
    method: 'POST',
    headers: { ...headers, 'X-CSRF-Token': 'bad' },
    body: JSON.stringify({ name: 'must reject', conditions: {} }),
  });
  check(badCsrf.status === 403, 'Write requests reject an invalid CSRF token');
  const badOrigin = await app.request('/api/v1/alert-rules', {
    method: 'POST',
    headers: { ...headers, Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ name: 'must reject', conditions: {} }),
  });
  check(badOrigin.status === 403, 'Write requests reject an invalid Origin');
  const list = await app.request('/api/v1/events?pageSize=2', { headers });
  const listed = (await list.json()) as { data: { id: string }[]; meta: { total: number } };
  check(
    list.status === 200 && listed.data.length === 2 && listed.meta.total >= 5,
    'Pagination is validated and backed by stored events',
  );
  for (const path of [
    '/calendar',
    '/digests/daily',
    '/system/scoring',
    '/system/latency',
    '/dashboard',
    '/projects',
    '/sources',
    '/markets/assets',
    '/notification-channels',
    '/notifications',
    '/system/status',
    '/system/logs',
    '/settings',
    '/watchlists',
  ]) {
    const result = await app.request(`/api/v1${path}`, { headers });
    check(result.status === 200, `${path} returns a validated response`);
    const text = await result.text();
    check(
      !text.includes(config.sessionSecret) && !text.includes(config.adminPassword),
      `${path} does not leak server secrets`,
    );
  }
  const eventId = listed.data[0]!.id;
  const priorFact = (await sql`SELECT data FROM events WHERE id=${eventId}`)[0]!.data;
  const reviewed = await app.request(`/api/v1/events/${eventId}/review`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: 'APPROVED', note: 'Integration evidence review' }),
  });
  check(reviewed.status === 200, 'Human review persists without changing source verification');
  const afterReview = (await sql`SELECT data FROM events WHERE id=${eventId}`)[0]!.data;
  check(
    afterReview.verificationStatus === priorFact.verificationStatus &&
      afterReview.fingerprint === priorFact.fingerprint &&
      JSON.stringify(afterReview.metrics) === JSON.stringify(priorFact.metrics),
    'AI review preserves original signal evidence and factual verification',
  );
  const invalidCalendar = await app.request(
    '/api/v1/calendar?from=2026-11-04T00:00:00Z&to=2026-11-03T00:00:00Z',
    { headers },
  );
  check(invalidCalendar.status === 400, 'Calendar rejects reversed time ranges');
  const calendar = (await (await app.request('/api/v1/calendar', { headers })).json()) as {
    data: {
      expectedValue: string | null;
      actualValue: string | null;
      confirmed: boolean;
      dataMode: string;
    }[];
  };
  check(
    calendar.data.length >= 3 &&
      calendar.data.every(
        (x) =>
          x.expectedValue === null &&
          x.actualValue === null &&
          x.confirmed === false &&
          x.dataMode === 'fixture',
      ),
    'Calendar keeps unsupported forecasts unknown and fixtures explicit',
  );
  for (const suffix of ['', '/sources'])
    check(
      (await app.request(`/api/v1/events/${eventId}${suffix}`, { headers })).status === 200,
      'Event detail/evidence resolves',
    );
  const created = await app.request('/api/v1/alert-rules', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Integration rule ' + randomUUID(),
      conditions: { minConfidence: 0.5 },
      priority: 'P2',
      cooldownSeconds: 60,
      channelIds: [],
    }),
  });
  const rule = (await created.json()) as { data: { id: string; version: number } };
  check(created.status === 200 && !!rule.data.id, 'Rule creation persists');
  const ruleId = rule.data.id;
  const tested = await app.request('/api/v1/alert-rules/test', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ruleId, eventId }),
  });
  check(
    tested.status === 200 && ((await tested.json()) as { data: { matched: boolean } }).data.matched,
    'Rule test uses a stored event without sending',
  );
  const patched = await app.request(`/api/v1/alert-rules/${ruleId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ enabled: false }),
  });
  check(
    patched.status === 200 &&
      ((await patched.json()) as { data: { version: number } }).data.version === 2,
    'Rule update saves a version',
  );
  check(
    (await app.request(`/api/v1/alert-rules/${ruleId}`, { method: 'DELETE', headers })).status ===
      200,
    'Rule soft delete preserves history',
  );
  check(
    (await sql`SELECT id FROM alert_rule_versions WHERE rule_id=${ruleId}`).length === 3,
    'All rule versions are retained',
  );
  const invalid = await app.request('/api/v1/alert-rules', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Unsafe', conditions: { expression: 'process.exit()' } }),
  });
  check(invalid.status === 400, 'Rules reject executable expressions');
  const replay = await app.request('/api/v1/replay', {
    method: 'POST',
    headers,
    body: JSON.stringify({ at: '2000-01-01T00:00:00.000Z', conditions: {} }),
  });
  const replayBody = (await replay.json()) as {
    data: { results: unknown[]; excludedFutureEvidence: number };
  };
  check(
    replay.status === 200 &&
      replayBody.data.results.length === 0 &&
      replayBody.data.excludedFutureEvidence >= 5,
    'Historical replay excludes future evidence',
  );
  const channels = await sql`SELECT id FROM notification_channels LIMIT 1`;
  check(channels.length === 1, 'Default channel is persistent');
  const notificationId = randomUUID();
  await sql`INSERT INTO notifications(id,dedup_key,channel_id,status,locked_until,data) VALUES(${notificationId},${'integration:' + notificationId},${String(channels[0]!.id)},'SENDING',now()-interval '1 minute',${sql.json({ id: notificationId, title: 'Fixture lease recovery', description: 'Synthetic integration only', dataMode: 'fixture', priority: 'P2', channelId: String(channels[0]!.id), eventId: null })})`;
  await recoverLeases();
  await sendNotification(notificationId);
  check(
    (await sql`SELECT status FROM notifications WHERE id=${notificationId}`)[0]!.status ===
      'CANCELLED',
    'Expired notification lease recovers and Fixture remains simulated',
  );
  await sendNotification(notificationId);
  check(
    (
      await sql`SELECT count(*)::int n FROM notification_attempts WHERE notification_id=${notificationId}`
    )[0]!.n === 1,
    'Repeated notification job cannot resend a terminal state',
  );
  const fixtureMode = config.dataMode;
  try {
    config.dataMode = 'live';
    const liveEvents = (await (await app.request('/api/v1/events', { headers })).json()) as {
      data: { dataMode: string }[];
    };
    check(
      liveEvents.data.every((item) => item.dataMode === 'live'),
      'Live event reads exclude retained Fixture facts',
    );
    const liveProjects = (await (await app.request('/api/v1/projects', { headers })).json()) as {
      data: { dataMode: string }[];
    };
    check(
      liveProjects.data.every((item) => item.dataMode === 'live'),
      'Live project reads exclude retained Fixture projects',
    );
    check(
      (await app.request(`/api/v1/events/${eventId}`, { headers })).status === 404,
      'A Fixture event cannot leak by direct id in Live mode',
    );
    const liveNotices = (await (
      await app.request('/api/v1/notifications', { headers })
    ).json()) as { data: { dataMode: string }[] };
    check(
      liveNotices.data.every((item) => item.dataMode === 'live'),
      'Live notification history excludes simulated attempts',
    );
  } finally {
    config.dataMode = fixtureMode;
  }
  check((await app.request('/ready')).status === 200, 'Readiness checks real PostgreSQL and Redis');
  check(
    (await app.request('/openapi.json')).status === 200,
    'OpenAPI is produced by actual registered routes',
  );
  const historical = await verifyHistoricalPipeline(async ({ projectId, signalEventIds }) => {
    const signalsResponse = await app.request(`/api/v1/projects/${projectId}/signals`, {
      headers,
    });
    const signals = (await signalsResponse.json()) as {
      data: { type: string; eventId: string | null; evidenceIds: string[] }[];
    };
    check(
      signalsResponse.status === 200 &&
        signals.data.some((s) => s.type === 'PARTICIPATION_WINDOW_EXPIRED') &&
        signals.data.every((s) => s.eventId && s.evidenceIds.length > 0),
      'Historical and clock signals resolve through the authenticated project API',
    );
    const metrics = await app.request(`/api/v1/projects/${projectId}/metrics`, { headers });
    check(
      metrics.status === 200 && ((await metrics.json()) as { data: unknown[] }).data.length >= 3,
      'Historical metric observations resolve through the real API',
    );
    const signalEventId = signalEventIds[0]!;
    for (const path of [`/events/${signalEventId}`, `/events/${signalEventId}/sources`])
      check(
        (await app.request(`/api/v1${path}`, { headers })).status === 200,
        'Derived events retain accessible source evidence',
      );
    const modeBefore = config.dataMode;
    try {
      config.dataMode = 'live';
      for (const path of [
        `/projects/${projectId}/signals`,
        `/projects/${projectId}/metrics`,
        `/events/${signalEventId}`,
      ])
        check(
          (await app.request(`/api/v1${path}`, { headers })).status === 404,
          'Historical Fixture evidence remains isolated from live reads',
        );
    } finally {
      config.dataMode = modeBefore;
    }
  });
  console.log(`Historical pipeline passed: ${historical.checks} PostgreSQL checks.`);
  await app.request('/api/v1/auth/logout', { method: 'POST', headers });
  check(
    (await app.request('/api/v1/auth/me', { headers })).status === 401,
    'Logout invalidates the stored session',
  );
  const isolation = await verifyModeIsolation();
  console.log(
    `Mode isolation passed: ${isolation.assertions} assertions across ${isolation.modes} modes.`,
  );
  console.log(
    `Integration passed: ${checks} checks; actual PostgreSQL + Redis, no external platform sends.`,
  );
} finally {
  await registry.shutdown();
  redis.disconnect();
  await closeDatabase();
}
