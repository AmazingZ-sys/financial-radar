/**
 * Calculate a percentage move against a prior market observation.
 *
 * A percentage is undefined when either sample is unavailable or the prior
 * value is zero.  Callers can then render an explicit unknown value instead
 * of manufacturing an infinite or misleading change.
 */
export function calculateChangePct(
  current: number,
  previous: number | null | undefined,
): number | null {
  if (
    !Number.isFinite(current) ||
    previous === null ||
    previous === undefined ||
    !Number.isFinite(previous) ||
    previous === 0
  )
    return null;
  return ((current - previous) / previous) * 100;
}
