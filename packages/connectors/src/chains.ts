import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fetchPublicHttps } from '@radar/config';
import { ResilientHttp, ConnectorError } from './http.js';
import type { Connector, SourceMetadata, Cursor, RawItem, NormalizedEvent } from './types.js';
const publicRpcFetcher: typeof fetch = (input, init) =>
  fetchPublicHttps(input instanceof Request ? input.url : String(input), init);
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const PAIR_CREATED_TOPIC =
  '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
// Inclusive block count per RPC request; conservative enough for 10-block free plans.
const EVM_LOG_PAGE_BLOCKS = 10;
const EVM_MAX_BLOCKS_PER_FETCH = 200;
const SOLANA_MAX_TRANSACTION_VERSION = 1;
const SOLANA_SIGNATURE_PAGE_SIZE = 100;
const SOLANA_TRANSACTIONS_PER_FETCH = 20;
const SOLANA_MAX_RECOVERY_PAGES = 1000;
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
    fetcher: typeof fetch = publicRpcFetcher,
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
    if (body.error) {
      if (method === 'getTransaction' && body.error.code === -32015)
        throw new ConnectorError(
          `Solana RPC -32015（交易版本不受支持，当前最高 v${SOLANA_MAX_TRANSACTION_VERSION}；请核查 RPC 节点兼容性或更新适配器）`,
          'PERMANENT',
        );
      throw new ConnectorError(
        `RPC ${body.error.code}（参数/额度/历史覆盖需核查）`,
        body.error.code === -32005 ? 'RATE_LIMIT' : 'TRANSIENT',
      );
    }
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
    fetcher: typeof fetch = publicRpcFetcher,
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
    const to = Math.min(head, from + EVM_MAX_BLOCKS_PER_FETCH - 1);
    const items: RawItem[] = [];
    // Keep requests sequential so RpcConnector's rate limit applies to every page.
    // Any failed page rejects the fetch before the worker can commit its checkpoint.
    for (let pageFrom = from; pageFrom <= to; pageFrom += EVM_LOG_PAGE_BLOCKS) {
      const pageTo = Math.min(to, pageFrom + EVM_LOG_PAGE_BLOCKS - 1);
      const logs = z.array(EvmLog).parse(
        await this.call('eth_getLogs', [
          {
            address: this.factoryAddress,
            fromBlock: '0x' + pageFrom.toString(16),
            toBlock: '0x' + pageTo.toString(16),
            topics: [PAIR_CREATED_TOPIC],
          },
        ]),
      );
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
          Number(BigInt(entry.blockNumber)) < pageFrom ||
          Number(BigInt(entry.blockNumber)) > pageTo
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

const SolanaRecoveryPage = z.object({
  first: Signature,
  count: z.number().int().min(1).max(SOLANA_SIGNATURE_PAGE_SIZE),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
const SolanaRecovery = z.object({
  version: z.literal(1),
  programId: z.string(),
  phase: z.enum(['scan', 'replay']),
  baseSignature: z.string().nullable(),
  before: z.string().nullable(),
  beforeSlot: z.number().int(),
  pages: z.array(SolanaRecoveryPage).max(SOLANA_MAX_RECOVERY_PAGES),
  pending: z.array(Signature).max(SOLANA_SIGNATURE_PAGE_SIZE),
});
type SolanaSignature = z.infer<typeof Signature>;
function signatureDigest(signatures: SolanaSignature[]) {
  return createHash('sha256').update(JSON.stringify(signatures)).digest('hex');
}
function recoveryPage(signatures: SolanaSignature[]) {
  return { first: signatures[0]!, count: signatures.length, digest: signatureDigest(signatures) };
}
const Instruction = z
  .object({
    programId: z.string().optional(),
    parsed: z.object({ type: z.string(), info: z.record(z.string(), z.unknown()) }).optional(),
  })
  .passthrough();
const Transaction = z.object({
  version: z.union([z.literal('legacy'), z.number().int().nonnegative()]).optional(),
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
    fetcher: typeof fetch = publicRpcFetcher,
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
    const nextCursor = { ...cursor };
    let recovery =
      cursor.solanaRecovery === undefined ? undefined : SolanaRecovery.parse(cursor.solanaRecovery);
    if (recovery && recovery.programId !== this.programId)
      throw new ConnectorError('Solana 恢复进度的 Program 不匹配，不推进检查点', 'PERMANENT');
    if (!recovery || recovery.phase === 'scan') {
      const before = recovery?.before;
      const signatures = await this.signaturePage(SOLANA_SIGNATURE_PAGE_SIZE, before ?? undefined);
      const baseSignature =
        recovery?.baseSignature ?? (typeof cursor.signature === 'string' ? cursor.signature : null);
      if (!signatures.length) {
        if (baseSignature !== null)
          throw new ConnectorError(
            'Solana 历史覆盖存在缺口，尚未找到原检查点；需要保留历史的 RPC',
            'PERMANENT',
          );
        return { items: [], cursor };
      }
      if (
        before &&
        (signatures.some((entry) => entry.signature === before) ||
          signatures[0]!.slot > recovery!.beforeSlot ||
          recovery!.pages.some((page) => page.first.signature === signatures[0]!.signature))
      )
        throw new ConnectorError('Solana 分页没有向历史前进，不推进检查点', 'SCHEMA');
      const boundary =
        baseSignature === null
          ? -1
          : signatures.findIndex((entry) => entry.signature === baseSignature);
      const selected = boundary < 0 ? signatures : signatures.slice(0, boundary);
      const pages = [...(recovery?.pages ?? [])];
      if (selected.length) {
        if (pages.length >= SOLANA_MAX_RECOVERY_PAGES)
          throw new ConnectorError(
            'Solana 积压超过有界补偿容量；需缩小 Program 范围或专门历史索引，不越过缺口',
            'PERMANENT',
          );
        pages.push(recoveryPage(selected));
      }
      recovery = {
        version: 1,
        programId: this.programId,
        phase: baseSignature === null || boundary >= 0 ? 'replay' : 'scan',
        baseSignature,
        before: signatures.at(-1)!.signature,
        beforeSlot: signatures.at(-1)!.slot,
        pages,
        pending: [],
      };
      if (baseSignature === null) nextCursor.bootstrapHistoryLimited = true;
      if (recovery.phase === 'scan')
        return { items: [], cursor: { ...nextCursor, solanaRecovery: recovery } };
      // The terminal page is already available; its oldest signatures can be read
      // immediately without a second history request. Other pages are immutable anchors.
      if (selected.length) {
        recovery.pages.pop();
        recovery.pending = [...selected].reverse();
      }
    }
    if (!recovery.pending.length && recovery.pages.length) {
      const page = recovery.pages.pop()!;
      const signatures = [
        page.first,
        ...(page.count > 1 ? await this.signaturePage(page.count - 1, page.first.signature) : []),
      ];
      if (signatures.length !== page.count || signatureDigest(signatures) !== page.digest)
        throw new ConnectorError('Solana 历史页不完整或内容变化，不推进检查点', 'PERMANENT');
      recovery.pending = signatures.reverse();
    }
    const signatures = recovery.pending.slice(0, SOLANA_TRANSACTIONS_PER_FETCH);
    const items: RawItem[] = [];
    for (const sig of signatures) {
      if (sig.err) continue;
      const raw = await this.call('getTransaction', [
        sig.signature,
        {
          commitment: 'finalized',
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: SOLANA_MAX_TRANSACTION_VERSION,
        },
      ]);
      if (!raw) throw new ConnectorError('finalized交易历史暂不可得，不前进检查点', 'TRANSIENT');
      const transaction = Transaction.parse(raw);
      if (
        typeof transaction.version === 'number' &&
        transaction.version > SOLANA_MAX_TRANSACTION_VERSION
      )
        throw new ConnectorError(
          `Solana 交易版本不受支持（当前最高 v${SOLANA_MAX_TRANSACTION_VERSION}）；请更新适配器，不推进检查点`,
          'PERMANENT',
        );
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
    const latest = signatures.at(-1);
    if (latest) {
      nextCursor.signature = latest.signature;
      nextCursor.slot = latest.slot;
      nextCursor.scope = 'configured-mainnet-program';
    }
    recovery.pending = recovery.pending.slice(signatures.length);
    if (recovery.pending.length || recovery.pages.length) nextCursor.solanaRecovery = recovery;
    else delete nextCursor.solanaRecovery;
    return { items, cursor: nextCursor };
  }
  private async signaturePage(limit: number, before?: string) {
    const signatures = z
      .array(Signature)
      .max(limit)
      .parse(
        await this.call('getSignaturesForAddress', [
          this.programId,
          { commitment: 'finalized', limit, ...(before ? { before } : {}) },
        ]),
      );
    const unique = new Set(signatures.map((entry) => entry.signature));
    if (
      unique.size !== signatures.length ||
      signatures.some((entry, index) => index > 0 && entry.slot > signatures[index - 1]!.slot)
    )
      throw new ConnectorError('Solana 签名页重复或顺序无效，不推进检查点', 'SCHEMA');
    return signatures;
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
