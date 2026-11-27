import { describe, expect, it } from 'vitest';
import { marketDigestWindow } from './market-digest.js';

describe('Beijing daily market reporting window', () => {
  it('opens at 10:00 exactly, with the previous local date across the year boundary', () => {
    expect(marketDigestWindow(new Date('2027-01-01T01:59:59.999Z'))).toBeNull();
    expect(marketDigestWindow(new Date('2027-01-01T02:00:00Z'))).toEqual({
      day: '2027-01-01',
      cutoff: '2027-01-01T02:00:00.000Z',
      dayStart: '2026-12-31T16:00:00.000Z',
      previousCutoff: '2026-12-31T02:00:00.000Z',
      previousStart: '2026-12-30T16:00:00.000Z',
    });
  });

  it('catches up only until local midnight and keeps the original cutoff', () => {
    expect(marketDigestWindow(new Date('2028-02-29T15:59:59.999Z'))?.cutoff).toBe(
      '2028-02-29T02:00:00.000Z',
    );
    expect(marketDigestWindow(new Date('2028-02-29T16:00:00Z'))).toBeNull();
  });
});
