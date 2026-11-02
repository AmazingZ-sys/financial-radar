export const dexChains = [
  'solana',
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'bsc',
] as const;
export type DexChain = (typeof dexChains)[number];

export function normalizeRepository(repository: string) {
  const value = repository.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(value))
    throw new Error('无效官方仓库配置；须为 owner/repository');
  if (value.endsWith('/.') || value.endsWith('/..')) throw new Error('无效官方仓库配置');
  return value;
}

export function normalizeRepositories(repositories: string[] = ['ordinals/ord']) {
  const values = [...new Set(repositories.map(normalizeRepository))];
  if (values.length > 20) throw new Error('GitHub 官方仓库白名单最多20项');
  return values;
}

function isSolanaAddress(value: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}

export function normalizeDexScope(chain: string = 'solana', addresses: string[] = []) {
  if (!dexChains.includes(chain as DexChain)) throw new Error('不支持的 DEX_CHAIN');
  const values = [...new Set(addresses.map((value) => value.trim()))];
  if (values.length > 30) throw new Error('DEX_TOKEN_ADDRESSES 最多30个资产');
  for (const value of values)
    if (chain === 'solana' ? !isSolanaAddress(value) : !/^0x[0-9a-fA-F]{40}$/.test(value))
      throw new Error(`DEX_TOKEN_ADDRESSES 包含无效 ${chain} token 地址`);
  return {
    chain: chain as DexChain,
    addresses: [
      ...new Set(values.map((value) => (chain === 'solana' ? value : value.toLowerCase()))),
    ],
  };
}
