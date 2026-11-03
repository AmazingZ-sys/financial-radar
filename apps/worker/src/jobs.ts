import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { sql, readAIConfig, readNotificationConfig } from '@radar/database';
import { config, fetchPublicHttps } from '@radar/config';
import { createLogger } from '@radar/observability';
import {
  TelegramProvider,
  FeishuProvider,
  BarkProvider,
  type NotificationMessage,
  type SendResult,
} from '@radar/notifications';
import {
  CompatibleAIProvider,
  FixtureAIProvider,
  analysisCacheKey,
  PROMPT_VERSION,
  type AnalysisInput,
  type AIProvider,
} from '@radar/ai';
const json = (value: unknown) => sql.json(value as postgres.JSONValue);
const log = createLogger('worker.jobs');
const secureFetch: typeof fetch = (input, init) => fetchPublicHttps(String(input), init);
function safeError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 250)
    : '未知任务错误';
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
  let result: SendResult;
  if (!channel?.enabled) result = { accepted: false, retryable: false, error: '渠道已禁用' };
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
    !channel?.enabled || config.dataMode === 'fixture' || message.dataMode === 'fixture';
  const state = result.accepted
    ? 'SENT'
    : cancelled
      ? 'CANCELLED'
      : result.retryable && attemptNo < 5
        ? 'RETRYING'
        : 'FAILED';
  const delay = Math.max(result.retryAfterMs ?? 0, Math.min(3600000, 1000 * 2 ** attemptNo));
  await sql.begin(async (tx) => {
    await tx`UPDATE notifications SET status=${state},accepted_at=${result.acceptedAt ?? null},last_error=${result.error ?? null},locked_until=null,next_attempt_at=${new Date(Date.now() + delay).toISOString()} WHERE id=${id}`;
    await tx`UPDATE notification_attempts SET finished_at=now(),outcome=${state},platform_message_id=${result.platformMessageId ?? null},error=${result.error ?? null},data=${json({ ambiguousAcceptance: result.ambiguous ?? false, simulated: cancelled && message.dataMode === 'fixture' })} WHERE id=${attemptId}`;
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
    secureFetch,
    effective.timeoutMs,
    effective.jsonMode,
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
export async function analyzeEvent(id: string) {
  const eventRow = (await sql`SELECT data FROM events WHERE id=${id}`)[0];
  if (!eventRow) return;
  const event = eventRow.data as Record<string, unknown>;
  // Durable outbox rows can survive a deployment mode switch. Never send their evidence across modes.
  if (event.dataMode !== config.dataMode) return;
  const effective = config.dataMode === 'fixture' ? null : await readAIConfig();
  const provider = providerForMode(effective);
  if (!provider) {
    await sql`UPDATE events SET data=jsonb_set(data,'{analysisStatus}','"DISABLED"') WHERE id=${id}`;
    return;
  }
  const sources =
    await sql`SELECT es.raw_item_id,es.url,es.source_published_at,es.data,ri.payload,ri.first_seen_at FROM event_sources es JOIN raw_items ri ON ri.id=es.raw_item_id WHERE es.event_id=${id} ORDER BY ri.first_seen_at LIMIT 20`;
  const input: AnalysisInput = {
    eventId: id,
    assets: event.assets as string[],
    evidence: sources.map((source) => ({
      id: String(source.raw_item_id),
      title: String((source.data as Record<string, unknown>).title ?? event.title),
      text: JSON.stringify(source.payload).slice(0, 12000),
      url: String(source.url ?? ''),
      availableAt: new Date(source.first_seen_at as string).toISOString(),
    })),
  };
  const identity = !effective
    ? undefined
    : createHash('sha256')
        .update(JSON.stringify([effective.baseUrl, effective.apiKey, effective.jsonMode]))
        .digest('hex');
  const cacheKey = analysisCacheKey(input, provider.model, identity);
  const reservedCost = effective?.maxCallCostUsd ?? 0;
  const reserve = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('financial-radar-ai-budget'))`;
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
      await tx`SELECT coalesce(sum((reservation->>'cost')::numeric),0)::float AS cost,count(*)::int AS calls FROM ai_analysis_runs CROSS JOIN LATERAL jsonb_array_elements(coalesce(data->'reservations','[]'::jsonb)) AS reservation WHERE provider<>'fixture' AND (reservation->>'at')::timestamptz>=date_trunc('day',now() AT TIME ZONE 'UTC')`
    )[0]!;
    if (
      effective &&
      (effective.dailyBudgetUsd <= 0 ||
        reservedCost <= 0 ||
        Number(usage.cost) + reservedCost > effective.dailyBudgetUsd ||
        Number(usage.calls) >= 500)
    )
      return { state: 'budget', runId: '', data: null };
    const runId = cached ? String(cached.id) : randomUUID();
    if (cached)
      await tx`UPDATE ai_analysis_runs SET status='RUNNING',estimated_cost=coalesce(estimated_cost,0)+${reservedCost},data=(data || ${json({ attempts: priorAttempts + 1, lastReservation: reservedCost, leaseStartedAt: new Date().toISOString() })}::jsonb) || jsonb_build_object('reservations',coalesce(data->'reservations','[]'::jsonb) || ${json([{ at: new Date().toISOString(), cost: reservedCost }])}::jsonb) WHERE id=${runId}`;
    else
      await tx`INSERT INTO ai_analysis_runs(id,event_id,status,provider,model,prompt_version,cache_key,estimated_cost,data) VALUES(${runId},${id},'RUNNING',${provider.name},${provider.model},${PROMPT_VERSION},${cacheKey},${reservedCost},${json({ reviewStatus: 'UNREVIEWED', reservation: reservedCost, inputHash: cacheKey, costBasis: 'conservative-per-call-reservation', attempts: 1, leaseStartedAt: new Date().toISOString(), reservations: [{ at: new Date().toISOString(), cost: reservedCost }] })})`;
    return { state: 'allowed', runId, data: null };
  });
  if (reserve.state === 'cached') {
    await sql`UPDATE events SET data=data || ${json({ analysisStatus: 'COMPLETED', analysis: reserve.data!.result })}::jsonb WHERE id=${id}`;
    return;
  }
  if (reserve.state === 'exhausted') {
    await sql`UPDATE events SET data=jsonb_set(data,'{analysisStatus}','"FAILED"') WHERE id=${id}`;
    return;
  }
  if (reserve.state === 'busy')
    throw new DeferredWorkError('分析租约仍在进行', new Date(Date.now() + 90000));
  if (reserve.state === 'budget') {
    await sql`UPDATE events SET data=jsonb_set(data,'{analysisStatus}','"DEFERRED"') WHERE id=${id}`;
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 1, 0);
    throw new DeferredWorkError('AI每日预算或调用额度不足；核心预警继续', tomorrow);
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
}
export async function recoverLeases() {
  await sql`UPDATE notifications SET status='RETRYING',locked_until=null,last_error='Worker租约过期；平台接受状态可能未知' WHERE status='SENDING' AND locked_until<now()`;
  await sql`UPDATE ai_analysis_runs SET status='FAILED',error='Worker restarted during AI call; budget reservation retained',completed_at=now() WHERE status='RUNNING' AND coalesce((data->>'leaseStartedAt')::timestamptz,created_at)<now()-interval '5 minutes'`;
  await sql`UPDATE outbox_jobs SET status='PENDING',locked_until=null WHERE status='QUEUED' AND locked_until<now()`;
  // Reconcile durable notification records even if Redis lost its entire queue.
  await sql`INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id) SELECT gen_random_uuid(),'notify:'||id,'NOTIFY',id FROM notifications WHERE status IN ('PENDING','RETRYING') ON CONFLICT(dedup_key) DO UPDATE SET status='PENDING',available_at=excluded.available_at WHERE outbox_jobs.status='COMPLETED'`;
}
export async function runOutboxOnce() {
  await recoverLeases();
  const pending =
    await sql`UPDATE outbox_jobs SET status='QUEUED',locked_until=now()+interval '2 minutes' WHERE id IN (SELECT id FROM outbox_jobs WHERE status='PENDING' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id,kind,entity_id`;
  for (const row of pending) {
    const id = String(row.id);
    try {
      if (['NOTIFY', 'NOTIFICATION'].includes(String(row.kind).toUpperCase()))
        await sendNotification(String(row.entity_id));
      else if (['ANALYZE', 'ANALYSIS'].includes(String(row.kind).toUpperCase()))
        await analyzeEvent(String(row.entity_id));
      else throw new Error('未知 outbox 类型');
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
