import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from '@radar/config';
import * as schema from './schema.js';
export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 5,
  onnotice: () => {},
});
// Drizzle changes its client JSON serializers to pass-through. Keep its client
// separate so SQL repositories can safely use postgres.js sql.json().
const ormClient = postgres(config.databaseUrl, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 5,
  onnotice: () => {},
});
export const db = drizzle(ormClient, { schema });
export async function closeDatabase() {
  await Promise.all([sql.end({ timeout: 5 }), ormClient.end({ timeout: 5 })]);
}
export { schema };
export * from './password.js';
export * from './seed.js';
export * from './integrations.js';
