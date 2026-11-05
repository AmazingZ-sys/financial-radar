import { config } from '@radar/config';
import {
  XConfigPatchSchema,
  XSessionCookiesSchema,
  XConnectionTestSchema,
  XPollStateSchema,
  mergeXConfig,
  buildXSearchQuery,
  type XConfig,
  type XConfigPatch,
  type XConnectionTest,
} from '@radar/shared';
import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { sql } from './index.js';
import { encryptIntegrationSecret, decryptIntegrationSecret } from './integrations.js';
import { DEFAULT_X_POLL_STATE, extendXPollState, nextXPollState } from './x-scheduling.js';
export { XRequestDeferredError } from './x-scheduling.js';

const KEY = 'integrations:x';
const POLL_KEY = 'x:poll-state';
const json = (data: unknown) => sql.json(data as postgres.JSONValue);
function decodeXConfig(stored: Record<string, unknown>, hasOverride: boolean) {
  const fields = mergeXConfig(stored);
  let sessionCookies = '';
  let credentialError = false;
  try {
    if (typeof stored.encryptedSessionCookies === 'string' && stored.encryptedSessionCookies)
      sessionCookies = XSessionCookiesSchema.parse(
        decryptIntegrationSecret(stored.encryptedSessionCookies, KEY),
      );
  } catch {
    credentialError = true;
  }
  return {
    ...fields,
    pollIntervalSeconds: fields.pollIntervalMinSeconds,
    // A saved official token is never interpreted as a login session or used as fallback.
    enabled: fields.enabled && Boolean(sessionCookies) && !credentialError,
    sessionCookies,
    credentialError,
    sessionConfigured: Boolean(stored.encryptedSessionCookies),
    configOrigin: hasOverride ? ('database' as const) : ('default' as const),
  };
}
export async function readXConfig() {
  const row = (await sql`SELECT data FROM system_settings WHERE key=${KEY}`)[0];
  return decodeXConfig((row?.data ?? {}) as Record<string, unknown>, Boolean(row));
}
export async function saveXConfig(patch: XConfigPatch) {
  const parsed = XConfigPatchSchema.parse(patch);
  if (parsed.clearSessionCookies && parsed.sessionCookies)
    throw new Error('不能同时写入和清除 X 登录态');
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${KEY}))`;
    const row = (await tx`SELECT data FROM system_settings WHERE key=${KEY}`)[0];
    const stored = (row?.data ?? {}) as Record<string, unknown>;
    const previous = decodeXConfig(stored, Boolean(row));
    const fields = mergeXConfig(
      { ...stored, enabled: previous.enabled },
      { ...parsed, ...(parsed.clearSessionCookies ? { enabled: false } : {}) },
    );
    buildXSearchQuery(fields);
    const encryptedSessionCookies = parsed.clearSessionCookies
      ? ''
      : parsed.sessionCookies
        ? encryptIntegrationSecret(parsed.sessionCookies, KEY)
        : typeof stored.encryptedSessionCookies === 'string'
          ? stored.encryptedSessionCookies
          : '';
    const sessionCookies = parsed.clearSessionCookies
      ? ''
      : (parsed.sessionCookies ?? previous.sessionCookies);
    if (
      fields.enabled &&
      (!sessionCookies || !fields.usernames.length || !fields.dailyRequestLimit)
    )
      throw new Error('启用采集前请配置有效登录态、关注账号和大于0的每日请求上限');
    await tx`INSERT INTO system_settings(key,data) VALUES(${KEY},${json({ ...fields, encryptedSessionCookies })}) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=now()`;
  });
  return readXConfigView();
}
export async function readXConfigView() {
  const effective = await readXConfig();
  const { sessionCookies: _session, ...fields } = effective;
  const collectorConfigured = Boolean(config.xCollectorUrl && config.xCollectorSecret);
  const day = new Date().toISOString().slice(0, 10);
  const rows =
    await sql`SELECT key,data FROM system_settings WHERE key IN (${'x:usage:' + day},'x:last-test')`;
  const requests = Number(rows.find((row) => row.key === 'x:usage:' + day)?.data?.requests ?? 0);
  const savedTest = rows.find((row) => row.key === 'x:last-test')?.data;
  const lastTest = XConnectionTestSchema.safeParse(
    savedTest?.collector === 'self-hosted' ? savedTest : undefined,
  );
  const source = (
    await sql`SELECT enabled,last_success_at,last_error,data FROM data_sources WHERE id='x-search' AND mode='live'`
  )[0];
  return {
    ...fields,
    collectorConfigured,
    query: buildXSearchQuery(effective),
    dataMode: config.dataMode,
    usage: { day, requests, remaining: Math.max(0, fields.dailyRequestLimit - requests) },
    scheduling: await readXPollState(),
    lastTest: lastTest.success && lastTest.data.dataMode === config.dataMode ? lastTest.data : null,
    source: {
      enabled:
        config.dataMode === 'live' &&
        effective.enabled &&
        !effective.credentialError &&
        Boolean(effective.sessionCookies) &&
        collectorConfigured &&
        effective.usernames.length > 0 &&
        effective.dailyRequestLimit > 0 &&
        Boolean(source?.enabled),
      status:
        config.dataMode === 'fixture'
          ? 'fixture'
          : effective.credentialError
            ? 'credential_error'
            : !effective.sessionCookies || !effective.usernames.length || !collectorConfigured
              ? 'unconfigured'
              : !effective.enabled
                ? 'disabled'
                : String(source?.data?.status ?? 'pending'),
      lastFetchedAt:
        config.dataMode === 'live' && source?.last_success_at
          ? new Date(source.last_success_at as string).toISOString()
          : null,
      lastError:
        config.dataMode === 'live' && source?.last_error ? String(source.last_error) : null,
    },
  };
}
export async function reserveXRequest(
  expected?: XConfig & { sessionCookies?: string },
  options: { requireEnabled?: boolean } = {},
) {
  if (config.dataMode !== 'live') throw new Error('Fixture 模式不发送 X 请求');
  if (!config.xCollectorUrl || !config.xCollectorSecret)
    throw new Error('X_COLLECTOR_CONFIGURATION_REQUIRED');
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${KEY}))`;
    const row = (await tx`SELECT data FROM system_settings WHERE key=${KEY}`)[0];
    const effective = decodeXConfig((row?.data ?? {}) as Record<string, unknown>, Boolean(row));
    if (effective.credentialError || !effective.sessionCookies || !effective.usernames.length)
      throw new Error('X 凭据或关注账号未配置，请重新保存后测试');
    if (options.requireEnabled !== false && !effective.enabled) throw new Error('X 采集已关闭');
    if (
      expected &&
      ((expected.sessionCookies !== undefined &&
        expected.sessionCookies !== effective.sessionCookies) ||
        buildXSearchQuery(expected) !== buildXSearchQuery(effective))
    )
      throw new Error('X 配置已更新，请使用最新配置重试');
    const at = (await tx`SELECT clock_timestamp() AS at`)[0]!.at;
    const now = new Date(at as string | Date);
    const day = now.toISOString().slice(0, 10);
    const key = 'x:usage:' + day;
    const usage = (await tx`SELECT data FROM system_settings WHERE key=${key}`)[0]?.data;
    const requests = Number(usage?.requests ?? 0);
    if (requests >= effective.dailyRequestLimit)
      throw new Error('X 今日请求上限已用尽；请调整上限或等待 UTC 次日');
    const savedState = (await tx`SELECT data FROM system_settings WHERE key=${POLL_KEY}`)[0]?.data;
    const next = nextXPollState(
      effective,
      XPollStateSchema.parse(savedState ?? DEFAULT_X_POLL_STATE),
      now,
    );
    await tx`INSERT INTO system_settings(key,data) VALUES(${key},${json({ day, requests: requests + 1 })}) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=now()`;
    await persistXPollState(tx, next);
    return requests + 1;
  });
}
export async function readXPollState() {
  const row = (await sql`SELECT data FROM system_settings WHERE key=${POLL_KEY}`)[0];
  return XPollStateSchema.parse(row?.data ?? DEFAULT_X_POLL_STATE);
}
async function persistXPollState(
  tx: TransactionSql,
  state: ReturnType<typeof XPollStateSchema.parse>,
) {
  await tx`INSERT INTO system_settings(key,data) VALUES(${POLL_KEY},${json(state)}) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=now()`;
  await tx`UPDATE data_sources SET next_poll_at=${state.nextRequestAt}::timestamptz WHERE id='x-search' AND mode='live'`;
}
export async function deferXRequestsUntil(until: string) {
  // Validate even when no previous request has been reserved; never accept an invalid cooldown.
  extendXPollState(DEFAULT_X_POLL_STATE, until);
  if (config.dataMode !== 'live') return readXPollState();
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${KEY}))`;
    const row = (await tx`SELECT data FROM system_settings WHERE key=${POLL_KEY}`)[0];
    const next = extendXPollState(XPollStateSchema.parse(row?.data ?? DEFAULT_X_POLL_STATE), until);
    await persistXPollState(tx, next);
    return next;
  });
}
export async function saveXTestResult(result: XConnectionTest) {
  await sql`INSERT INTO system_settings(key,data) VALUES('x:last-test',${json({ ...XConnectionTestSchema.parse(result), collector: 'self-hosted' })}) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=now()`;
}
