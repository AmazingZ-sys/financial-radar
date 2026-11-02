import { migrate } from '@radar/database/migrate';
import { closeDatabase } from '@radar/database';
try {
  await migrate();
  console.info('Database migrations applied');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
