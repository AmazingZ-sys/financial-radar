import { z } from 'zod';
import { ResilientHttp, ConnectorError } from './http.js';
import type { Connector, SourceMetadata, Cursor, RawItem, NormalizedEvent } from './types.js';
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const PAIR_CREATED_TOPIC =
  '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
abstract class RpcConnector implements Connector {
  abstract metadata: SourceMetadata;
  capabilities = {
    history: true,
    checkpoint: true,
    scope: 'watchlist' as const,
    sourceTimestamp: false,
  };
  rateLimit = { maxRequests: 2, windowMs: 1000, respectRetryAfter: true };
  protected http: ResilientHttp;
  constructor(
    protected rpcUrl: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.http = new ResilientHttp(fetcher, undefined, undefined, 500);
  }
  async initialize() {}
  async shutdown() {}
  abstract healthCheck(): Promise<{
    status: 'healthy' | 'unconfigured' | 'degraded';
    detail: string;
  }>;
  abstract fetch(cursor?: Cursor): Promise<{ items: RawItem[]; cursor: Cursor }>;
  abstract normalize(item: RawItem): NormalizedEvent;
  protected async call(method: string, params: unknown[]) {
    if (!this.rpcUrl) throw new ConnectorError('RPC 尚未配置', 'AUTH');
    const response = await this.http.request(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = z
      .object({
        result: z.unknown().optional(),
        error: z.object({ code: z.number(), message: z.string() }).optional(),
      })
      .parse(await response.json());
    if (body.error)
      throw new ConnectorError(
        `RPC ${body.error.code}（参数/额度/历史覆盖需核查）`,
        body.error.code === -32005 ? 'RATE_LIMIT' : 'TRANSIENT',
      );
    return body.result;
  }
}
const EvmLog = z.object({
  address: evmAddress,
  topics: z.array(hex).min(3),
  data: hex,
  transactionHash: txHash,
  blockHash: txHash,
  blockNumber: hex,
  logIndex: hex,
  removed: z.boolean().optional(),
});
const EvmBlock = z.object({ number: hex, hash: txHash, timestamp: hex });
export class EvmFactoryConnector extends RpcConnector {
  metadata: SourceMetadata = {
    id: 'evm-factory',
    name: 'Ethereum · 指定 V2 Factory 新池',
    officialUrl: 'https://ethereum.org/developers/docs/apis/json-rpc/',
    transport: 'pull',
    mode: 'live',
    categories: ['crypto', 'Ethereum', 'DEX'],
    trust: 0.85,
    pollIntervalSeconds: 60,
    licenseStatus: 'authorization-required',
  };
  constructor(
    rpcUrl = '',
    private factoryAddress = '',
    fetcher: typeof fetch = fetch,
  ) {
    super(rpcUrl, fetcher);
  }
  async healthCheck() {
    return this.rpcUrl && evmAddress.safeParse(this.factoryAddress).success
      ? {
          status: 'healthy' as const,
          detail: '仅Ethereum主网指定V2 Factory finalized日志；非全链新部署索引',
        }
      : { status: 'unconfigured' as const, detail: '需要获授权Ethereum RPC及已核验V2 Factory地址' };
  }
  async fetch(cursor: Cursor = {}) {
    evmAddress.parse(this.factoryAddress);
    if ((await this.call('eth_chainId', [])) !== '0x1')
      throw new ConnectorError('本适配器仅配置Ethereum主网，链ID不匹配', 'PERMANENT');
    const finalized = EvmBlock.parse(await this.call('eth_getBlockByNumber', ['finalized', false]));
    const head = Number(BigInt(finalized.number));
    if (typeof cursor.blockNumber === 'number' && typeof cursor.blockHash === 'string') {
      const checkpoint = EvmBlock.parse(
        await this.call('eth_getBlockByNumber', ['0x' + cursor.blockNumber.toString(16), false]),
      );
      if (checkpoint.hash !== cursor.blockHash)
        throw new ConnectorError('最终性检查点发生重组；停止前进，需人工核查并回放', 'PERMANENT');
    }
    const from =
      typeof cursor.blockNumber === 'number' ? cursor.blockNumber + 1 : Math.max(0, head - 20);
    if (from > head) return { items: [], cursor };
    const to = Math.min(head, from + 199);
    const logs = z.array(EvmLog).parse(
      await this.call('eth_getLogs', [
        {
          address: this.factoryAddress,
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
          topics: [PAIR_CREATED_TOPIC],
        },
      ]),
    );
    const items: RawItem[] = [];
    for (const entry of logs) {
      if (
        entry.address.toLowerCase() !== this.factoryAddress.toLowerCase() ||
        entry.topics[0] !== PAIR_CREATED_TOPIC
      )
        throw new ConnectorError('RPC返回不在配置Factory或topic范围内的日志', 'SCHEMA');
      if (entry.removed) throw new ConnectorError('RPC返回已撤回日志，不提交检查点', 'SCHEMA');
      const block = EvmBlock.parse(
        await this.call('eth_getBlockByNumber', [entry.blockNumber, false]),
      );
      if (
        block.hash !== entry.blockHash ||
        Number(BigInt(entry.blockNumber)) < from ||
        Number(BigInt(entry.blockNumber)) > to
      )
        throw new ConnectorError('日志与区块范围/哈希不一致', 'SCHEMA');
      items.push({
        externalId: `${entry.transactionHash}:${entry.logIndex}`,
        publishedAt: null,
        payload: {
          ...entry,
          blockTime: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
        },
      });
    }
    const last =
      to === head
        ? finalized
        : EvmBlock.parse(await this.call('eth_getBlockByNumber', ['0x' + to.toString(16), false]));
    return {
      items,
      cursor: {
        blockNumber: to,
        blockHash: last.hash,
        scope: 'ethereum-mainnet-single-v2-factory',
        bootstrapLookbackBlocks:
          typeof cursor.blockNumber === 'number' ? (cursor.bootstrapLookbackBlocks ?? 20) : 20,
      },
    };
  }
  normalize(item: RawItem): NormalizedEvent {
    const log = EvmLog.parse(item.payload);
    if (log.topics[0] !== PAIR_CREATED_TOPIC || log.data.length < 130)
      throw new ConnectorError('不是合法PairCreated日志', 'SCHEMA');
    const pair = '0x' + log.data.slice(26, 66);
    evmAddress.parse(pair);
    const assets = [log.topics[1]!, log.topics[2]!].map((topic) => '0x' + topic.slice(-40));
    const assetKey = `ethereum:pair:${pair.toLowerCase()}`;
    return {
      sourceId: this.metadata.id,
      externalId: item.externalId,
      title: `新交易池 · ${pair.slice(0, 10)}…`,
      description:
        '指定V2 Factory的finalized PairCreated日志。池创建不证明已添加流动性、官方身份或合约安全。',
      eventType: 'PAIR_CREATED',
      originalUrl: `https://etherscan.io/tx/${log.transactionHash}`,
      sourcePublishedAt: null,
      eventOccurredAt: String(item.payload.blockTime),
      assets,
      categories: this.metadata.categories,
      chain: 'Ethereum',
      assetKey,
      identity: item.externalId,
      confidence: 0.78,
      severity: 'P2',
      verificationStatus: 'UNVERIFIED',
      dataMode: 'live',
      signalType: 'NEW_TRADING_PAIR',
      project: {
        assetKey,
        name: `${assets[0]!.slice(0, 8)}/${assets[1]!.slice(0, 8)}`,
        chain: 'Ethereum',
        protocol: 'V2-compatible DEX',
        stage: 'UNVERIFIED',
        conditions: null,
      },
      riskFlags: ['UNVERIFIED_OFFICIAL', 'UNKNOWN_LIQUIDITY', 'UNKNOWN_CONTRACT_RISK'],
    };
  }
}
const Signature = z.object({
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{60,100}$/),
  slot: z.number().int(),
  err: z.unknown(),
  blockTime: z.number().nullable(),
});
const Instruction = z
  .object({
    programId: z.string().optional(),
    parsed: z.object({ type: z.string(), info: z.record(z.string(), z.unknown()) }).optional(),
  })
  .passthrough();
