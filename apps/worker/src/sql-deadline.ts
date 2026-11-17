import type { PendingQuery, Row, TransactionSql } from 'postgres';

/** A normal SQL cancellation leaves the session available for ROLLBACK. */
export function assertSqlDeadline(deadline: number) {
  if (!Number.isFinite(deadline) || Date.now() >= deadline)
    throw Object.assign(new Error('SQL processing deadline exceeded'), { code: '57014' });
}

const scopes = new WeakMap<TransactionSql, { deadline: number; raw: TransactionSql }>();

/** Keep postgres.js fragments and helpers intact, and apply the budget when a
 * lazy query is executed. Bounded business transactions do not stream results. */
export async function withSqlDeadline<T>(
  transaction: TransactionSql,
  deadline: number,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const parent = scopes.get(transaction);
  deadline = Math.min(deadline, parent?.deadline ?? Infinity);
  assertSqlDeadline(deadline);
  if (parent?.deadline === deadline) {
    const result = await run(transaction);
    assertSqlDeadline(deadline);
    return result;
  }
  const raw = parent?.raw ?? transaction;
  // transaction_timeout is FATAL: unlike statement/lock cancellation it closes
  // the session, preventing safe rollback on the reserved connection.
  await raw`SELECT set_config('transaction_timeout','0',true)`;
  assertSqlDeadline(deadline);
  let tail: Promise<void> = Promise.resolve();
  let failed: unknown;
  const wrap = (query: PendingQuery<Row[]>) => {
    let execution: Promise<unknown> | undefined;
    const start = () => {
      if (!execution) {
        execution = tail.then(async () => {
          if (failed) throw failed;
          assertSqlDeadline(deadline);
          const remaining = Math.max(1, Math.floor(deadline - Date.now()));
          await raw`SELECT set_config('statement_timeout',${`${remaining}ms`},true),set_config('lock_timeout',${`${Math.min(100, remaining)}ms`},true)`;
          assertSqlDeadline(deadline);
          return await query;
        });
        // Keep concurrently awaited queries in this scope ordered together with
        // their timeout settings. Remember errors even after execute() is used.
        tail = execution.then(
          () => undefined,
          (error: unknown) => {
            failed ??= error;
          },
        );
      }
      return execution;
    };
    const proxy = new Proxy(query, {
      get(target, property) {
        if (property === 'then' || property === 'catch' || property === 'finally')
          return (...args: unknown[]) => {
            const promise = start();
            return Reflect.apply(promise[property], promise, args);
          };
        if (property === 'execute')
          return () => {
            start();
            return proxy;
          };
        if (['cursor', 'forEach', 'readable', 'writable'].includes(String(property)))
          return () => {
            throw new Error('Streaming is unsupported in a bounded SQL transaction');
          };
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  };
  const tx = new Proxy(raw, {
    get(target, property, receiver) {
      if (property === 'unsafe' || property === 'file')
        return (...args: unknown[]) =>
          wrap(Reflect.apply(target[property], target, args) as PendingQuery<Row[]>);
      return Reflect.get(target, property, receiver);
    },
    apply(target, thisArg, args: unknown[]) {
      const result: unknown = Reflect.apply(target, thisArg, args);
      // Plain sql('identifier') / sql([...]) calls return interpolation helpers.
      const first = args[0] as { raw?: unknown } | undefined;
      return first && Array.isArray(first.raw) ? wrap(result as PendingQuery<Row[]>) : result;
    },
  });
  scopes.set(tx, { deadline, raw });
  let result: T | undefined;
  let runFailed = false;
  let runError: unknown;
  try {
    result = await run(tx);
  } catch (error) {
    runFailed = true;
    runError = error;
  }
  // Promise.all may reject before another queued query has settled. Finish
  // draining before the caller can roll back or release this connection.
  await tail;
  if (runFailed) throw runError;
  if (failed) throw failed;
  assertSqlDeadline(deadline);
  return result as T;
}
