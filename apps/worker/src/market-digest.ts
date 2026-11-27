import { sql, notificationConfigView } from '@radar/database';
import { config } from '@radar/config';
import { calculateChangePct } from '@radar/shared';

const dayMs = 24 * 60 * 60 * 1000;
const beijingDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const beijingTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function marketDigestWindow(now: Date) {
  const day = beijingDate.format(now);
  const cutoff = new Date(day + 'T10:00:00+08:00');
  if (now < cutoff) return null;
  const dayStart = new Date(day + 'T00:00:00+08:00');
  return {
    day,
    cutoff: cutoff.toISOString(),
    dayStart: dayStart.toISOString(),
    previousCutoff: new Date(cutoff.getTime() - dayMs).toISOString(),
    previousStart: new Date(dayStart.getTime() - dayMs).toISOString(),
  };
}

type DigestWindow = NonNullable<ReturnType<typeof marketDigestWindow>>;

async function marketRows(window: DigestWindow) {
  // Ingestion uses the source time for ticks, and the discovery time for daily
  // releases. Historical rows carry the raw item ID or the recorded delay.
  const rows = await sql`
    WITH samples AS NOT MATERIALIZED (
      SELECT m.asset_key, m.source_id, m.observed_at, m.value, m.unit, m.id,
        m.data->>'name' AS name, coalesce(m.data->>'frequency', 'tick') AS frequency,
        m.data->>'sourceDate' AS source_date,
        coalesce(greatest(raw.first_seen_at, raw.collected_at),
          m.observed_at + coalesce(m.delay_seconds, 0) * interval '1 second') AS available_at
      FROM market_observations m
      LEFT JOIN raw_items raw ON raw.source_id=m.source_id AND raw.id=CASE
        WHEN m.data->>'rawDataReference' ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
        THEN (m.data->>'rawDataReference')::uuid END
      WHERE m.data->>'dataMode'=${config.dataMode}
        AND m.observed_at <= ${window.cutoff}::timestamptz
    ), latest AS (
      SELECT DISTINCT ON (asset_key) * FROM samples
      WHERE available_at <= ${window.cutoff}::timestamptz
        AND (source_date IS NULL OR source_date <= ${window.day})
      ORDER BY asset_key, source_date DESC NULLS LAST, observed_at DESC, id
    )
    SELECT c.*, p.value previous_value, p.source_date previous_source_date,
      p.observed_at previous_observed_at
    FROM latest c
    LEFT JOIN LATERAL (
      SELECT value, observed_at, source_date FROM samples p
      WHERE p.asset_key = c.asset_key AND p.source_id = c.source_id AND p.unit = c.unit
        AND p.frequency = c.frequency AND (
          (c.frequency = 'daily'
            AND p.source_date = to_char(c.source_date::date - 1, 'YYYY-MM-DD')
            AND p.available_at <= ${window.cutoff}::timestamptz)
          OR
          (c.frequency <> 'daily' AND c.observed_at >= ${window.dayStart}::timestamptz
            AND p.observed_at BETWEEN ${window.previousStart}::timestamptz AND ${window.previousCutoff}::timestamptz
            AND p.available_at <= ${window.previousCutoff}::timestamptz)
        )
      ORDER BY p.observed_at DESC, p.id LIMIT 1
    ) p ON true
    ORDER BY c.asset_key
  `;
  return rows.map((r) => {
    const value = Number(r.value);
    const previousValue = r.previous_value === null ? null : Number(r.previous_value);
    return {
      assetKey: String(r.asset_key),
      name: String(r.name || r.asset_key),
      value,
      unit: String(r.unit),
      sourceId: String(r.source_id),
      frequency: String(r.frequency),
      observedAt: new Date(r.observed_at).toISOString(),
      sourceDate: r.source_date as string | null,
      previousValue,
      previousObservedAt: r.previous_observed_at
        ? new Date(r.previous_observed_at).toISOString()
        : null,
      previousSourceDate: r.previous_source_date as string | null,
      changePct: calculateChangePct(value, previousValue),
      changeBps: r.unit === '%' && previousValue !== null ? (value - previousValue) * 100 : null,
    };
  });
}