const Transaction = z.object({
  blockTime: z.number().nullable(),
  slot: z.number(),
  meta: z
    .object({
      err: z.unknown(),
      innerInstructions: z
        .array(z.object({ instructions: z.array(Instruction) }))
        .nullable()
        .optional(),
    })
    .nullable(),
  transaction: z.object({ message: z.object({ instructions: z.array(Instruction) }) }),
});
export class SolanaMintConnector extends RpcConnector {
  metadata: SourceMetadata = {
    id: 'solana-mints',
    name: 'Solana · 指定 Program 新 Mint',
    officialUrl: 'https://solana.com/docs/rpc',
    transport: 'pull',
    mode: 'live',
    categories: ['crypto', 'Solana', '新资产'],
    trust: 0.85,
    pollIntervalSeconds: 60,
    licenseStatus: 'authorization-required',
  };
  constructor(
    rpcUrl = '',
    private programId = '',
    fetcher: typeof fetch = fetch,
  ) {
    super(rpcUrl, fetcher);
  }
  async healthCheck() {
    return this.rpcUrl && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(this.programId)
      ? {
          status: 'healthy' as const,
          detail: '仅配置的Solana主网program，finalized交易内SPL initializeMint；非全链扫描',
        }
      : { status: 'unconfigured' as const, detail: '需要获授权Solana主网RPC及指定Program ID' };
  }
  async fetch(cursor: Cursor = {}) {
    if ((await this.healthCheck()).status !== 'healthy')
      throw new ConnectorError('Solana RPC/Program未配置', 'AUTH');
    const signatures = z.array(Signature).parse(
      await this.call('getSignaturesForAddress', [
        this.programId,
        {
          commitment: 'finalized',
          limit: 100,
          ...(typeof cursor.signature === 'string' ? { until: cursor.signature } : {}),
        },
      ]),
    );
    if (signatures.length === 100 && typeof cursor.signature === 'string')
      throw new ConnectorError(
        '指定program积压超过100交易，需要历史补偿；不越过缺口提交cursor',
        'PERMANENT',
      );
    const items: RawItem[] = [];
    for (const sig of [...signatures].reverse()) {
      if (sig.err) continue;
      const raw = await this.call('getTransaction', [
        sig.signature,
        { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      if (!raw) throw new ConnectorError('finalized交易历史暂不可得，不前进检查点', 'TRANSIENT');
      const transaction = Transaction.parse(raw);
      if (transaction.meta?.err) continue;
      const instructions = [
        ...transaction.transaction.message.instructions,
        ...(transaction.meta?.innerInstructions?.flatMap((group) => group.instructions) ?? []),
      ];
      for (const [index, instruction] of instructions.entries()) {
        if (
          ![
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          ].includes(instruction.programId ?? '') ||
          !['initializeMint', 'initializeMint2'].includes(instruction.parsed?.type ?? '')
        )
          continue;
        const mint = z
          .string()
          .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
          .parse(instruction.parsed!.info.mint);
        items.push({
          externalId: `${sig.signature}:${index}`,
          publishedAt: null,
          payload: {
            signature: sig.signature,
            slot: sig.slot,
            mint,
            instruction: instruction.parsed,
            blockTime: transaction.blockTime
              ? new Date(transaction.blockTime * 1000).toISOString()
              : null,
          },
        });
      }
    }
    return {
      items,
      cursor: signatures[0]
        ? {
            signature: signatures[0].signature,
            slot: signatures[0].slot,
            scope: 'configured-mainnet-program',
            bootstrapHistoryLimited: cursor.bootstrapHistoryLimited ?? true,
          }
        : cursor,
    };
  }
  normalize(item: RawItem): NormalizedEvent {
    const mint = String(item.payload.mint);
    const assetKey = `solana:mint:${mint}`;
    return {
      sourceId: this.metadata.id,
      externalId: item.externalId,
      title: `新 Mint · ${mint.slice(0, 8)}…`,
      description:
        '指定program相关finalized交易出现SPL Token初始化；铸币权限、安全性、项目官方身份与参与条件尚未验证。',
      eventType: 'TOKEN_DEPLOYED',
      originalUrl: `https://explorer.solana.com/tx/${item.payload.signature}`,
      sourcePublishedAt: null,
      eventOccurredAt: typeof item.payload.blockTime === 'string' ? item.payload.blockTime : null,
      assets: [mint],
      categories: this.metadata.categories,
      chain: 'Solana',
      assetKey,
      identity: item.externalId,
      confidence: 0.76,
      severity: 'P2',
      verificationStatus: 'UNVERIFIED',
      dataMode: 'live',
      signalType: 'NEW_TOKEN_DEPLOYED',
      project: {
        assetKey,
        name: mint.slice(0, 8) + '…',
        chain: 'Solana',
        protocol: 'SPL Token',
        stage: 'UNVERIFIED',
        conditions: null,
      },
      riskFlags: ['UNVERIFIED_OFFICIAL', 'UNKNOWN_CONTRACT_RISK', 'UNKNOWN_LIQUIDITY'],
    };
  }
}
