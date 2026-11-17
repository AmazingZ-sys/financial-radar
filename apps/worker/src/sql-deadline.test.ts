import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import { assertSqlDeadline, withSqlDeadline } from './sql-deadline.js';

function fakeTransaction(
  run: (text: string, args: unknown[]) => Promise<unknown> = async () => [],
) {
  const executed: { text: string; args: unknown[] }[] = [];
  const pending = (text: string, args: unknown[]) => {
    const query = {
      text,
      args,
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        executed.push({ text, args });
        return run(text, args).then(resolve, reject);
      },
      values() {
        return this;
      },
    };
    return query;
  };
  const raw = Object.assign(
    (strings: TemplateStringsArray | string, ...args: unknown[]) =>
      typeof strings === 'string' ? { identifier: strings } : pending(strings.join('?'), args),
    {
      json: (value: unknown) => ({ json: value }),
      unsafe: (text: string, args: unknown[] = []) => pending(text, args),
    },
  ) as unknown as TransactionSql;
  return { raw, executed };
}

describe('absolute SQL deadlines', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects expired or invalid budgets with the SQL cancellation code', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    for (const deadline of [100, 99, NaN, Infinity])
      expect(() => assertSqlDeadline(deadline)).toThrow(expect.objectContaining({ code: '57014' }));
  });

  it('preserves lazy queries and helpers, and decreases each remaining statement budget', async () => {
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const { raw, executed } = fakeTransaction(async (text) => {
      if (text === 'FIRST') clock = 40;
      return [];
    });
    await withSqlDeadline(raw, 100, async (tx) => {
      const first = tx`FIRST`;
      const fragment = tx`FRAGMENT`;
      expect(executed).toHaveLength(1); // Only scope initialization has run.
      expect(tx('column')).toEqual({ identifier: 'column' });
      expect(tx.json({ a: 1 })).toEqual({ json: { a: 1 } });
      await first.values();
      await tx`SECOND ${fragment}`;
      await tx.unsafe('THIRD');
    });
    expect(executed.map((query) => query.text)).toEqual([
      "SELECT set_config('transaction_timeout','0',true)",
      "SELECT set_config('statement_timeout',?,true),set_config('lock_timeout',?,true)",
      'FIRST',
      "SELECT set_config('statement_timeout',?,true),set_config('lock_timeout',?,true)",
      'SECOND ?',
      "SELECT set_config('statement_timeout',?,true),set_config('lock_timeout',?,true)",
      'THIRD',
    ]);
    expect(
      executed
        .filter((query) => query.text.includes('statement_timeout'))
        .map((query) => query.args),
    ).toEqual([
      ['100ms', '100ms'],
      ['60ms', '60ms'],
      ['60ms', '60ms'],
    ]);
  });

  it('checks the budget after the callback before allowing commit, and reuses nested scopes', async () => {
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const { raw, executed } = fakeTransaction();
    await expect(
      withSqlDeadline(raw, 100, async (tx) => {
        await withSqlDeadline(tx, 100, async (nested) => {
          expect(nested).toBe(tx);
          await nested`ONE`;
        });
        clock = 100;
      }),
    ).rejects.toMatchObject({ code: '57014' });
    expect(executed.filter((query) => query.text.includes('transaction_timeout'))).toHaveLength(1);
  });

  it('drains started work and cancels queued queries before a failing callback can return', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const failure = new Error('query failed');
    const { raw, executed } = fakeTransaction(async (text) => {
      if (text === 'FAIL') throw failure;
      return [];
    });
    await expect(
      withSqlDeadline(raw, 100, async (tx) => {
        await Promise.all([tx`FAIL`, tx`MUST NOT WRITE`]);
      }),
    ).rejects.toBe(failure);
    expect(executed.some((query) => query.text === 'MUST NOT WRITE')).toBe(false);

    const second = fakeTransaction();
    await withSqlDeadline(second.raw, 100, async (tx) => {
      tx`STARTED`.execute();
    });
    expect(second.executed.at(-1)?.text).toBe('STARTED');
  });
});
