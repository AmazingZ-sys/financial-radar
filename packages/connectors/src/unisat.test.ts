import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UniSatBrc20Connector } from './live.js';
import type { Cursor } from './types.js';

const now = Date.parse('2026-11-04T06:00:00.000Z');
const nowSeconds = now / 1000;
const sevenDays = 7 * 24 * 60 * 60;
type Row = Record<string, unknown> & { inscriptionId: string };

function row(id = 'recenti0', changes: Record<string, unknown> = {}): Row {
  return {
    ticker: 'TEST',
    inscriptionId: id,
    deployTime: nowSeconds - 3600,
    minted: '25.0000',
    max: '100',
    holdersCount: 12,
    ...changes,
  };
}

function source(rows: () => { incomplete: Row[]; completed?: Row[] }, includeTotal = true) {
  const connector = new UniSatBrc20Connector('synthetic-unit-key');
  let height = 900_000;
  const request = vi.fn(async (input: string) => {
    const url = new URL(input);
    const current = rows();
    const list =
      url.searchParams.get('complete') === 'yes' ? (current.completed ?? []) : current.incomplete;
    const start = Number(url.searchParams.get('start'));
    const limit = Number(url.searchParams.get('limit'));
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          height: height++,
          ...(includeTotal ? { total: list.length } : {}),
          detail: list.slice(start, start + limit),
        },
      }),
    );
  });
  // Keep these tests about connector policy, independent of real HTTP pacing.
  (connector as unknown as { http: { request: typeof request } }).http = { request };
  return { connector, request };
}

