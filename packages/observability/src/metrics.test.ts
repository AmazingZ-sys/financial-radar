import { expect, it } from 'vitest';
import { percentiles } from './index.js';
it('uses measured nonnegative samples for percentiles and unknowns for empty windows', () => {
  expect(percentiles([])).toEqual({ count: 0, p50: null, p95: null });
  expect(percentiles([100, 20, 90, 10, NaN, -1])).toEqual({ count: 4, p50: 20, p95: 100 });
});
