import { randomUUID } from 'node:crypto';
import { config } from '@radar/config';
import { sql } from './index.js';
import { hashPassword } from './password.js';
export async function ensureAdmin(): Promise<string> {
  const existing = await sql<
    { id: string }[]
  >`SELECT id FROM users WHERE email=${config.adminEmail}`;
  let ownerId = existing[0]?.id;
  if (!ownerId) {
    const id = randomUUID();
    const hash = await hashPassword(config.adminPassword);
    const rows = await sql<
      { id: string }[]
    >`INSERT INTO users(id,email,password_hash) VALUES(${id},${config.adminEmail},${hash}) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id`;
    ownerId = rows[0]!.id;
  }
  await sql`INSERT INTO user_settings(user_id,data) VALUES(${ownerId},${sql.json({ theme: 'dark', timezone: 'Asia/Shanghai', locale: 'zh-CN', notifications: { quietStart: null, quietEnd: null, minimumPriority: 'P2' } })}) ON CONFLICT DO NOTHING`;
  for (const [provider, name] of [
    ['telegram', 'Telegram Bot'],
    ['feishu', '飞书 Bot'],
    ['bark', 'Bark'],
    ['email', '邮箱 SMTP'],
  ]) {
    await sql`INSERT INTO notification_channels(id,owner_id,provider,name,enabled,data) VALUES(${randomUUID()},${ownerId},${provider!},${name!},${provider === 'telegram'},'{}') ON CONFLICT(owner_id,provider) DO NOTHING`;
  }
  return ownerId;
}
