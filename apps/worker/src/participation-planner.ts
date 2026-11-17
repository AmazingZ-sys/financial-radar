import {
  DEFAULT_HISTORY_DETECTION,
  detectParticipationWindow,
  type ProjectObservation,
} from '@radar/signals';

/** Scheduling only: the unchanged detector decides eligibility and signal keys. */
export function nextParticipationCheck(
  observation: ProjectObservation | null,
  at: string,
  handled = false,
): string | null {
  if (!observation) return null;
  const clock = Date.parse(at);
  if (!Number.isFinite(clock)) throw new Error('窗口检测时钟无效');
  const end = Date.parse(observation.endsAt ?? '');
  if (!Number.isFinite(end)) return null;
  // Ask the detector at a clock where all temporal prerequisites could be met.
  // Invalid/revoked terms remain ineligible, even for a future scheduled check.
  const eligibleAt = Math.max(
    clock,
    end,
    Date.parse(observation.availableAt),
    Date.parse(observation.observedAt),
  );
  if (
    !Number.isFinite(eligibleAt) ||
    !detectParticipationWindow(observation, new Date(eligibleAt).toISOString()).length
  )
    return null;
  const opening = Math.max(
    end - DEFAULT_HISTORY_DETECTION.windowEndingSeconds * 1000,
    observation.startsAt ? Date.parse(observation.startsAt) : -Infinity,
    Date.parse(observation.availableAt),
    Date.parse(observation.observedAt),
  );
  if (clock < opening) return new Date(Math.min(opening, end)).toISOString();
  if (!handled) return at;
  return clock < end ? new Date(end).toISOString() : null;
}

export function earliestCheck(...values: (string | null)[]) {
  const times = values.filter((value): value is string => value !== null);
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}
