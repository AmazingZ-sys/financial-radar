import { config } from '@radar/config';
import { z } from 'zod';
import { type SourceIntegrationsPatch } from '@radar/shared';
import { sql } from './index.js';
import { encryptIntegrationSecret, decryptIntegrationSecret } from './integrations.js';

const KEY = 'integrations:sources';
const ScopeSchema = z.object({
  evmFactoryAddress: z.string().default(''),
  solanaProgramId: z.string().default(''),
  dexChain: z
    .enum(['solana', 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc'])
    .default('solana'),
  dexTokenAddresses: z.array(z.string()).default([]),
});
const secretFields = ['unisatApiKey', 'evmRpcUrl', 'solanaRpcUrl'] as const;
type SecretField = (typeof secretFields)[number];
type Stored = z.infer<typeof ScopeSchema> & { secrets: Record<SecretField, string> };
function environment() {
  return {
    unisatApiKey: config.unisatApiKey,
    evmRpcUrl: config.evmRpcUrl,
    solanaRpcUrl: config.solanaRpcUrl,
    evmFactoryAddress: config.evmFactoryAddress,
    solanaProgramId: config.solanaProgramId,
    dexChain: config.dexChain,
    dexTokenAddresses: config.dexTokenAddresses,
  };
}
function decode(data: Stored | undefined) {
  const defaults = environment();
  if (!data) return { ...defaults, configOrigin: 'environment' as const };
  const secrets = Object.fromEntries(
    secretFields.map((key) => [key, decryptIntegrationSecret(data.secrets[key], `${KEY}:${key}`)]),
  ) as Record<SecretField, string>;
  return { ...ScopeSchema.parse(data), ...secrets, configOrigin: 'database' as const };
}
export async function readSourceIntegrationsConfig() {
  const row = (await sql`SELECT data FROM system_settings WHERE key=${KEY}`)[0];
  return decode(row?.data as Stored | undefined);
}
export const SOURCE_SETUP_LINKS = {
  unisat: 'https://developer.unisat.io',
  ethereumRpc: 'https://dashboard.alchemy.com/',
  solanaRpc: 'https://dashboard.helius.dev/',
  dex: 'https://docs.dexscreener.com/api/reference',
};
export function sourceIntegrationsView(
  effective: ReturnType<typeof decode>,
  credentialError = false,
) {
  return {
    unisatApiKeyConfigured: Boolean(effective.unisatApiKey),
    evmRpcConfigured: Boolean(effective.evmRpcUrl),
    solanaRpcConfigured: Boolean(effective.solanaRpcUrl),
    evmFactoryAddress: effective.evmFactoryAddress,
    solanaProgramId: effective.solanaProgramId,
    dexChain: effective.dexChain,
    dexTokenAddresses: effective.dexTokenAddresses,
    configOrigin: effective.configOrigin,
    credentialError,
    links: SOURCE_SETUP_LINKS,
  };
}
export async function readSourceIntegrationsView() {
  const row = (await sql`SELECT data FROM system_settings WHERE key=${KEY}`)[0];
  const stored = row?.data as Stored | undefined;
  if (!stored) return sourceIntegrationsView(decode(undefined));
  let credentialError = false;
  const secrets = Object.fromEntries(
    secretFields.map((key) => {
      try {
        return [key, decryptIntegrationSecret(stored.secrets[key], `${KEY}:${key}`)];
      } catch {
        credentialError = true;
        return [key, ''];
      }
    }),
  ) as Record<SecretField, string>;
  return sourceIntegrationsView(
    { ...ScopeSchema.parse(stored), ...secrets, configOrigin: 'database' },
    credentialError,
  );
}
export async function saveSourceIntegrationsConfig(patch: SourceIntegrationsPatch) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${KEY}))`;
    const row = (await tx`SELECT data FROM system_settings WHERE key=${KEY}`)[0];
    const old = row?.data as Stored | undefined;
    const defaults = environment();
    const scope = ScopeSchema.parse({ ...(old ?? defaults), ...patch });
    const clearFields = {
      unisatApiKey: patch.clearUnisatApiKey,
      evmRpcUrl: patch.clearEvmRpcUrl,
      solanaRpcUrl: patch.clearSolanaRpcUrl,
    };
    const secrets = Object.fromEntries(
      secretFields.map((key) => {
        // Preserve encrypted bytes when untouched, so a single replacement also recovers from lost keys.
        const encrypted = clearFields[key]
          ? encryptIntegrationSecret('', `${KEY}:${key}`)
          : patch[key]?.trim()
            ? encryptIntegrationSecret(patch[key]!.trim(), `${KEY}:${key}`)
            : (old?.secrets[key] ?? encryptIntegrationSecret(defaults[key], `${KEY}:${key}`));
        return [key, encrypted];
      }),
    ) as Record<SecretField, string>;
    const data: Stored = { ...scope, secrets };
    await tx`INSERT INTO system_settings(key,data) VALUES(${KEY},${tx.json(data)}) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=now()`;
  });
}
