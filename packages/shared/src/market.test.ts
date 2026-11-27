import { describe, expect, it } from 'vitest';
import { calculateChangePct } from './market.js';

describe('calculateChangePct', () => {
  it('returns the signed percentage move', () => {
    expect(calculateChangePct(110, 100)).toBe(10);
    expect(calculateChangePct(90, 100)).toBe(-10);
  });

  it('keeps unavailable and zero baselines explicitly unknown', () => {
    expect(calculateChangePct(100, null)).toBeNull();
    expect(calculateChangePct(100, undefined)).toBeNull();
    expect(calculateChangePct(100, 0)).toBeNull();
    expect(calculateChangePct(Number.NaN, 100)).toBeNull();
    expect(calculateChangePct(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
