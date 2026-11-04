import { afterEach, describe, expect, it, vi } from 'vitest';

type TestJob = { name: string; data: { entityId: string; outboxId: string } };
const mocks = vi.hoisted(() => ({
  queues: new Map<string, { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>(),
  workers: new Map<
    string,
    {
      process: (job: TestJob) => Promise<void>;
      concurrency: number;
      close: ReturnType<typeof vi.fn>;
    }
  >(),
  sql: vi.fn(async () => []),
  analyzeEvent: vi.fn(async (_id: string) => {}),
  sendNotification: vi.fn(async (_id: string) => {}),
  claimOutboxJobs: vi.fn(async () => [
    { id: 'analysis-outbox', kind: 'ANALYZE', entity_id: 'event' },
    { id: 'notify-outbox', kind: 'NOTIFY', entity_id: 'notification' },
  ]),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn(async () => {});
    close = vi.fn(async () => {});
    constructor(name: string) {
      mocks.queues.set(name, this);
    }
    async getJobCounts() {
      return { waiting: 0, active: 0, failed: 0, delayed: 0 };
    }
    async getJobSchedulers() {
      return [];
    }
  },
  Worker: class {
    close = vi.fn(async () => {});
    constructor(
      public name: string,
      process: (job: TestJob) => Promise<void>,
      options: { concurrency: number },
    ) {
      mocks.workers.set(name, { process, concurrency: options.concurrency, close: this.close });
    }
    on() {}
  },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    on() {}
    async set() {
      return 'OK';
    }
    async quit() {}
  },
}));
vi.mock('@radar/config', () => ({ config: { redisUrl: 'redis://test', dataMode: 'fixture' } }));
vi.mock('@radar/database', () => ({ sql: mocks.sql }));
vi.mock('@radar/observability', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('./pipeline.js', () => ({
  initializeSources: vi.fn(),
  registry: { list: () => [], shutdown: vi.fn() },
  runIngestion: vi.fn(),
  scanParticipationWindows: vi.fn(),
  synchronizeCustomSources: vi.fn(),
  synchronizeConfiguredSources: vi.fn(),
}));
vi.mock('./jobs.js', () => ({
  analyzeEvent: mocks.analyzeEvent,
  sendNotification: mocks.sendNotification,
  recoverLeases: vi.fn(),
  runOutboxOnce: vi.fn(),
  heartbeat: vi.fn(async () => ({})),
  DeferredWorkError: class extends Error {},
  claimOutboxJobs: mocks.claimOutboxJobs,
  extendAnalysisOutboxLease: vi.fn(),
}));

describe('AI queue isolation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('routes AI separately, drains legacy jobs, and delivers notifications while AI slots wait', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockReturnValue(process);
    await import('./index.js');
    const coreQueue = mocks.queues.get('financial-radar')!;
    const aiQueue = mocks.queues.get('financial-radar-ai')!;
    const coreWorker = mocks.workers.get('financial-radar')!;
    const aiWorker = mocks.workers.get('financial-radar-ai')!;
    expect(coreQueue.add).toHaveBeenCalledWith(
      'NOTIFY',
      { outboxId: 'notify-outbox', entityId: 'notification' },
      expect.objectContaining({ jobId: 'outbox-notify-outbox' }),
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      'ANALYZE',
      { outboxId: 'analysis-outbox', entityId: 'event' },
      expect.objectContaining({ jobId: 'outbox-analysis-outbox' }),
    );
    expect(coreWorker.concurrency).toBe(4);
    expect(aiWorker.concurrency).toBe(2);

    await coreWorker.process({
      name: 'ANALYZE',
      data: { outboxId: 'legacy-outbox', entityId: 'legacy-event' },
    });
    expect(aiQueue.add).toHaveBeenCalledWith(
      'ANALYZE',
      { outboxId: 'legacy-outbox', entityId: 'legacy-event' },
      expect.objectContaining({ jobId: 'outbox-legacy-outbox' }),
    );
    expect(mocks.analyzeEvent).not.toHaveBeenCalled();
    // Transferring a legacy Redis job must not mark its durable outbox complete.
    expect(mocks.sql).toHaveBeenCalledTimes(1); // Initial schedule source query only.

    let finishAI: (() => void) | undefined;
    const pendingAI = new Promise<void>((resolve) => {
      finishAI = resolve;
    });
    mocks.analyzeEvent.mockImplementation(async () => pendingAI);
    const aiJobs = [1, 2].map((index) =>
      aiWorker.process({
        name: 'ANALYZE',
        data: { entityId: `event-${index}`, outboxId: `outbox-${index}` },
      }),
    );
    await coreWorker.process({
      name: 'NOTIFY',
      data: { entityId: 'urgent-notification', outboxId: 'urgent-outbox' },
    });
    expect(mocks.analyzeEvent).toHaveBeenCalledTimes(2);
    expect(mocks.sendNotification).toHaveBeenCalledWith('urgent-notification');
    finishAI!();
    await Promise.all(aiJobs);
  });
});