type MarketDigestRow = Awaited<ReturnType<typeof marketRows>>[number];
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 10 });
const signed = (value: number) => (value > 0 ? '+' : '') + value.toFixed(2);
function localTime(iso: string) {
  const date = new Date(iso);
  return beijingDate.format(date) + ' ' + beijingTime.format(date);
}

function describeMarket(row: MarketDigestRow, window: DigestWindow) {
  const name = row.name === row.assetKey ? row.assetKey : `${row.name}（${row.assetKey}）`;
  const daily = row.frequency === 'daily';
  let comparison;
  if (!daily && row.observedAt < window.dayStart) comparison = '今日尚无新报价，涨跌未知';
  else if (row.previousValue === null) comparison = '缺少前一日可比观测，涨跌未知';
  else if (row.changePct === null) comparison = '前一日基准为零，涨跌百分比未知';
  else
    comparison =
      (row.unit === '%' ? '较前一日相对变化 ' : '较前一日 ') + signed(row.changePct) + '%';
  if (row.changeBps !== null) comparison += `（${signed(row.changeBps)} bp）`;
  const current = daily ? '日度 ' + (row.sourceDate ?? '日期未知') : localTime(row.observedAt);
  const previous = daily
    ? row.previousSourceDate
    : row.previousObservedAt && localTime(row.previousObservedAt);
  return `${name}  ${numberFormat.format(row.value)} ${row.unit}  ${comparison}\n${row.sourceId} · ${current}${previous ? '，基准 ' + previous : ''}`;
}

/** The first tick after 10:00 (including a restart later that day) uses the fixed 10:00 cutoff. */
export async function runMarketDigest(now = new Date()): Promise<number> {
  const window = marketDigestWindow(now);
  if (!window) return 0;
  const prefix = `market-digest:${config.dataMode}:${window.day}:`;
  // Probe the unique notification key before loading any history or decrypting credentials.
  const pending = await sql<
    { id: string; name: string; provider: string; enabled: boolean; data: unknown }[]
  >`
    SELECT ch.id, ch.name, ch.provider, ch.enabled, ch.data FROM notification_channels ch
    JOIN users u ON u.id=ch.owner_id AND u.enabled
    WHERE ch.enabled AND NOT EXISTS (
      SELECT 1 FROM notifications n WHERE n.dedup_key=(${prefix} || ch.id::text)
    ) ORDER BY ch.id
  `;
  const channels = pending.filter(
    (ch) => config.dataMode === 'fixture' || notificationConfigView(ch).configured,
  );
  if (!channels.length) return 0;
  const rows = await marketRows(window);
  const body = rows.length
    ? rows.map((row) => describeMarket(row, window)).join('\n\n')
    : '截至北京时间 10:00，行情监控尚无可用观测。';
  const message = {
    kind: 'daily-market-digest',
    title: `${window.day} 行情监控日报 · 北京时间 10:00`,
    priority: 'P2',
    description: body,
    body,
    dataMode: config.dataMode,
    assets: rows.map((row) => row.assetKey),
    asOf: window.cutoff,
    rows,
  };
  // One statement atomically queues every newly inserted notice. Concurrent replicas
  // and Redis recovery share the same per-channel database idempotency key.
  const inserted = await sql`
    WITH notices AS (
      INSERT INTO notifications(id,dedup_key,channel_id,status,data)
      SELECT gen_random_uuid(),${prefix} || ch.id::text,ch.id,'PENDING',${sql.json(message)}::jsonb
      FROM notification_channels ch JOIN users u ON u.id=ch.owner_id AND u.enabled
      WHERE ch.id=ANY(${channels.map((ch) => ch.id)}::uuid[]) AND ch.enabled ORDER BY ch.id
      ON CONFLICT(dedup_key) DO NOTHING RETURNING id
    )
    INSERT INTO outbox_jobs(id,dedup_key,kind,entity_id)
    SELECT gen_random_uuid(),'notify:' || id::text,'NOTIFY',id FROM notices RETURNING id
  `;
  return inserted.length;
}
