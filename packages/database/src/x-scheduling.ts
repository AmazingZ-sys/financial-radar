import { randomInt } from 'node:crypto';
import { XPollStateSchema, type XConfig, type XPollState } from '@radar/shared';

export const DEFAULT_X_POLL_STATE: XPollState = {
  lastRequestAt: null,
  nextRequestAt: null,
  lastDelaySeconds: null,
};

export class XRequestDeferredError extends Error {
  constructor(public readonly retryAt: Date) {
    super('X_REQUEST_NOT_DUE');
    this.name = 'XRequestDeferredError';
  }
}

/** The caller must hold the integrations:x lock before using this reservation. */
export function nextXPollState(
  interval: Pick<XConfig, 'pollIntervalMinSeconds' | 'pollIntervalMaxSeconds'>,
  previous: XPollState,
  now: Date,
  pick: (minimum: number, exclusiveMaximum: number) => number = randomInt,
): XPollState {
  const current = XPollStateSchema.parse(previous);
  if (current.nextRequestAt && Date.parse(current.nextRequestAt) > now.getTime())
    throw new XRequestDeferredError(new Date(current.nextRequestAt));
  const { pollIntervalMinSeconds: minimum, pollIntervalMaxSeconds: maximum } = interval;
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 300 ||
    maximum > 86400 ||
    minimum > maximum ||
    !Number.isFinite(now.getTime())
  )
    throw new Error('X 采集间隔或时钟无效');
  const delay = pick(minimum, maximum + 1);
  if (!Number.isInteger(delay) || delay < minimum || delay > maximum)
    throw new Error('X 随机采集间隔超出配置区间');
  return {
    lastRequestAt: now.toISOString(),
    nextRequestAt: new Date(now.getTime() + delay * 1000).toISOString(),
    lastDelaySeconds: delay,
  };
}

/** A response cooldown can extend the durable schedule, never shorten it. */
export function extendXPollState(previous: XPollState, until: string): XPollState {
  const current = XPollStateSchema.parse(previous);
  const nextRequestAt = XPollStateSchema.shape.nextRequestAt.unwrap().parse(until);
  if (current.nextRequestAt && Date.parse(current.nextRequestAt) >= Date.parse(nextRequestAt))
    return current;
  return { ...current, nextRequestAt };
}
