import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_X_POLL_STATE,
  XRequestDeferredError,
  extendXPollState,
  nextXPollState,
} from './x-scheduling.js';

const now = new Date('2026-11-05T10:00:00.000Z');
const interval = { pollIntervalMinSeconds: 600, pollIntervalMaxSeconds: 1200 };

describe('durable X request schedule policy', () => {
  it('uses the closed configured interval including both endpoints', () => {
    for (const delay of [600, 1200]) {
      const pick = vi.fn(() => delay);
      expect(nextXPollState(interval, DEFAULT_X_POLL_STATE, now, pick)).toEqual({
        lastRequestAt: now.toISOString(),
        nextRequestAt: new Date(now.getTime() + delay * 1000).toISOString(),
        lastDelaySeconds: delay,
      });
      expect(pick).toHaveBeenCalledWith(600, 1201);
    }
    expect(
      nextXPollState(
        { pollIntervalMinSeconds: 86400, pollIntervalMaxSeconds: 86400 },
        DEFAULT_X_POLL_STATE,
        now,
      ).nextRequestAt,
    ).toBe('2026-11-06T10:00:00.000Z');
  });
  it('retains the existing deadline through repeated jobs and configuration changes', () => {
    const previous = nextXPollState(interval, DEFAULT_X_POLL_STATE, now, () => 900);
    const pick = vi.fn(() => 300);
    let problem: unknown;
    try {
      nextXPollState(
        { pollIntervalMinSeconds: 300, pollIntervalMaxSeconds: 300 },
        previous,
        new Date('2026-11-05T10:01:00.000Z'),
        pick,
      );
    } catch (error) {
      problem = error;
    }
    expect(problem).toBeInstanceOf(XRequestDeferredError);
    expect(problem).toMatchObject({
      message: 'X_REQUEST_NOT_DUE',
      retryAt: new Date(previous.nextRequestAt!),
    });
    expect(pick).not.toHaveBeenCalled();
    expect(
      nextXPollState(interval, previous, new Date(previous.nextRequestAt!), () => 600),
    ).toMatchObject({ lastRequestAt: previous.nextRequestAt, lastDelaySeconds: 600 });
  });
  it('extends rate-limit cooldown without shortening the schedule or changing the sampled delay', () => {
    const previous = nextXPollState(interval, DEFAULT_X_POLL_STATE, now, () => 900);
    expect(extendXPollState(previous, '2026-11-05T10:02:00.000Z')).toEqual(previous);
    expect(extendXPollState(previous, '2026-11-05T10:45:00.000Z')).toEqual({
      ...previous,
      nextRequestAt: '2026-11-05T10:45:00.000Z',
    });
    expect(extendXPollState(DEFAULT_X_POLL_STATE, '2026-11-05T10:45:00.000Z')).toEqual({
      ...DEFAULT_X_POLL_STATE,
      nextRequestAt: '2026-11-05T10:45:00.000Z',
    });
    expect(() => extendXPollState(previous, 'invalid')).toThrow();
  });
  it('rejects invalid intervals, clocks and random samples before creating a reservation', () => {
    expect(() =>
      nextXPollState(
        { pollIntervalMinSeconds: 1200, pollIntervalMaxSeconds: 600 },
        DEFAULT_X_POLL_STATE,
        now,
      ),
    ).toThrow();
    expect(() => nextXPollState(interval, DEFAULT_X_POLL_STATE, new Date(NaN))).toThrow();
    for (const sample of [599, 1201, 600.5, NaN])
      expect(() => nextXPollState(interval, DEFAULT_X_POLL_STATE, now, () => sample)).toThrow();
  });
});
