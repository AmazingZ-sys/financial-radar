import { initializeCalendarFixtures } from './calendar-routes.js';
import { serve } from '@hono/node-server';
import { config } from '@radar/config';
import { closeDatabase } from '@radar/database';
import { createLogger } from '@radar/observability';
import { createApp } from './app.js';
import { redis } from './security.js';
export { createApp } from './app.js';
const logger = createLogger('api');
await initializeCalendarFixtures();
const server = serve({ fetch: createApp().fetch, port: config.port });
logger.info({ port: config.port, version: config.version }, 'API started');
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const timer = setTimeout(() => process.exit(1), 10000);
  timer.unref();
  await Promise.allSettled([closeDatabase(), redis.quit()]);
  clearTimeout(timer);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
