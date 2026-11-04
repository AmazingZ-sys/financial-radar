import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../packages/config/src/index.js';
import { sql, readSourceIntegrationsConfig } from '../packages/database/src/index.js';
import {
  registry,
  synchronizeConfiguredSources,
  runIngestion,
} from '../apps/worker/src/pipeline.js';
import type { createApp } from '../apps/api/src/app.js';
import type { Cursor } from '../packages/connectors/src/index.js';

/** Authenticated configuration and hot-reload verification, with no external RPC calls. */
export async function verifySourceConfiguration(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
) {
  const key = 'integrations:sources';
  const saved = (await sql`SELECT data FROM system_settings WHERE key=${key}`)[0];
  const ids = ['unisat-brc20', 'evm-factory', 'solana-mints', 'dexscreener'];
  const connectorsBefore = ids.map((id) => registry.get(id));
  const rowsBefore = await sql`SELECT * FROM data_sources WHERE id=ANY(${ids}::text[])`;
  const modeBefore = config.dataMode;
  const rootKeyBefore = config.integrationEncryptionKey;
  const secret = `source-config-placeholder-${randomUUID()}`;
  const rpc = `https://1.1.1.1/rpc/${secret}`;
  let checks = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    checks++;
  };
  const request = (body: unknown) =>
    app.request('/api/v1/integrations/sources', {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  try {
    const csrf = await app.request('/api/v1/integrations/sources', {
      method: 'PATCH',
      headers: { ...headers, 'X-CSRF-Token': 'invalid' },
      body: '{}',
    });
    check(csrf.status === 403, 'Source credentials require CSRF');
    for (const evmRpcUrl of [
      'http://1.1.1.1/rpc',
      'https://127.0.0.1/rpc',
      'https://169.254.169.254/rpc',
    ]) {
      check((await request({ evmRpcUrl })).status === 400, 'Unsafe RPC rejected');
    }
    check(
      (await request({ dexChain: 'ethereum', dexTokenAddresses: ['not-an-address'] })).status ===
        400,
      'Invalid DEX scope rejected',
    );
    const result = await request({
      unisatApiKey: secret,
      evmRpcUrl: rpc,
      evmFactoryAddress: '0x0000000000000000000000000000000000000001',
      solanaRpcUrl: rpc,
      solanaProgramId: '11111111111111111111111111111111',
      dexChain: 'ethereum',
      dexTokenAddresses: ['0x0000000000000000000000000000000000000001'],
    });
    check(result.status === 200, 'Source configuration saved');
    const view = await result.json();
    check(
      view.data.unisatApiKeyConfigured &&
        view.data.evmRpcConfigured &&
        view.data.solanaRpcConfigured &&
        view.data.configOrigin === 'database',
      'Configured flags returned',
    );
    check(
      !JSON.stringify(view).includes(secret) &&
        !('evmRpcUrl' in view.data) &&
        !('solanaRpcUrl' in view.data),
      'Keys and credential-bearing RPC URLs never returned',
    );
    const stored = (await sql`SELECT data FROM system_settings WHERE key=${key}`)[0]!;
    check(!JSON.stringify(stored).includes(secret), 'Keys and RPC URLs encrypted at rest');
    check(
      (await readSourceIntegrationsConfig()).evmRpcUrl === rpc,
      'Worker decrypts saved RPC URL',
    );
    await request({ unisatApiKey: '', evmRpcUrl: '', solanaRpcUrl: '' });
    check(
      (await readSourceIntegrationsConfig()).unisatApiKey === secret &&
        (await readSourceIntegrationsConfig()).solanaRpcUrl === rpc,
      'Blank inputs preserve saved credentials',
    );
    config.dataMode = 'live';
    await synchronizeConfiguredSources();
    check(
      (await registry.get('evm-factory')!.healthCheck()).status === 'healthy' &&
        (await registry.get('dexscreener')!.healthCheck()).status === 'healthy',
      'Running registry reads saved connection scope without restarting',
    );
    // Use an empty synthetic RPC transport to inspect the actual checkpoint passed to fetch.
    if (!rowsBefore.some((row) => row.id === 'evm-factory')) {
      await sql`INSERT INTO data_sources(id,name,enabled,connector_type,mode,interval_seconds,data) VALUES('evm-factory','Integration scope check',true,'pull','live',60,'{}'::jsonb)`;
      await sql`INSERT INTO source_checkpoints(source_id,cursor) VALUES('evm-factory','{"blockNumber":123,"_integrationScope":"old-range"}'::jsonb)`;
      let received: Cursor | undefined;
      registry.get('evm-factory')!.fetch = async (cursor) => {
        received = cursor;
        return { items: [], cursor: { blockNumber: 456 } };
      };
      await runIngestion('evm-factory');
      check(received === undefined, 'A changed scope never resumes another Factory checkpoint');
      await runIngestion('evm-factory');
      check(received?.blockNumber === 456, 'Unchanged scope resumes its durable checkpoint');
    }
    await request({
      clearUnisatApiKey: true,
      clearEvmRpcUrl: true,
      clearSolanaRpcUrl: true,
      dexTokenAddresses: [],
    });
    await synchronizeConfiguredSources();
    check(
      (await registry.get('evm-factory')!.healthCheck()).status === 'unconfigured' &&
        (await registry.get('unisat-brc20')!.healthCheck()).status === 'unconfigured',
      'Explicit clearing disables live credentials in the running worker',
    );
    check(
      (await readSourceIntegrationsConfig()).unisatApiKey === '',
      'Cleared credentials never fall back to environment',
    );
    await request({ unisatApiKey: secret });
    config.integrationEncryptionKey = 'integration-rotated-key-placeholder-at-least-32-characters';
    const unavailable = await app.request('/api/v1/integrations/sources', { headers });
    check(
      unavailable.status === 200 && (await unavailable.json()).data.credentialError,
      'Configuration editor remains available after encryption key rotation',
    );
    config.integrationEncryptionKey = rootKeyBefore;
    const audits =
      await sql`SELECT id FROM audit_logs WHERE entity_type='source_integration' AND details::text LIKE ${`%${secret}%`}`;
    check(audits.length === 0, 'Source configuration audit contains field names only');
    console.log(
      `Source configuration integration passed: ${checks} PostgreSQL/API/hot-reload checks; no external RPC requests.`,
    );
  } finally {
    config.integrationEncryptionKey = rootKeyBefore;
    await sql`DELETE FROM system_settings WHERE key=${key}`;
    if (saved)
      await sql`INSERT INTO system_settings(key,data) VALUES(${key},${sql.json(saved.data)})`;
    config.dataMode = 'live';
    await synchronizeConfiguredSources();
    for (const id of ids) {
      if (!rowsBefore.some((row) => row.id === id)) {
        await sql`DELETE FROM source_checkpoints WHERE source_id=${id}`;
        await sql`DELETE FROM source_health_records WHERE source_id=${id}`;
        await sql`DELETE FROM ingestion_runs WHERE source_id=${id}`;
        await sql`DELETE FROM data_sources WHERE id=${id}`;
      }
      registry.remove(id);
    }
    for (const connector of connectorsBefore) if (connector) registry.register(connector);
    for (const row of rowsBefore)
      await sql`UPDATE data_sources SET enabled=${row.enabled},last_error=${row.last_error},data=${sql.json(row.data)} WHERE id=${row.id}`;
    config.dataMode = modeBefore;
  }
}
