export type ErrorClassification = 'AUTH' | 'RATE_LIMIT' | 'TRANSIENT' | 'SCHEMA' | 'PERMANENT';
export class ConnectorError extends Error {
  constructor(
    message: string,
    public classification: ErrorClassification,
    public retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}
export type RetryPolicy = {
  attempts: number;
  timeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
};
const defaults: RetryPolicy = {
  attempts: 3,
  timeoutMs: 10_000,
  baseDelayMs: 300,
  maxDelayMs: 30_000,
};
export function classifyStatus(status: number): ErrorClassification {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429 || status === 418) return 'RATE_LIMIT';
  return status >= 500 ? 'TRANSIENT' : 'PERMANENT';
}
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Math.max(0, Date.parse(value) - now) || 0;
}
export class ResilientHttp {
  private failures = 0;
  private openUntil = 0;
  private lastRequestAt = 0;
  constructor(
    private fetcher: typeof fetch = fetch,
    private sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private now = () => Date.now(),
    private intervalMs = 100,
  ) {}
  async request(
    url: string,
    init: RequestInit = {},
    policy: Partial<RetryPolicy> = {},
  ): Promise<Response> {
    if (this.now() < this.openUntil)
      throw new ConnectorError(
        '数据源熔断，等待半开探测',
        'TRANSIENT',
        this.openUntil - this.now(),
      );
    const p = { ...defaults, ...policy };
    for (let attempt = 0; attempt < p.attempts; attempt++) {
      const gap = this.intervalMs - (this.now() - this.lastRequestAt);
      if (gap > 0) await this.sleep(gap);
      this.lastRequestAt = this.now();
      try {
        const response = await this.fetcher(url, {
          ...init,
          signal: AbortSignal.timeout(p.timeoutMs),
          redirect: 'error',
        });
        if (!response.ok && response.status !== 304) {
          throw new ConnectorError(
            `来源 HTTP ${response.status}`,
            classifyStatus(response.status),
            retryAfterMs(response.headers.get('retry-after'), this.now()),
          );
        }
        this.failures = 0;
        this.openUntil = 0;
        return response;
      } catch (error) {
        const problem =
          error instanceof ConnectorError
            ? error
            : new ConnectorError('数据源网络错误或超时', 'TRANSIENT');
        this.failures++;
        if (problem.classification === 'RATE_LIMIT' && problem.retryAfterMs > 0)
          this.openUntil = Math.max(this.openUntil, this.now() + problem.retryAfterMs);
        if (this.failures >= 5) this.openUntil = this.now() + 60_000;
        if (
          !['TRANSIENT', 'RATE_LIMIT'].includes(problem.classification) ||
          attempt + 1 === p.attempts
        )
          throw problem;
        const delay = Math.max(
          problem.retryAfterMs,
          Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** attempt) + Math.floor(Math.random() * 100),
        );
        // Long platform cooldowns are left to the persisted job retry, never bypassed by truncating Retry-After.
        if (delay > p.maxDelayMs)
          throw new ConnectorError(problem.message, problem.classification, delay);
        await this.sleep(delay);
      }
    }
    throw new ConnectorError('来源重试耗尽', 'TRANSIENT');
  }
  circuitState() {
    return { failures: this.failures, openUntil: this.openUntil };
  }
}
