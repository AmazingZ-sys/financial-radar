import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPeriodicTask } from './periodic-task.js';

describe('managed periodic tasks', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not overlap runs and drains in-flight work after timers stop', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(() => pending);
    const task = startPeriodicTask(run, vi.fn());
    await vi.advanceTimersByTimeAsync(45000);
    expect(run).toHaveBeenCalledTimes(1);
    task.stop();
    let drained = false;
    const drain = task.drain().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(drained).toBe(false);
    finish();
    await drain;
    expect(drained).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a failure and retries on the next tick', async () => {
    vi.useFakeTimers();
    const failure = new Error('temporary failure');
    const run = vi.fn(async () => {}).mockRejectedValueOnce(failure);
    const onError = vi.fn();
    const task = startPeriodicTask(run, onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    await vi.advanceTimersByTimeAsync(15000);
    expect(run).toHaveBeenCalledTimes(2);
    task.stop();
    await task.drain();
  });
});
