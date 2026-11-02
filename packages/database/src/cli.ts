import { migrate } from './migrate.js';
import { closeDatabase } from './index.js';
try {
  await migrate();
  console.log('Database migrations applied');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
