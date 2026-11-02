import type { Connector, SourceMetadata, NormalizedEvent, RawItem, Cursor } from './types.js';
export const fixtureEvents: NormalizedEvent[] = [
  {
    sourceId: 'chain-fixture',
    externalId: 'brc20-deploy-001',
    title: 'EMBER · 检测到新的 BRC-20 部署',
    description:
      '合成测试案例：新资产首次部署，项目官方信息与参与条件尚待验证。此条不是实际投资项目。',
    eventType: 'TOKEN_DEPLOYED',
    originalUrl: 'https://example.invalid/fixtures/ember/deploy',
    sourcePublishedAt: '2026-11-02T01:00:00.000Z',
    eventOccurredAt: '2026-11-02T00:59:50.000Z',
    assets: ['EMBER'],
    categories: ['Bitcoin', 'BRC-20'],
    chain: 'Bitcoin',
    assetKey: 'fixture:bitcoin:brc20:ember',
    identity: 'fixture-deployment-001',
    confidence: 0.68,
    severity: 'P2',
    verificationStatus: 'UNVERIFIED',
    dataMode: 'fixture',
    signalType: 'NEW_TOKEN_DEPLOYED',
    project: {
      assetKey: 'fixture:bitcoin:brc20:ember',
      name: 'EMBER',
      chain: 'Bitcoin',
      protocol: 'BRC-20',
      stage: 'UNVERIFIED',
      conditions: null,
    },
    riskFlags: ['UNVERIFIED_OFFICIAL', 'UNKNOWN_CONTRACT_RISK'],
    metrics: { participants: 48, participantGrowthPct: 0, mintProgress: 12 },
  },
  {
    sourceId: 'chain-fixture',
    externalId: 'runes-mint-001',
    title: 'NOVA RUNE · 早期铸造窗口开放',
    description:
      '合成测试案例：提供明确的参与窗口证据，用于验证阶段变化、评分与通知规则。无真实参与地址。',
    eventType: 'MINT_STARTED',
    originalUrl: 'https://example.invalid/fixtures/nova/mint',
    sourcePublishedAt: '2026-11-02T01:15:00.000Z',
    eventOccurredAt: '2026-11-02T01:15:00.000Z',
    assets: ['NOVA'],
    categories: ['Bitcoin', 'Runes'],
    chain: 'Bitcoin',
    assetKey: 'fixture:bitcoin:runes:nova',
    identity: 'fixture-mint-001',
    confidence: 0.92,
    severity: 'P1',
    verificationStatus: 'VERIFIED',
    dataMode: 'fixture',
    signalType: 'MINT_STARTED',
    project: {
      assetKey: 'fixture:bitcoin:runes:nova',
      name: 'NOVA RUNE',
      chain: 'Bitcoin',
      protocol: 'Runes',
      stage: 'EARLY_STAGE',
      conditions: '测试条件：开放窗口已验证；费用未知；禁止实际参与',
      endsAt: '2026-11-03T01:15:00.000Z',
    },
    conditionsVerified: true,
    metrics: { participants: 312, participantGrowthPct: 146, mintProgress: 28 },
  },
  {
    sourceId: 'chain-fixture',
    externalId: 'solana-pool-001',
    title: 'TIDE · 新增流动性但权限风险待确认',
    description: '合成测试案例：机会分和风险分独立；流动性增加不代表合约安全。',
    eventType: 'LIQUIDITY_ADDED',
    originalUrl: 'https://example.invalid/fixtures/tide/pool',
    sourcePublishedAt: '2026-11-02T01:30:00.000Z',
    eventOccurredAt: '2026-11-02T01:29:00.000Z',
    assets: ['TIDE'],
    categories: ['Solana', 'DEX'],
    chain: 'Solana',
    assetKey: 'fixture:solana:mint:tide',
    identity: 'fixture-pool-001',
    confidence: 0.72,
    severity: 'P2',
    verificationStatus: 'UNVERIFIED',
    dataMode: 'fixture',
    signalType: 'LIQUIDITY_ADDED',
    project: {
      assetKey: 'fixture:solana:mint:tide',
      name: 'TIDE',
      chain: 'Solana',
      protocol: 'SPL',
      stage: 'TRADING',
      conditions: null,
    },
    riskFlags: ['MUTABLE_RULES', 'UNVERIFIED_OFFICIAL', 'UNKNOWN_CONTRACT_RISK'],
    metrics: { participants: 186, liquidityUsd: 42000, participantGrowthPct: 86 },
  },
  {
    sourceId: 'chain-fixture',
    externalId: 'evm-permission-001',
    title: 'ARC · 合约权限异常，保持风险观察',
    description: '合成测试案例：模拟任意增发权限命中风险标记；高机会分不得覆盖该警告。',
    eventType: 'RISK_DETECTED',
    originalUrl: 'https://example.invalid/fixtures/arc/risk',
    sourcePublishedAt: '2026-11-02T01:45:00.000Z',
    eventOccurredAt: '2026-11-02T01:45:00.000Z',
    assets: ['ARC'],
    categories: ['Ethereum', '合约风险'],
    chain: 'Ethereum',
    assetKey: 'fixture:ethereum:token:arc',
    identity: 'fixture-risk-001',
    confidence: 0.94,
    severity: 'P1',
    verificationStatus: 'VERIFIED',
    dataMode: 'fixture',
    signalType: 'NEW_TOKEN_DEPLOYED',
    project: {
      assetKey: 'fixture:ethereum:token:arc',
      name: 'ARC',
      chain: 'Ethereum',
      protocol: 'ERC-20',
      stage: 'VERIFIED',
      conditions: null,
    },
    riskFlags: ['UNRESTRICTED_MINT', 'MUTABLE_RULES', 'UNKNOWN_LIQUIDITY'],
    metrics: { participants: 27 },
  },
  {
    sourceId: 'chain-fixture',
    externalId: 'macro-fed-001',
    title: '美联储政策声明 · 事件管道测试',
    description: '合成宏观事件，不代表任何实际政策决定；预期值、实际利率均未知。',
    eventType: 'OFFICIAL_ANNOUNCEMENT',
    originalUrl: 'https://example.invalid/fixtures/fed',
    sourcePublishedAt: '2026-11-02T02:00:00.000Z',
    eventOccurredAt: null,
    assets: ['USD', 'US10Y', 'XAU'],
    categories: ['宏观', '美联储'],
    confidence: 0.98,
    severity: 'P2',
    verificationStatus: 'VERIFIED',
    dataMode: 'fixture',
  },
];
export class FixtureConnector implements Connector {
  metadata: SourceMetadata = {
    id: 'chain-fixture',
    name: 'Fixture · 合成测试数据',
    officialUrl: 'https://example.invalid/fixtures',
    transport: 'pull',
    mode: 'fixture',
    categories: ['测试数据'],
    trust: 0.9,
    pollIntervalSeconds: 300,
    licenseStatus: 'official-public',
  };
  capabilities = {
    history: true,
    checkpoint: true,
    scope: 'partial' as const,
    sourceTimestamp: true,
  };
  rateLimit = { maxRequests: 1, windowMs: 1000, respectRetryAfter: true };
  async initialize() {}
  async fetch(cursor: Cursor = {}) {
    return {
      items: cursor.complete
        ? []
        : fixtureEvents.map((event) => ({
            externalId: event.externalId,
            payload: { ...event },
            publishedAt: event.sourcePublishedAt,
          })),
      cursor: { complete: true, fixtureVersion: '1' },
    };
  }
  normalize(raw: RawItem) {
    return { ...raw.payload, dataMode: 'fixture' } as NormalizedEvent;
  }
  async healthCheck() {
    return { status: 'healthy' as const, detail: '合成测试来源；不是实时监控结果' };
  }
  async shutdown() {}
}
