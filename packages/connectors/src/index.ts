export * from './types.js';
export * from './http.js';
export * from './live.js';
export * from './fixture.js';
export * from './chains.js';
export * from './treasury.js';
export * from './scope.js';
import { TreasuryDailyConnector } from './treasury.js';
import { EvmFactoryConnector, SolanaMintConnector } from './chains.js';
import type { Connector } from './types.js';
import { FixtureConnector } from './fixture.js';
import { normalizeRepositories } from './scope.js';
import {
  FedRssConnector,
  GitHubReleasesConnector,
  CoinbaseMarketsConnector,
  UniSatBrc20Connector,
  DexScreenerConnector,
} from './live.js';
export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  register(connector: Connector) {
    if (this.connectors.has(connector.metadata.id)) throw new Error('重复 connector ID');
    this.connectors.set(connector.metadata.id, connector);
    return this;
  }
  get(id: string) {
    return this.connectors.get(id);
  }
  list() {
    return [...this.connectors.values()];
  }
  async shutdown() {
    await Promise.all(this.list().map((connector) => connector.shutdown()));
  }
}
export function createRegistry(config: {
  dataMode: string;
  githubToken?: string;
  githubRepositories?: string[];
  dexChain?: string;
  dexTokenAddresses?: string[];
  unisatApiKey?: string;
  evmRpcUrl?: string;
  evmFactoryAddress?: string;
  solanaRpcUrl?: string;
  solanaProgramId?: string;
}) {
  const registry = new ConnectorRegistry();
  if (config.dataMode === 'fixture') return registry.register(new FixtureConnector());
  registry
    .register(new FedRssConnector())
    .register(new TreasuryDailyConnector())
    .register(new CoinbaseMarketsConnector())
    .register(new UniSatBrc20Connector(config.unisatApiKey))
    .register(new DexScreenerConnector(config.dexChain, config.dexTokenAddresses))
    .register(new EvmFactoryConnector(config.evmRpcUrl, config.evmFactoryAddress))
    .register(new SolanaMintConnector(config.solanaRpcUrl, config.solanaProgramId));
  for (const repository of normalizeRepositories(config.githubRepositories))
    registry.register(new GitHubReleasesConnector(config.githubToken, repository));
  return registry;
}
