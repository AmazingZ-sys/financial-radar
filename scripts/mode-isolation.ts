import { createHash, randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { sql, ensureAdmin, closeDatabase } from '../packages/database/src/index.js';
import { config } from '../packages/config/src/index.js';
import { createApp } from '../apps/api/src/app.js';
import { redis } from '../apps/api/src/security.js';
import { EventSchema, ProjectSchema, RuleSchema } from '../packages/shared/src/index.js';
export async function verifyModeIsolation() {
  const ownerId = await ensureAdmin();
  const originalMode = config.dataMode;
  const now = new Date().toISOString();
  const group = 'mode-audit-' + randomUUID();
  const asset = group;
  const sessionId = randomUUID();
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const ruleId = randomUUID();
  const fixtures: {
    mode: 'fixture' | 'live';
    sourceId: string;
    eventId: string;
    projectId: string;
    notificationId: string;
    aiId: string;
    rawId: string;
    triggerId: string;
    signalId: string;
  }[] = [];
  const channel = (
    await sql<
      { id: string }[]
    >`SELECT id FROM notification_channels WHERE owner_id=${ownerId} AND provider='telegram'`
  )[0]!.id;
  const app = createApp();
  const usageBefore = (
    await sql`SELECT (SELECT count(*) FROM ai_analysis_runs WHERE provider='fixture' AND created_at>=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS fixture,(SELECT count(*) FROM ai_analysis_runs r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.data->'reservations','[]'::jsonb)) AS reservation WHERE r.provider<>'fixture' AND (reservation->>'at')::timestamptz>=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS live`
  )[0]!;
  let assertions = 0;
  async function request(path: string, method = 'GET', body?: unknown) {
    return app.request('/api/v1' + path, {
      method,
      headers: {
        Cookie: `radar_session=${token}`,
        Origin: config.webOrigin,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function get(path: string) {
    const r = await request(path);
    assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
    assertions++;
    return (await r.json()) as {
      data: Record<string, unknown> | Record<string, unknown>[];
      meta?: { total: number };
    };
  }
  try {
    await sql`INSERT INTO user_sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES(${sessionId},${ownerId},${createHash('sha256').update(token).digest('hex')},${csrf},now()+interval '10 minutes')`;
    const rule = RuleSchema.parse({
      id: ruleId,
      ownerId,
      name: group,
      enabled: true,
      conditions: {},
      priority: 'P1',
      cooldownSeconds: 60,
      channelIds: [channel],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await sql`INSERT INTO alert_rules(id,owner_id,name,data) VALUES(${ruleId},${ownerId},${group},${sql.json(rule)})`;
    for (const mode of ['fixture', 'live'] as const) {
      const row = {
        mode,
        sourceId: group + '-' + mode,
        eventId: randomUUID(),
        projectId: randomUUID(),
        notificationId: randomUUID(),
        aiId: randomUUID(),
        rawId: randomUUID(),
        triggerId: randomUUID(),
        signalId: randomUUID(),
      };
      fixtures.push(row);
      await sql`INSERT INTO data_sources(id,name,mode,data) VALUES(${row.sourceId},${group},${mode},'{}')`;
      await sql`INSERT INTO raw_items(id,source_id,external_id,payload,first_seen_at,collected_at) VALUES(${row.rawId},${row.sourceId},'one','{}',${now},${now})`;
      const event = EventSchema.parse({
        id: row.eventId,
        eventType: 'NEW_TOKEN_DEPLOYED',
        sourceId: row.sourceId,
        externalId: 'one',
        title: group,
        description: 'Isolated mode audit',
        originalUrl: 'https://example.invalid/audit',
        sourcePublishedAt: now,
        firstSeenAt: now,
        collectedAt: now,
        eventOccurredAt: now,
        assets: [asset],
        categories: ['test'],
        rawDataReference: row.rawId,
        fingerprint: group + '-' + mode,
        confidence: 0.9,
        severity: 'P1',
        verificationStatus: 'UNVERIFIED',
        analysisStatus: 'DISABLED',
        opportunityScore: 50,
        riskScore: 70,
        dataMode: mode,
        createdAt: now,
        updatedAt: now,
      });
      await sql`INSERT INTO events(id,fingerprint,source_id,external_id,title,event_type,severity,first_seen_at,data) VALUES(${row.eventId},${event.fingerprint},${row.sourceId},'one',${group},'NEW_TOKEN_DEPLOYED','P1',${now},${sql.json(event as unknown as Parameters<typeof sql.json>[0])})`;
      const project = ProjectSchema.parse({
        id: row.projectId,
        name: group,
        chain: 'bitcoin',
        protocol: 'audit',
        assetKey: group + '-' + mode,
        stage: 'UNVERIFIED',
        verificationStatus: 'UNVERIFIED',
        riskFlagged: true,
        watching: true,
        firstSeenAt: now,
        opportunityScore: 50,
        riskScore: 70,
        participants: null,
        participantGrowthPct: null,
        mintProgress: null,
        conditions: null,
        sourceUrls: [],
        dataMode: mode,
      });
      await sql`INSERT INTO projects(id,asset_key,stage,chain,first_seen_at,data) VALUES(${row.projectId},${project.assetKey},'UNVERIFIED','bitcoin',${now},${sql.json(project as unknown as Parameters<typeof sql.json>[0])})`;
      await sql`INSERT INTO market_observations(id,asset_key,source_id,observed_at,value,unit,data) VALUES(${randomUUID()},${asset},${row.sourceId},${now},${mode === 'fixture' ? '111' : '222'},'USD',${sql.json({ dataMode: mode })})`;
      await sql`INSERT INTO notifications(id,dedup_key,channel_id,event_id,status,data) VALUES(${row.notificationId},${row.notificationId},${channel},${row.eventId},'FAILED',${sql.json({ title: group, body: 'Mode isolation audit', priority: 'P1', dataMode: mode })})`;
      await sql`INSERT INTO alert_triggers(id,rule_id,rule_version,event_id,dedup_key,data) VALUES(${row.triggerId},${ruleId},1,${row.eventId},${row.triggerId},${sql.json({ priority: 'P1' })})`;
      await sql`INSERT INTO ai_analysis_runs(id,event_id,status,provider,model,prompt_version,cache_key,estimated_cost,data) VALUES(${row.aiId},${row.eventId},'COMPLETED',${mode === 'fixture' ? 'fixture' : 'mode-isolation-test'},'audit','audit',${row.aiId},0,${sql.json(
        {
          reservations: [
            { at: now, cost: 0 },
            { at: now, cost: 0 },
          ],
        },
      )})`;
    }
    for (const current of fixtures) {
      config.dataMode = current.mode;
      const other = fixtures.find((f) => f.mode !== current.mode)!;
      const events = await get('/events?q=' + group);
      assert.equal(events.meta?.total, 1);
      assert.deepEqual(
        (events.data as Record<string, unknown>[]).map((e) => e.id),
        [current.eventId],
      );
      assertions += 2;
      assert.equal((await request('/events/' + other.eventId)).status, 404);
      assert.equal((await request('/events/' + other.eventId + '/sources')).status, 404);
      assertions += 2;
      const projects = await get('/projects?q=' + group);
      assert.equal(projects.meta?.total, 1);
      assert.deepEqual(
        (projects.data as Record<string, unknown>[]).map((e) => e.id),
        [current.projectId],
      );
      assertions += 2;
      for (const suffix of ['', '/timeline', '/signals', '/metrics']) {
        assert.equal((await request('/projects/' + other.projectId + suffix)).status, 404);
        assertions++;
      }
      assert.equal(
        (
          await request('/events/' + other.eventId + '/review', 'POST', {
            status: 'APPROVED',
            note: 'Cross-mode review must be rejected before changing evidence',
          })
        ).status,
        404,
      );
      assertions++;
      const digest = (await get('/digests/daily?day=' + now.slice(0, 10))).data as {
        items: { eventId: string }[];
      };
      assert(digest.items.some((e) => e.eventId === current.eventId));
      assert(!digest.items.some((e) => e.eventId === other.eventId));
      assertions += 2;
      const sourceList = (await get('/sources')).data as Record<string, unknown>[];
      assert(sourceList.some((s) => s.id === current.sourceId));
      assert(!sourceList.some((s) => s.id === other.sourceId));
      assertions += 2;
      assert.equal((await request('/sources/' + other.sourceId + '/health')).status, 404);
      assert.equal(
        (await request('/sources/' + other.sourceId, 'PATCH', { enabled: true })).status,
        404,
      );
      assertions += 2;
      const markets = (await get('/markets/assets')).data as Record<string, unknown>[];
      const market = markets.find((m) => m.asset === asset)!;
      assert.equal(market.dataMode, current.mode);
      assert.equal(market.value, current.mode === 'fixture' ? 111 : 222);
      assertions += 2;
      const history = (await get('/markets/history?asset=' + asset)).data as Record<
        string,
        unknown
      >[];
      assert.equal(history.length, 1);
      assert.equal(history[0]!.dataMode, current.mode);
      assertions += 2;
      const alerts = (await get('/alerts?pageSize=100')).data as Record<string, unknown>[];
      assert(alerts.some((a) => a.id === current.triggerId));
      assert(!alerts.some((a) => a.id === other.triggerId));
      assertions += 2;
      const notices = (await get('/notifications?pageSize=100')).data as Record<string, unknown>[];
      assert(notices.some((n) => n.id === current.notificationId));
      assert(!notices.some((n) => n.id === other.notificationId));
      assertions += 2;
      assert.equal(
        (await request('/notifications/' + other.notificationId + '/retry', 'POST')).status,
        409,
      );
      assert.equal(
        (await request('/alert-rules/test', 'POST', { eventId: other.eventId, conditions: {} }))
          .status,
        404,
      );
      assertions += 2;
      const replayResponse = await request('/replay', 'POST', {
        at: new Date(Date.now() + 60000).toISOString(),
        conditions: {},
      });
      assert.equal(replayResponse.status, 200);
      const replayBody = (await replayResponse.json()) as {
        data: { results: { evidenceId: string }[] };
      };
      assert(replayBody.data.results.some((x) => x.evidenceId === current.eventId));
      assert(!replayBody.data.results.some((x) => x.evidenceId === other.eventId));
      assertions += 3;
      const dashboard = (await get('/dashboard')).data as Record<string, unknown>;
      const expected =
        await sql`SELECT count(*) n FROM events WHERE data->>'dataMode'=${current.mode} AND first_seen_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
      assert.equal(dashboard.eventsToday, Number(expected[0]!.n));
      assert(
        (dashboard.recentEvents as Record<string, unknown>[]).every(
          (e) => e.dataMode === current.mode,
        ),
      );
      assertions += 2;
      const system = (await get('/system/status')).data as { ai: { usage: { calls: number } } };
      // Fixture counts synthetic runs; live counts attempts, including retries in one run.
      assert.equal(
        system.ai.usage.calls,
        Number(usageBefore[current.mode]) + (current.mode === 'fixture' ? 1 : 2),
      );
      assertions++;
    }
    return { assertions, modes: 2, retainedFacts: true };
  } finally {
    config.dataMode = originalMode;
    for (const f of fixtures) {
      await sql`DELETE FROM audit_logs WHERE entity_id=${f.notificationId} OR entity_id=${f.sourceId} OR entity_id=${f.eventId}`;
      await sql`DELETE FROM ai_analysis_runs WHERE id=${f.aiId}`;
      await sql`DELETE FROM alert_triggers WHERE id=${f.triggerId}`;
      await sql`DELETE FROM notifications WHERE id=${f.notificationId}`;
      await sql`DELETE FROM projects WHERE id=${f.projectId}`;
      await sql`DELETE FROM events WHERE id=${f.eventId}`;
      await sql`DELETE FROM market_observations WHERE source_id=${f.sourceId}`;
      await sql`DELETE FROM raw_items WHERE id=${f.rawId}`;
      await sql`DELETE FROM data_sources WHERE id=${f.sourceId}`;
    }
    await sql`DELETE FROM alert_rules WHERE id=${ruleId}`;
    await sql`DELETE FROM user_sessions WHERE id=${sessionId}`;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.info('Mode isolation verified:', await verifyModeIsolation());
  } finally {
    redis.disconnect();
    await closeDatabase();
  }
}
