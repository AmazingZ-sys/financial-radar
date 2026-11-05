import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { sql, readAIConfig, readNotificationConfig } from '@radar/database';
import { config, fetchPublicHttps, fetchPublicHttpsStream } from '@radar/config';
import { analysisDecision, skipAnalysis } from './analysis-admission.js';
import {
  ANALYSIS_POLICY_VERSION,
  analysisCooldownKey,
  evaluateAnalysisCandidate,
  truncateAnalysisEvidence,
} from './analysis-policy.js';
import { createLogger } from '@radar/observability';
import {
  TelegramProvider,
  FeishuProvider,
  BarkProvider,
  EmailProvider,
  type NotificationMessage,
  type SendResult,
} from '@radar/notifications';
import {
  CompatibleAIProvider,
  FixtureAIProvider,
  analysisCacheKey,
  compatibleAIProviderIdentity,
  PROMPT_VERSION,
  type AnalysisInput,
  type AIProvider,
} from '@radar/ai';
import { evaluateNotificationAdmission, evaluateRule, type RuleEvent } from '@radar/signals';
import { RuleSchema } from '@radar/shared';
const json = (value: unknown) => sql.json(value as postgres.JSONValue);
const log = createLogger('worker.jobs');
const secureFetch: typeof fetch = (input, init) => fetchPublicHttps(String(input), init);
const secureStreamFetch: typeof fetch = (input, init) =>
  fetchPublicHttpsStream(String(input), init);