describe('UniSat recent deployment discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('preserves deployment and observation times without claiming source publication', async () => {
    const { connector } = source(() => ({ incomplete: [row()] }));
    const fetched = await connector.fetch();
    const raw = fetched.items[0]!;
    const event = connector.normalize(raw);
    expect(event.title).toBe('BRC-20 状态更新 · TEST');
    expect(event.eventType).toBe('TOKEN_STATE_SNAPSHOT');
    expect(raw.publishedAt).toBeNull();
    expect(event.sourcePublishedAt).toBeNull();
    expect(event.eventOccurredAt).toBe(new Date(now - 3600_000).toISOString());
    expect(raw.payload.observedAt).toBe(new Date(now).toISOString());
    expect(event.metrics).toMatchObject({
      mintProgress: 25,
      minted: '25.0',
      max: '100.0',
      holders: 12,
      uniqueParticipants: null,
      observedAt: new Date(now).toISOString(),
    });
    expect(event.project?.assetKey).toBe('bitcoin:brc20:test');
    expect(event.metrics).not.toHaveProperty('participants');
    expect(event.identity).toContain(':snapshot:');
    expect(raw.externalId).not.toContain(new Date(now).toISOString());
  });

  it('rejects old, unknown, invalid and future deployments, with an inclusive seven-day boundary', async () => {
    const unknown = row('unknowni0');
    delete unknown.deployTime;
    const { connector } = source(() => ({
      incomplete: [
        row('ancienti0', { deployTime: 1_678_340_348 }),
        row('expiredi0', { deployTime: nowSeconds - sevenDays - 1 }),
        unknown,
        row('negativei0', { deployTime: -1 }),
        row('zeroi0', { deployTime: 0 }),
        row('rangei0', { deployTime: 1e20 }),
        row('futurei0', { deployTime: nowSeconds + 1 }),
        row('boundaryi0', { deployTime: nowSeconds - sevenDays }),
        row('currenti0', { deployTime: nowSeconds }),
      ],
    }));
    const fetched = await connector.fetch();
    expect(fetched.items.map((raw) => raw.payload.inscriptionId).sort()).toEqual([
      'boundaryi0',
      'currenti0',
    ]);
    expect(Object.keys(fetched.cursor.snapshots as object).sort()).toEqual([
      'boundaryi0',
      'currenti0',
    ]);
  });

  it.each(['ascending', 'descending'])(
    'finds recent deployments at either end of %s deployment ordering',
    async (order) => {
      const incomplete = Array.from({ length: 90 }, (_, index) =>
        row(`incomplete-${index}i0`, {
          ticker: `I${index}`,
          deployTime: index < 80 ? 1_678_340_348 + index : nowSeconds - 100 + index,
        }),
      );
      const completed = Array.from({ length: 40 }, (_, index) =>
        row(`completed-${index}i0`, {
          ticker: `C${index}`,
          deployTime: index < 35 ? 1_678_340_348 + index : nowSeconds - 100 + index,
        }),
      );
      if (order === 'descending') {
        incomplete.reverse();
        completed.reverse();
      }
      const { connector, request } = source(() => ({ incomplete, completed }));
      const fetched = await connector.fetch();
      expect(fetched.items).toHaveLength(15);
      expect(new Set(fetched.items.map((raw) => raw.payload.inscriptionId)).size).toBe(15);
      expect(request).toHaveBeenCalledTimes(4);
      const urls = request.mock.calls.map(([input]) => new URL(input));
      expect(urls.every((url) => url.searchParams.get('sort') === 'deploy')).toBe(true);
      expect(
        urls.map((url) => Number(url.searchParams.get('start'))).sort((a, b) => a - b),
      ).toEqual([0, 0, 20, 40]);
    },
  );

  it('retains the newest 50 unfinished and 20 completed candidates after merging pages', async () => {
    const incomplete = Array.from({ length: 120 }, (_, index) =>
      row(`incomplete-${index}i0`, { ticker: `I${index}`, deployTime: nowSeconds - 1000 + index }),
    );
    const completed = Array.from({ length: 70 }, (_, index) =>
      row(`completed-${index}i0`, { ticker: `C${index}`, deployTime: nowSeconds - 1000 + index }),
    );
    const { connector } = source(() => ({ incomplete, completed }));
    const fetched = await connector.fetch();
    expect(fetched.items).toHaveLength(70);
    const ids = fetched.items.map((raw) => String(raw.payload.inscriptionId));
    expect(ids).toContain('incomplete-70i0');
    expect(ids).not.toContain('incomplete-69i0');
    expect(ids).toContain('completed-50i0');
    expect(ids).not.toContain('completed-49i0');
  });

  it('deduplicates overlapping pages and safely limits missing-total responses to the head', async () => {
    const list = Array.from({ length: 51 }, (_, index) =>
      row(`overlap-${index}i0`, { ticker: `T${index}`, deployTime: nowSeconds - 1000 + index }),
    );
    const completeSource = source(() => ({ incomplete: list }));
    const merged = await completeSource.connector.fetch();
    expect(merged.items).toHaveLength(50);
    expect(new Set(merged.items.map((raw) => raw.payload.inscriptionId)).size).toBe(50);
    const headOnly = source(() => ({ incomplete: list }), false);
    const bounded = await headOnly.connector.fetch();
    expect(headOnly.request).toHaveBeenCalledTimes(2);
    expect(bounded.items).toHaveLength(50);
    expect(bounded.items.some((raw) => raw.payload.inscriptionId === 'overlap-50i0')).toBe(false);
  });

  it('uses deployment block time when the API provides that field', async () => {
    const blockTimeRow = row('blocktimei0', { deployBlocktime: nowSeconds - 600 });
    delete blockTimeRow.deployTime;
    const { connector } = source(() => ({ incomplete: [blockTimeRow] }));
    const fetched = await connector.fetch();
    expect(fetched.items).toHaveLength(1);
    expect(connector.normalize(fetched.items[0]!).eventOccurredAt).toBe(
      new Date(now - 600_000).toISOString(),
    );
  });

  it('suppresses unchanged states across polling and connector recreation despite index height changes', async () => {
    const rows = () => ({ incomplete: [row()] });
    const firstSource = source(rows);
    const first = await firstSource.connector.fetch();
    vi.setSystemTime(now + 120_000);
    const second = await firstSource.connector.fetch(first.cursor);
    expect(second.items).toEqual([]);
    const restarted = source(rows);
    const third = await restarted.connector.fetch(second.cursor);
    expect(third.items).toEqual([]);
    expect(third.cursor).toMatchObject({ version: 2, batchSequence: 3 });
  });

  it('treats equivalent decimals and unused metadata as the same observed state', async () => {
    let current = row();
    const { connector } = source(() => ({ incomplete: [current] }));
    const first = await connector.fetch();
    current = row('recenti0', {
      minted: '00025.000000',
      max: '00100.0000',
      providerComment: 'irrelevant metadata changed',
    });
    const second = await connector.fetch(first.cursor);
    expect(second.items).toEqual([]);
  });

  it('carries the last confirmed flat state into a changed snapshot after restart', async () => {
    let minted = '25';
    const rows = () => ({ incomplete: [row('recenti0', { minted })] });
    const { connector } = source(rows);
    const first = await connector.fetch();
    const firstRaw = first.items[0]!;
    expect(firstRaw.payload.previousStateFingerprint).toBeNull();
    expect(firstRaw.payload.previousStateObservedAt).toBeNull();
    vi.setSystemTime(now + 120_000);
    const flat = await connector.fetch(first.cursor);
    vi.setSystemTime(now + 240_000);
    const stillFlat = await connector.fetch(flat.cursor);
    expect(flat.items).toEqual([]);
    expect(stillFlat.items).toEqual([]);
    const lastConfirmedAt = new Date(now + 240_000).toISOString();
    const saved = JSON.parse(JSON.stringify(stillFlat.cursor)) as Cursor;
    expect(
      (saved.snapshots as Record<string, { lastSeenAt: string }>)['recenti0']?.lastSeenAt,
    ).toBe(lastConfirmedAt);

    vi.setSystemTime(now + 360_000);
    minted = '35';
    const restarted = source(rows).connector;
    const changed = await restarted.fetch(saved);
    const changedRaw = changed.items[0]!;
    expect(changedRaw.payload.stateFingerprint).not.toBe(firstRaw.payload.stateFingerprint);
    expect(changedRaw.payload.previousStateFingerprint).toBe(firstRaw.payload.stateFingerprint);
    expect(changedRaw.payload.previousStateObservedAt).toBe(lastConfirmedAt);
    expect(restarted.normalize(changedRaw).metrics).toMatchObject({
      samplingMode: 'state-changes',
      observedAt: new Date(now + 360_000).toISOString(),
      stateFingerprint: changedRaw.payload.stateFingerprint,
      previousStateFingerprint: firstRaw.payload.stateFingerprint,
      previousStateObservedAt: lastConfirmedAt,
    });
    expect(saved).toEqual(stillFlat.cursor);
  });

  it('preserves a real state change and A → B → A state reversion under one project', async () => {
    let holdersCount = 12;
    const { connector } = source(() => ({ incomplete: [row('recenti0', { holdersCount })] }));
    const first = await connector.fetch();
    holdersCount = 13;
    const second = await connector.fetch(first.cursor);
    holdersCount = 12;
    const reverted = await connector.fetch(second.cursor);
    expect(second.items).toHaveLength(1);
    expect(reverted.items).toHaveLength(1);
    expect(new Set([first, second, reverted].map((batch) => batch.items[0]!.externalId)).size).toBe(
      3,
    );
    expect(
      [first, second, reverted].map(
        (batch) => connector.normalize(batch.items[0]!).project?.assetKey,
      ),
    ).toEqual(Array(3).fill('bitcoin:brc20:test'));
  });

  it('produces deterministic retry identities without mutating the saved checkpoint', async () => {
    let minted = '25';
    const rows = () => ({ incomplete: [row('recenti0', { minted })] });
    const { connector } = source(rows);
    const first = await connector.fetch();
    const saved = JSON.parse(JSON.stringify(first.cursor)) as Cursor;
    minted = '35';
    const attempt = await connector.fetch(first.cursor);
    vi.setSystemTime(now + 120_000);
    const retry = await source(rows).connector.fetch(first.cursor);
    expect(attempt.items).toHaveLength(1);
    expect(retry.items[0]!.externalId).toBe(attempt.items[0]!.externalId);
    expect(retry.items[0]!.payload.observedAt).not.toBe(attempt.items[0]!.payload.observedAt);
    expect(first.cursor).toEqual(saved);
    expect(attempt.cursor).toMatchObject({ version: 2, batchSequence: 2 });
  });

  it('migrates legacy checkpoint metadata without using checkedAt as deployment evidence', async () => {
    const legacy: Cursor = {
      checkedAt: new Date(now).toISOString(),
      scope: 'latest-50-incomplete-plus-completed-tail-20',
    };
    const { connector } = source(() => ({
      incomplete: [row(), row('legacy-oldi0', { deployTime: 1_678_340_348 })],
    }));
    const fetched = await connector.fetch(legacy);
    expect(fetched.items).toHaveLength(1);
    expect(fetched.cursor).toMatchObject({ version: 2, batchSequence: 1 });
    expect(legacy).not.toHaveProperty('snapshots');
  });

  it('leaves the saved checkpoint untouched when a later page fails', async () => {
    const { connector, request } = source(() => ({
      incomplete: Array.from({ length: 60 }, (_, index) => row(`failure-${index}i0`)),
    }));
    const baseline = await connector.fetch();
    const saved = JSON.parse(JSON.stringify(baseline.cursor)) as Cursor;
    const fetchPage = request.getMockImplementation()!;
    request
      .mockImplementationOnce(fetchPage)
      .mockRejectedValueOnce(new Error('Synthetic page failure'));
    await expect(connector.fetch(baseline.cursor)).rejects.toThrow('Synthetic page failure');
    expect(baseline.cursor).toEqual(saved);
  });

  it('prunes expired checkpoint entries and bounds recently seen state to 2,000 entries', async () => {
    const snapshots = Object.fromEntries(
      Array.from({ length: 2005 }, (_, index) => [
        `cached-${index}i0`,
        {
          fingerprint: 'a'.repeat(64),
          lastSeenAt: new Date(now - 2005_000 + index * 1000).toISOString(),
          deployTime: index === 0 ? nowSeconds - sevenDays - 1 : nowSeconds - 3600,
        },
      ]),
    );
    const { connector } = source(() => ({ incomplete: [row()] }));
    const fetched = await connector.fetch({ version: 2, batchSequence: 40, snapshots });
    const retained = fetched.cursor.snapshots as Record<string, unknown>;
    expect(Object.keys(retained)).toHaveLength(2000);
    expect(retained).not.toHaveProperty('cached-0i0');
    expect(retained).toHaveProperty('recenti0');
    expect(fetched.cursor.batchSequence).toBe(41);
  });
});
