import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.SERVICE_NAME ?? 'financial-radar' },
  redact: {
    paths: [
      'password',
      'token',
      'secret',
      'authorization',
      'cookie',
      '*.password',
      '*.token',
      '*.secret',
      '*.authorization',
      '*.cookie',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
});
export const createLogger = (name: string) => logger.child({ module: name });
export function percentiles(values: number[]) {
  const v = values
    .filter(Number.isFinite)
    .filter((x) => x >= 0)
    .sort((a, b) => a - b);
  const q = (p: number) =>
    v.length ? (v[Math.max(0, Math.ceil(p * v.length) - 1)] ?? null) : null;
  return { count: v.length, p50: q(0.5), p95: q(0.95) };
}
