/** Managed background work: one in-flight run, isolated failures, and an explicit drain. */
export function startPeriodicTask(
  run: () => Promise<unknown>,
  onError: (error: unknown) => void,
  intervalMs = 15000,
) {
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (stopped || active) return;
    active = Promise.resolve()
      .then(run)
      .then(() => undefined)
      .catch(onError)
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async drain() {
      await active;
    },
  };
}