function safeError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 250)
    : '未知任务错误';
}
/** Recheck durable automatic work against today's policy and current rule before any provider. */
async function notificationRejection(
  eventId: string | null,
  payload: Record<string, unknown>,
  channelId: string,
): Promise<string[]> {
  if (!eventId) return [];
  const stored = (await sql`SELECT data FROM events WHERE id=${eventId}`)[0]?.data as
    Record<string, unknown> | undefined;
  if (!stored) return ['通知对应的持久化事件不存在'];
  if (stored.dataMode !== config.dataMode || stored.dataMode !== payload.dataMode)
    return ['通知与持久化事件的数据模式不一致'];
  const event = stored as unknown as RuleEvent;
  let admission: ReturnType<typeof evaluateNotificationAdmission>;
  try {
    admission = evaluateNotificationAdmission(event);
  } catch {
    return ['持久化事件无法通过通知准入校验'];
  }
  if (!admission.matched) return admission.reasons;
  // Legacy notifications without a trigger still pass the mandatory opportunity gate.
  if (payload.triggerId === undefined || payload.triggerId === null) return [];
  if (
    typeof payload.triggerId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.triggerId)
  )
    return ['通知的规则触发标识无效'];
  const current = (
    await sql`SELECT r.enabled,r.data FROM alert_triggers t LEFT JOIN alert_rules r ON r.id=t.rule_id WHERE t.id=${payload.triggerId} AND t.event_id=${eventId}`
  )[0];
  if (!current?.enabled) return ['通知规则已停用或不存在'];
  const parsed = RuleSchema.safeParse(current.data);
  if (!parsed.success) return ['通知规则当前配置无效'];
  if (!parsed.data.enabled) return ['通知规则已停用'];
  if (!parsed.data.channelIds.includes(channelId)) return ['当前通知规则已移除此渠道'];
  try {
    const result = evaluateRule(parsed.data.conditions, event);
    return result.matched ? [] : result.reasons;
  } catch {
    return ['持久化事件或当前通知规则无法通过校验'];
  }
}
export async function sendNotification(id: string) {
  const leased =
    await sql`UPDATE notifications SET status='SENDING',attempts=attempts+1,locked_until=now()+interval '60 seconds' WHERE id=${id} AND next_attempt_at<=now() AND (status IN ('PENDING','RETRYING') OR (status='SENDING' AND locked_until<now())) RETURNING *`;
  const row = leased[0];
  if (!row) return;
  const attemptId = randomUUID();
  const attemptNo = Number(row.attempts);
  const channel = (
    await sql`SELECT provider,enabled,data FROM notification_channels WHERE id=${String(row.channel_id)}`
  )[0];
  const payload = row.data as NotificationMessage & {
    body?: string;
    priority: string;
    dataMode: 'fixture' | 'live';
  };
  const message: NotificationMessage = {
    ...payload,
    description: payload.description ?? payload.body ?? '',
    dataMode: payload.dataMode ?? config.dataMode,
  };
  await sql`INSERT INTO notification_attempts(id,notification_id,attempt_no,outcome) VALUES(${attemptId},${id},${attemptNo},'SENDING') ON CONFLICT(notification_id,attempt_no) DO NOTHING`;
  const rejection = await notificationRejection(
    row.event_id ? String(row.event_id) : null,
    payload,
    String(row.channel_id),
  );
  let result: SendResult;
  if (rejection.length)
    result = {
      accepted: false,
      retryable: false,
      error: `通知发送前复查取消：${rejection.join('；')}`,
    };
  else if (!channel?.enabled) result = { accepted: false, retryable: false, error: '渠道已禁用' };
  else if (config.dataMode === 'fixture' || message.dataMode === 'fixture')
    result = {
      accepted: false,
      retryable: false,
      error: 'SIMULATED：Fixture模板已处理，未向真实平台发送',
    };
  else {
    try {
      const credentials = readNotificationConfig(String(channel.provider), channel.data);
      const provider =
        channel.provider === 'telegram'
          ? new TelegramProvider(credentials.botToken, credentials.chatId, secureFetch)
          : channel.provider === 'feishu'
            ? new FeishuProvider(credentials.webhookUrl, secureFetch)
            : channel.provider === 'bark'
              ? new BarkProvider(credentials.serverUrl, secureFetch)
              : channel.provider === 'email'
                ? new EmailProvider({
                    smtpHost: credentials.smtpHost,
                    smtpPort: credentials.smtpPort,
                    smtpSecurity: credentials.smtpSecurity,
                    smtpUsername: credentials.smtpUsername,
                    smtpPassword: credentials.smtpPassword,
                    fromEmail: credentials.fromEmail,
                    toEmails: credentials.toEmails,
                  })
                : null;
      result = provider
        ? await provider.send(message)
        : { accepted: false, retryable: false, error: '不支持的通知 Provider' };
    } catch {
      // A broken encrypted configuration requires administrator repair, not an abandoned lease.
      result = {
        accepted: false,
        retryable: false,
        error: '渠道配置无法解密或无效，请重新保存凭据后手动重试',
      };
    }
  }
  const cancelled =
    rejection.length > 0 ||
    !channel?.enabled ||
    config.dataMode === 'fixture' ||
    message.dataMode === 'fixture';
  const state = result.accepted
    ? 'SENT'
    : cancelled
      ? 'CANCELLED'
      : result.retryable && attemptNo < 5
        ? 'RETRYING'
        : 'FAILED';
  const delay = Math.max(result.retryAfterMs ?? 0, Math.min(3600000, 1000 * 2 ** attemptNo));
  await sql.begin(async (tx) => {
    await tx`UPDATE notifications SET status=${state},accepted_at=${result.acceptedAt ?? null},last_error=${result.error ?? null},locked_until=null,next_attempt_at=${new Date(Date.now() + delay).toISOString()},data=data || ${json({ notificationRecheck: { checkedAt: new Date().toISOString(), matched: rejection.length === 0, reasons: rejection } })}::jsonb WHERE id=${id}`;
    await tx`UPDATE notification_attempts SET finished_at=now(),outcome=${state},platform_message_id=${result.platformMessageId ?? null},error=${result.error ?? null},data=${json({ ambiguousAcceptance: result.ambiguous ?? false, simulated: cancelled && message.dataMode === 'fixture', notificationRecheck: { matched: rejection.length === 0, reasons: rejection } })} WHERE id=${attemptId}`;
    if (state === 'RETRYING')
      await tx`UPDATE outbox_jobs SET status='PENDING',available_at=${new Date(Date.now() + delay).toISOString()},locked_until=null WHERE entity_id=${id} AND upper(kind) IN ('NOTIFY','NOTIFICATION')`;
  });
  log.info(
    { notificationId: id, state, attemptNo },
    'notification processed; SENT means platform accepted',
  );
}
function providerForMode(
  effective: Awaited<ReturnType<typeof readAIConfig>> | null,
): AIProvider | null {
  if (config.dataMode === 'fixture') return new FixtureAIProvider();
  if (!effective?.enabled || !effective.apiKey || !effective.model) return null;
  return new CompatibleAIProvider(
    effective.baseUrl,
    effective.apiKey,
    effective.model,
    secureStreamFetch,
    effective.timeoutMs,
    effective.jsonMode,
    effective.reasoningEffort,
  );
}
export class DeferredWorkError extends Error {
  constructor(
    message: string,
    public retryAt: Date,
  ) {
    super(message);
    this.name = 'DeferredWorkError';
  }
}
async function completeAnalysisNotifications(id: string) {
  await sql.begin(async (tx) => {
    const current = (await tx`SELECT data FROM events WHERE id=${id} FOR UPDATE`)[0]?.data as
      Record<string, unknown> | undefined;
    if (current?.dataMode !== config.dataMode || current.analysisStatus !== 'COMPLETED') return;
    if (current.eventType === 'X_HOT_TOPIC')
      await (await import('./pipeline.js')).decideXResearchNotifications(tx, current);
    // Retire only after the separate, idempotent notification phase succeeds. A failed
    // rule evaluation must leave the paid result complete and its outbox retryable.
    await skipAnalysis(tx, id, 'ALREADY_COMPLETED');
  });
}
export async function analyzeEvent(id: string) {
  const eventRow = (await sql`SELECT data FROM events WHERE id=${id}`)[0];
  if (!eventRow) return;
  const event = eventRow.data as Record<string, unknown>;
  // Durable outbox rows can survive a deployment mode switch. Never send their evidence across modes.
  if (event.dataMode !== config.dataMode) return;
  if (event.dataMode === 'live' && event.analysisStatus === 'COMPLETED') {
    await completeAnalysisNotifications(id);
    return;
  }
  const decision = evaluateAnalysisCandidate(event);
  if (!decision.eligible || event.analysisStatus === 'SKIPPED') {
    await sql.begin((tx) =>
      skipAnalysis(
        tx,
        id,
        decision.eligible
          ? String(
              (event.analysisDecision as Record<string, unknown> | undefined)?.reason ??
                'PREVIOUSLY_SKIPPED',
            )
          : decision.reason,
      ),
    );
    return;
  }
  const effective = config.dataMode === 'fixture' ? null : await readAIConfig();
  const provider = providerForMode(effective);
  if (!provider) {
    await sql`UPDATE events SET data=jsonb_set(data,'{analysisStatus}','"DISABLED"') WHERE id=${id}`;
    return;
  }
  const sources =
    await sql`SELECT es.raw_item_id,es.url,es.source_published_at,es.data,ri.payload,ri.first_seen_at FROM event_sources es JOIN raw_items ri ON ri.id=es.raw_item_id WHERE es.event_id=${id} ORDER BY ri.first_seen_at,es.raw_item_id LIMIT 5`;
  const input: AnalysisInput = {
    eventId: id,
    assets: event.assets as string[],
    evidence: truncateAnalysisEvidence(
      sources.map((source) => ({
        id: String(source.raw_item_id),
        title: String((source.data as Record<string, unknown>).title ?? event.title),
        text: JSON.stringify(source.payload),
        url: String(source.url ?? ''),
        availableAt: new Date(source.first_seen_at as string).toISOString(),
      })),
    ),
  };
  if (!input.evidence.length) {
    await sql.begin((tx) => skipAnalysis(tx, id, 'NO_EVIDENCE'));
    return;
  }
  const identity = effective ? compatibleAIProviderIdentity(effective) : undefined;
  const cacheKey = analysisCacheKey(input, provider.model, identity);
  const reservedCost = effective?.maxCallCostUsd ?? 0;
  const reserve = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('financial-radar-ai-budget'))`;
    const current = (await tx`SELECT data FROM events WHERE id=${id} FOR UPDATE`)[0]?.data as
      Record<string, unknown> | undefined;
    if (current?.dataMode === 'live' && current.analysisStatus === 'COMPLETED')
      return { state: 'already-completed', runId: '', data: null };
    const currentDecision = current
      ? evaluateAnalysisCandidate(current)
      : { eligible: false, reason: 'EVENT_MISSING' };
    if (!currentDecision.eligible || current?.analysisStatus === 'SKIPPED')
      return { state: 'filtered', runId: '', data: null };
    const inFlight = (
      await tx`SELECT id FROM ai_analysis_runs WHERE event_id=${id} AND status='RUNNING' LIMIT 1`
    )[0];
    if (inFlight) return { state: 'busy', runId: String(inFlight.id), data: null };
    const cached = (
      await tx`SELECT id,status,data FROM ai_analysis_runs WHERE cache_key=${cacheKey}`
    )[0];
    if (cached?.status === 'COMPLETED')
      return {
        state: 'cached',
        runId: String(cached.id),
        data: cached.data as Record<string, unknown>,
      };
    if (cached?.status === 'RUNNING')
      return { state: 'busy', runId: String(cached.id), data: null };
    const priorAttempts = Number(
      (cached?.data as Record<string, unknown> | undefined)?.attempts ?? 0,
    );
    if (priorAttempts >= 3) return { state: 'exhausted', runId: String(cached!.id), data: null };
    const usage = (
      await tx`SELECT coalesce(sum((reservation->>'cost')::numeric),0)::float AS cost,count(*)::int AS calls FROM ai_analysis_runs CROSS JOIN LATERAL jsonb_array_elements(coalesce(data->'reservations','[]'::jsonb)) AS reservation WHERE provider<>'fixture' AND (reservation->>'at')::timestamptz>=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`
    )[0]!;
    if (
      effective &&
      (effective.dailyBudgetUsd <= 0 ||
        reservedCost <= 0 ||
        Number(usage.cost) + reservedCost > effective.dailyBudgetUsd ||
        Number(usage.calls) >= effective.maxDailyCalls)
    )
      return { state: 'budget', runId: '', data: null };
    // Legacy jobs predate admission metadata. Apply the same asset cooldown before a paid call.
    if (
      event.dataMode === 'live' &&
      !(event.analysisDecision as Record<string, unknown> | undefined)?.admittedAt
    ) {
      await tx`SELECT pg_advisory_xact_lock(hashtext('financial-radar-ai-admission'))`;
      const key = analysisCooldownKey(event);
      if (
        key &&
        (
          await tx`SELECT id FROM events WHERE id<>${id} AND data->>'dataMode'='live' AND data->'analysisDecision'->>'cooldownKey'=${key} AND (data->'analysisDecision'->>'admittedAt')::timestamptz>now()-interval '6 hours' LIMIT 1`
        ).length
      )
        return { state: 'cooldown', runId: '', data: null };
      await tx`UPDATE events SET data=data || ${json({ analysisDecision: { ...analysisDecision('SELECTED'), cooldownKey: key, admittedAt: new Date().toISOString() } })}::jsonb WHERE id=${id}`;
    }
    const runId = cached ? String(cached.id) : randomUUID();
    if (cached)
      await tx`UPDATE ai_analysis_runs SET status='RUNNING',error=null,completed_at=null,estimated_cost=coalesce(estimated_cost,0)+${reservedCost},data=(data || ${json({ attempts: priorAttempts + 1, lastReservation: reservedCost, leaseStartedAt: new Date().toISOString() })}::jsonb) || jsonb_build_object('reservations',coalesce(data->'reservations','[]'::jsonb) || ${json([{ at: new Date().toISOString(), cost: reservedCost }])}::jsonb) WHERE id=${runId}`;
    else
      await tx`INSERT INTO ai_analysis_runs(id,event_id,status,provider,model,prompt_version,cache_key,estimated_cost,data) VALUES(${runId},${id},'RUNNING',${provider.name},${provider.model},${PROMPT_VERSION},${cacheKey},${reservedCost},${json({ reviewStatus: 'UNREVIEWED', reservation: reservedCost, inputHash: cacheKey, ...(effective ? { reasoningEffort: effective.reasoningEffort } : {}), costBasis: 'conservative-per-call-reservation', attempts: 1, leaseStartedAt: new Date().toISOString(), reservations: [{ at: new Date().toISOString(), cost: reservedCost }] })})`;
    return { state: 'allowed', runId, data: null };
  });
  if (reserve.state === 'already-completed') {
    await completeAnalysisNotifications(id);
    return;
  }
  if (reserve.state === 'filtered') {
    await sql.begin((tx) => skipAnalysis(tx, id, 'NO_LONGER_ELIGIBLE'));
    return;
  }
  if (reserve.state === 'cached') {
    await sql`UPDATE events SET data=data || ${json({ analysisStatus: 'COMPLETED', analysis: reserve.data!.result })}::jsonb WHERE id=${id}`;
    await completeAnalysisNotifications(id);
    return;
  }
  if (reserve.state === 'exhausted') {
    await sql`UPDATE events SET data=jsonb_set(data,'{analysisStatus}','"FAILED"') WHERE id=${id}`;
    return;
  }
  if (reserve.state === 'busy')
    throw new DeferredWorkError('分析租约仍在进行', new Date(Date.now() + 90000));
  if (reserve.state === 'budget' || reserve.state === 'cooldown') {
    await sql.begin((tx) =>
      skipAnalysis(
        tx,
        id,
        reserve.state === 'budget' ? 'DAILY_BUDGET_OR_CALL_LIMIT' : 'ASSET_COOLDOWN',
      ),
    );
    return;
  }
  try {
    const result = await provider.analyze(input);
    await sql.begin(async (tx) => {
      await tx`UPDATE ai_analysis_runs SET status='COMPLETED',input_tokens=${result.inputTokens},output_tokens=${result.outputTokens},completed_at=now(),data=data || ${json({ result: result.result, tokenUsageKnown: result.inputTokens !== null })}::jsonb WHERE id=${reserve.runId}`;
      await tx`UPDATE events SET data=data || ${json({ analysisStatus: 'COMPLETED', analysis: result.result })}::jsonb,updated_at=now() WHERE id=${id}`;
    });
  } catch (error) {
    await sql`UPDATE ai_analysis_runs SET status='FAILED',error=${safeError(error)},completed_at=now() WHERE id=${reserve.runId}`;
    await sql`UPDATE events SET data=jsonb_set(data,'{analysisStatus}','"FAILED"') WHERE id=${id}`;
    log.warn(
      { eventId: id, error: safeError(error) },
      'AI failed; deterministic alerts remain active',
    );
    throw error;
  }
  await completeAnalysisNotifications(id);
}
export async function recoverLeases() {
  await sql`UPDATE notifications SET status='RETRYING',locked_until=null,last_error='Worker租约过期；平台接受状态可能未知' WHERE status='SENDING' AND locked_until<now()`;
  // Streaming analysis has a hard 10-minute request limit. Leave recovery headroom so a live
  // stream is never marked failed (and charged again) while its worker still owns the run.
  await sql`UPDATE ai_analysis_runs SET status='FAILED',error='Worker restarted during AI call; budget reservation retained',completed_at=now() WHERE status='RUNNING' AND coalesce((data->>'leaseStartedAt')::timestamptz,created_at)<now()-interval '15 minutes'`;
  await sql`UPDATE outbox_jobs SET status='PENDING',locked_until=null WHERE status='QUEUED' AND locked_until<now()`;
  // Reconcile durable notification records even if Redis lost its entire queue.
  await sql`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) SELECT gen_random_uuid(),'notify:'||id,'NOTIFY',id FROM notifications WHERE status IN ('PENDING','RETRYING') ON CONFLICT(dedup_key) DO UPDATE SET status='PENDING',available_at=excluded.available_at WHERE outbox_jobs.status='COMPLETED'`;
}
export async function reconcileAnalysisBacklog() {
  if (config.dataMode !== 'live') return;
  const rows =
    await sql`SELECT DISTINCT e.id,e.first_seen_at,e.data FROM events e JOIN outbox_jobs o ON o.entity_id=e.id WHERE upper(o.kind) IN ('ANALYZE','ANALYSIS') AND o.status IN ('PENDING','QUEUED') AND e.data->>'dataMode'='live' AND (e.data->>'eventType' IS DISTINCT FROM 'X_HOT_TOPIC' OR e.data->>'analysisStatus' IS DISTINCT FROM 'COMPLETED') AND (e.data->'analysisDecision'->>'version' IS DISTINCT FROM ${ANALYSIS_POLICY_VERSION} OR e.first_seen_at<now()-interval '1 hour') AND NOT EXISTS(SELECT 1 FROM ai_analysis_runs r WHERE r.event_id=e.id AND r.status='RUNNING') ORDER BY e.first_seen_at,e.id LIMIT 500`;
  const groups = new Map<string, string[]>();
  const selected: string[] = [];
  for (const row of rows) {
    const decision = evaluateAnalysisCandidate(row.data as Record<string, unknown>);
    if (decision.eligible) selected.push(String(row.id));
    else groups.set(decision.reason, [...(groups.get(decision.reason) ?? []), String(row.id)]);
  }
  await sql.begin(async (tx) => {
    if (rows.length)
      await tx`SELECT id FROM events WHERE id=ANY(${rows.map((row) => String(row.id))}::uuid[]) ORDER BY id FOR UPDATE`;
    for (const [reason, ids] of groups) {
      await tx`UPDATE events SET data=jsonb_set(data || '{"analysisStatus":"SKIPPED"}'::jsonb,'{analysisDecision}',coalesce(data->'analysisDecision','{}'::jsonb) || ${json(analysisDecision(reason))}::jsonb) WHERE id=ANY(${ids}::uuid[]) AND coalesce(data->>'analysisStatus','')<>'COMPLETED' AND NOT EXISTS(SELECT 1 FROM ai_analysis_runs r WHERE r.event_id=events.id AND r.status='RUNNING')`;
      await tx`UPDATE outbox_jobs SET status='COMPLETED',locked_until=null WHERE entity_id=ANY(${ids}::uuid[]) AND upper(kind) IN ('ANALYZE','ANALYSIS') AND status IN ('PENDING','QUEUED') AND NOT EXISTS(SELECT 1 FROM ai_analysis_runs r WHERE r.event_id=outbox_jobs.entity_id AND r.status='RUNNING')`;
    }
    if (selected.length)
      await tx`UPDATE events SET data=jsonb_set(data,'{analysisDecision}',coalesce(data->'analysisDecision','{}'::jsonb) || ${json(analysisDecision('SELECTED'))}::jsonb) WHERE id=ANY(${selected}::uuid[])`;
  });
  return rows.length;
}
export async function claimOutboxJobs() {
  await reconcileAnalysisBacklog();
  return sql.begin(async (tx) => {
    // Dispatch deterministic alerts independently of the size or age of the AI backlog.
    const notices =
      await tx`UPDATE outbox_jobs SET status='QUEUED',locked_until=now()+interval '2 minutes' WHERE id IN (SELECT id FROM outbox_jobs WHERE status='PENDING' AND available_at<=now() AND upper(kind) IN ('NOTIFY','NOTIFICATION') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id,kind,entity_id`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('financial-radar-ai-dispatch'))`;
    const active = (
      await tx`SELECT count(*)::int AS count FROM outbox_jobs o JOIN events e ON e.id=o.entity_id WHERE o.status='QUEUED' AND upper(o.kind) IN ('ANALYZE','ANALYSIS') AND e.data->>'dataMode'=${config.dataMode}`
    )[0]!;
    const limit = config.dataMode === 'live' ? Math.max(0, 2 - Number(active.count)) : 100;
    const analyses = limit
      ? await tx`UPDATE outbox_jobs SET status='QUEUED',locked_until=now()+interval '15 minutes' WHERE id IN (SELECT o.id FROM outbox_jobs o JOIN events e ON e.id=o.entity_id WHERE o.status='PENDING' AND o.available_at<=now() AND upper(o.kind) IN ('ANALYZE','ANALYSIS') AND e.data->>'dataMode'=${config.dataMode} ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT ${limit}) RETURNING id,kind,entity_id`
      : [];
    return [...notices, ...analyses];
  });
}
export async function extendAnalysisOutboxLease(outboxId: string) {
  // Queue waiting time must not consume the running call's recovery allowance.
  await sql`UPDATE outbox_jobs SET locked_until=now()+interval '15 minutes' WHERE id=${outboxId} AND status='QUEUED' AND upper(kind) IN ('ANALYZE','ANALYSIS')`;
}
export async function runOutboxOnce() {
  await recoverLeases();
  const pending = await claimOutboxJobs();
  // The one-shot runner has no dedicated queue processors, so finish deterministic notices
  // before spending time on potentially long model calls.
  const isNotification = (row: Record<string, unknown>) =>
    ['NOTIFY', 'NOTIFICATION'].includes(String(row.kind).toUpperCase());
  for (const row of [
    ...pending.filter(isNotification),
    ...pending.filter((entry) => !isNotification(entry)),
  ]) {
    const id = String(row.id);
    try {
      if (['NOTIFY', 'NOTIFICATION'].includes(String(row.kind).toUpperCase()))
        await sendNotification(String(row.entity_id));
      else if (['ANALYZE', 'ANALYSIS'].includes(String(row.kind).toUpperCase())) {
        await extendAnalysisOutboxLease(id);
        await analyzeEvent(String(row.entity_id));
      } else throw new Error('未知 outbox 类型');
      await sql`UPDATE outbox_jobs SET status='COMPLETED',locked_until=null WHERE id=${id} AND NOT(status='PENDING' AND available_at>now())`;
    } catch (error) {
      if (error instanceof DeferredWorkError) {
        await sql`UPDATE outbox_jobs SET status='PENDING',available_at=${error.retryAt.toISOString()},locked_until=null WHERE id=${id}`;
        continue;
      }
      await sql`UPDATE outbox_jobs SET attempts=attempts+1,available_at=now()+interval '30 seconds',locked_until=null,status=CASE WHEN attempts>=4 THEN 'FAILED' ELSE 'PENDING' END WHERE id=${id}`;
      log.error({ outboxId: id, error: safeError(error) }, 'outbox job failed');
    }
  }
}
export async function heartbeat(queue: Record<string, unknown> = {}) {
  const data = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    mode: config.dataMode,
    version: config.version,
    commitSha: config.commitSha,
    queue,
  };
  await sql`INSERT INTO system_settings(key,data) VALUES('worker:heartbeat',${json(data)}) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=now()`;
  return data;
}
