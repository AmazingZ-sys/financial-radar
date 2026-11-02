import { randomUUID } from 'node:crypto';
import { config } from '@radar/config';
import { sql, closeDatabase, hashPassword } from '@radar/database';
try {
  if (config.adminPassword === 'change-me-local-only')
    throw new Error(
      'Set a new ADMIN_PASSWORD in the server environment before resetting administrator credentials',
    );
  const passwordHash = await hashPassword(config.adminPassword);
  await sql.begin(async (tx) => {
    const account = (
      await tx`SELECT id FROM users WHERE email=${config.adminEmail.toLowerCase()} FOR UPDATE`
    )[0];
    if (!account) throw new Error('Administrator does not exist; run migrations first');
    await tx`UPDATE users SET password_hash=${passwordHash} WHERE id=${account.id}`;
    await tx`DELETE FROM user_sessions WHERE user_id=${account.id}`;
    await tx`INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,details) VALUES(${randomUUID()},${account.id},'RESET_PASSWORD','user',${String(account.id)},'{"sessionsRevoked":true}'::jsonb)`;
  });
  console.log('Administrator password updated; all administrator sessions revoked.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Administrator reset failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
