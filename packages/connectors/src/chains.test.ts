import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvmFactoryConnector, SolanaMintConnector, PAIR_CREATED_TOPIC } from './chains.js';
import { ConnectorError } from './http.js';
const hash = '0x' + 'a'.repeat(64);
const transaction = '0x' + 'b'.repeat(64);
const factory = '0x' + 'c'.repeat(40);
const pair = '0x' + 'd'.repeat(40);
const block = { number: '0x64', hash, timestamp: '0x69000000' };
const topic = (address: string) => '0x' + '0'.repeat(24) + address.slice(2);
function rpcFetch(handler: (method: string, params: unknown[]) => unknown) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: handler(body.method, body.params) }),
    );
  });
}
type LogRange = { fromBlock: string; toBlock: string; address: string; topics: string[] };
function logRange(params: unknown[]) {
  const range = params[0] as LogRange;
  return { from: Number(BigInt(range.fromBlock)), to: Number(BigInt(range.toBlock)) };
}
function limitedEvmRpc(head: number, logs: (from: number, to: number) => unknown = () => []) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let result: unknown;
    if (request.method === 'eth_chainId') result = '0x1';
    else if (request.method === 'eth_getBlockByNumber') {
      const number =
        request.params[0] === 'finalized' ? head : Number(BigInt(String(request.params[0])));
      result = { ...block, number: '0x' + number.toString(16) };
    } else if (request.method === 'eth_getLogs') {
      const { from, to } = logRange(request.params);
      if (to - from + 1 > 10)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: -32600,
              message: 'Free tier eth_getLogs requests are limited to 10 blocks',
            },
          }),
          { status: 400 },
        );
      result = logs(from, to);
    } else throw new Error(`Unexpected RPC method: ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
}
function requestedLogRanges(fetcher: ReturnType<typeof rpcFetch>) {
  return fetcher.mock.calls.flatMap((call) => {
    const request = JSON.parse(String(call[1]?.body)) as { method: string; params: unknown[] };
    return request.method === 'eth_getLogs' ? [logRange(request.params)] : [];
  });
}
function solanaTransaction(version: 'legacy' | number, mint = '2'.repeat(32)) {
  return {
    version,
    blockTime: null,
    slot: 99,
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
              parsed: { type: 'initializeMint2', info: { mint } },
            },
          ],
        },
      ],
    },
    transaction: {
      message: {
        instructions: [{ programId: '1'.repeat(32), accounts: [], data: '1' }],
        ...(version === 1
          ? { transactionConfig: { computeUnitLimit: 200000, priorityFee: 0 } }
          : {}),
      },
    },
  };
}
function solanaVersionRpc(
  signatures: string[],
  transactionResult: (
    signature: string,
  ) => { result: unknown } | { error: { code: number; message: string } },
) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let response: { result: unknown } | { error: { code: number; message: string } };
    if (request.method === 'getSignaturesForAddress')
      response = {
        result: signatures.map((signature, i) => ({
          signature,
          slot: 100 - i,
          err: null,
          blockTime: null,
        })),
      };
    else if (request.method === 'getTransaction') {
      const options = request.params[1] as { maxSupportedTransactionVersion?: unknown };
      response =
        options.maxSupportedTransactionVersion === 1
          ? transactionResult(String(request.params[0]))
          : { error: { code: -32015, message: 'Transaction version (1) is not supported' } };
    } else throw new Error(`Unexpected Solana RPC method: ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...response }));
  });
}
async function runRpc<T>(operation: () => Promise<T>): Promise<T> {
  const completion = operation().then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
  await vi.runAllTimersAsync();
  const result = await completion;
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
describe('chain adapters preserve bounded coverage and durable cursors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  it('collects finalized V2 pair creation and does not claim liquidity or source publication time', async () => {
    const fetcher = rpcFetch((method, params) =>
      method === 'eth_chainId'
        ? '0x1'
        : method === 'eth_getLogs'
          ? logRange(params).from <= 100 && logRange(params).to >= 100
            ? [
                {
                  address: factory,
                  topics: [
                    PAIR_CREATED_TOPIC,
                    topic('0x' + '1'.repeat(40)),
                    topic('0x' + '2'.repeat(40)),
                  ],
                  data: topic(pair) + '0'.repeat(63) + '1',
                  transactionHash: transaction,
                  blockHash: hash,
                  blockNumber: '0x64',
                  logIndex: '0x0',
                  removed: false,
                },
              ]
            : []
          : block,
    );
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    const result = await runRpc(() => connector.fetch());
    expect(result.cursor.blockNumber).toBe(100);
    expect(result.items).toHaveLength(1);
    const event = connector.normalize(result.items[0]!);
    expect(event.eventType).toBe('PAIR_CREATED');
    expect(event.sourcePublishedAt).toBeNull();
    expect(event.assetKey).toBe(`ethereum:pair:${pair}`);
    expect(event.project?.stage).toBe('UNVERIFIED');
    expect(event.riskFlags).toContain('UNKNOWN_LIQUIDITY');
  });
  it('collects the initial finalized window through a free-tier RPC that rejects ranges over 10 blocks', async () => {
    const fetcher = limitedEvmRpc(100);
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    const result = await runRpc(() => connector.fetch());
    expect(requestedLogRanges(fetcher)).toEqual([
      { from: 80, to: 89 },
      { from: 90, to: 99 },
      { from: 100, to: 100 },
    ]);
    expect(result.items).toEqual([]);
    expect(result.cursor).toMatchObject({ blockNumber: 100, blockHash: hash });
  });
  it('preserves a 200-block catch-up budget with contiguous 10-block requests', async () => {
    const fetcher = limitedEvmRpc(500);
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    const result = await runRpc(() => connector.fetch({ blockNumber: 99, blockHash: hash }));
    const ranges = requestedLogRanges(fetcher);
    expect(ranges).toHaveLength(20);
    expect(ranges[0]).toEqual({ from: 100, to: 109 });
    expect(ranges.at(-1)).toEqual({ from: 290, to: 299 });
    expect(
      ranges.flatMap(({ from, to }) => Array.from({ length: to - from + 1 }, (_, i) => from + i)),
    ).toEqual(Array.from({ length: 200 }, (_, i) => 100 + i));
    expect(result.cursor).toMatchObject({ blockNumber: 299, blockHash: hash });
  });
  it('ends a short last page at the finalized head', async () => {
    const fetcher = limitedEvmRpc(123);
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    const result = await runRpc(() => connector.fetch({ blockNumber: 99, blockHash: hash }));
    expect(requestedLogRanges(fetcher)).toEqual([
      { from: 100, to: 109 },
      { from: 110, to: 119 },
      { from: 120, to: 123 },
    ]);
    expect(result.cursor.blockNumber).toBe(123);
  });
  it('keeps the saved cursor intact after a later page fails and retries from the same block', async () => {
    let failSecondPage = true;
    const fetcher = limitedEvmRpc(123, (from) => {
      if (from === 110 && failSecondPage) throw new Error('second page unavailable');
      return [];
    });
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    const cursor = { blockNumber: 99, blockHash: hash };
    await expect(runRpc(() => connector.fetch(cursor))).rejects.toThrow();
    expect(cursor).toEqual({ blockNumber: 99, blockHash: hash });
    const failedAttemptCount = requestedLogRanges(fetcher).length;
    expect(requestedLogRanges(fetcher).every(({ from }) => from <= 110)).toBe(true);
    failSecondPage = false;
    const result = await runRpc(() => connector.fetch(cursor));
    expect(requestedLogRanges(fetcher).slice(failedAttemptCount)).toEqual([
      { from: 100, to: 109 },
      { from: 110, to: 119 },
      { from: 120, to: 123 },
    ]);
    expect(result.cursor.blockNumber).toBe(123);
    expect(cursor).toEqual({ blockNumber: 99, blockHash: hash });
  });
  it('rejects logs returned for a different page even when they are inside the overall catch-up window', async () => {
    const fetcher = limitedEvmRpc(123, (from) =>
      from === 100
        ? [
            {
              address: factory,
              topics: [PAIR_CREATED_TOPIC, topic(factory), topic(pair)],
              data: topic(pair) + '0'.repeat(63) + '1',
              transactionHash: transaction,
              blockHash: hash,
              blockNumber: '0x6e',
              logIndex: '0x0',
            },
          ]
        : [],
    );
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    await expect(
      runRpc(() => connector.fetch({ blockNumber: 99, blockHash: hash })),
    ).rejects.toThrow('范围');
  });
  it('refuses a checkpoint hash mismatch and never issues forward getLogs', async () => {
    const fetcher = rpcFetch((method) => (method === 'eth_chainId' ? '0x1' : block));
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    await expect(
      runRpc(() => connector.fetch({ blockNumber: 99, blockHash: '0x' + 'e'.repeat(64) })),
    ).rejects.toThrow('重组');
    expect(
      fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).method),
    ).not.toContain('eth_getLogs');
  });
  it('does not use an incorrect EVM chain with a mainnet explorer link', async () => {
    await expect(
      runRpc(() =>
        new EvmFactoryConnector(
          'https://rpc.example',
          factory,
          rpcFetch(() => '0xa'),
        ).fetch(),
      ),
    ).rejects.toThrow('链ID不匹配');
  });
  it('declares missing RPC scope unconfigured', async () => {
    expect((await new SolanaMintConnector('https://rpc.example').healthCheck()).status).toBe(
      'unconfigured',
    );
    expect((await new EvmFactoryConnector().healthCheck()).status).toBe('unconfigured');
  });
  it('stops on a Solana history gap rather than advancing past uncollected transactions', async () => {
    const signature = '1'.repeat(64);
    const fetcher = rpcFetch(() =>
      Array.from({ length: 100 }, (_, i) => ({ signature, slot: i, err: null, blockTime: null })),
    );
    await expect(
      runRpc(() =>
        new SolanaMintConnector('https://rpc.example', '1'.repeat(32), fetcher).fetch({
          signature: '2'.repeat(64),
        }),
      ),
    ).rejects.toThrow('缺口');
  });
  it('parses only SPL initializeMint instructions from finalized program transactions', async () => {
    const signature = '1'.repeat(64);
    const mint = '2'.repeat(32);
    const fetcher = rpcFetch((method) =>
      method === 'getSignaturesForAddress'
        ? [{ signature, slot: 99, err: null, blockTime: null }]
        : {
            blockTime: null,
            slot: 99,
            meta: { err: null, innerInstructions: [] },
            transaction: {
              message: {
                instructions: [
                  {
                    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                    parsed: {
                      type: 'initializeMint2',
                      info: { mint, mintAuthority: '3'.repeat(32) },
                    },
                  },
                ],
              },
            },
          },
    );
    const connector = new SolanaMintConnector('https://rpc.example', '1'.repeat(32), fetcher);
    const result = await runRpc(() => connector.fetch());
    expect(result.items).toHaveLength(1);
    expect(result.cursor.signature).toBe(signature);
    expect(connector.normalize(result.items[0]!).verificationStatus).toBe('UNVERIFIED');
    expect(connector.normalize(result.items[0]!).sourcePublishedAt).toBeNull();
  });
  it('opts into v1 transactions and parses Token-2022 mint initialization in inner instructions', async () => {
    const signature = '1'.repeat(64);
    const mint = '2'.repeat(32);
    const fetcher = solanaVersionRpc([signature], () => ({ result: solanaTransaction(1, mint) }));
    const connector = new SolanaMintConnector('https://rpc.example', '1'.repeat(32), fetcher);
    const result = await runRpc(() => connector.fetch());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.payload.mint).toBe(mint);
    expect(result.cursor.signature).toBe(signature);
    expect(connector.normalize(result.items[0]!).sourcePublishedAt).toBeNull();
    const request = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(request.params[1]).toEqual({
      commitment: 'finalized',
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 1,
    });
  });
  it.each(['legacy', 0] as const)(
    'continues reading %s transactions with v1 support enabled',
    async (version) => {
      const signature = '1'.repeat(64);
      const fetcher = solanaVersionRpc([signature], () => ({ result: solanaTransaction(version) }));
      const connector = new SolanaMintConnector('https://rpc.example', '1'.repeat(32), fetcher);
      const result = await runRpc(() => connector.fetch());
      expect(result.items).toHaveLength(1);
      expect(result.cursor.signature).toBe(signature);
    },
  );
  it('preserves the cursor and hides provider text when a later transaction has an unsupported version', async () => {
    const signatures = ['4'.repeat(64), '3'.repeat(64), '2'.repeat(64)];
    const providerSecret = 'fixture-provider-key-never-display';
    const fetcher = solanaVersionRpc(signatures, (signature) =>
      signature === signatures[1]
        ? {
            error: {
              code: -32015,
              message: `Unsupported version at https://rpc.example/${providerSecret}`,
            },
          }
        : { result: solanaTransaction(1) },
    );
    const connector = new SolanaMintConnector('https://rpc.example', '1'.repeat(32), fetcher);
    const cursor = { signature: '1'.repeat(64), slot: 97 };
    const error = await runRpc(() => connector.fetch(cursor)).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ classification: 'PERMANENT' });
    expect((error as Error).message).toContain('交易版本');
    expect((error as Error).message).toContain('-32015');
    expect((error as Error).message).not.toContain(providerSecret);
    expect((error as Error).message).not.toContain('https://');
    expect(cursor).toEqual({ signature: '1'.repeat(64), slot: 97 });
    const fetchedSignatures = fetcher.mock.calls.flatMap((call) => {
      const request = JSON.parse(String(call[1]?.body));
      return request.method === 'getTransaction' ? [request.params[0]] : [];
    });
    expect(fetchedSignatures).toEqual([signatures[2], signatures[1]]);
  });
  it('preserves the cursor when finalized transaction history is unavailable', async () => {
    const fetcher = solanaVersionRpc(['2'.repeat(64)], () => ({ result: null }));
    const connector = new SolanaMintConnector('https://rpc.example', '1'.repeat(32), fetcher);
    const cursor = { signature: '1'.repeat(64), slot: 97 };
    await expect(runRpc(() => connector.fetch(cursor))).rejects.toThrow('历史暂不可得');
    expect(cursor).toEqual({ signature: '1'.repeat(64), slot: 97 });
  });
  it('rejects a transaction version above the supported range without advancing its cursor', async () => {
    const fetcher = solanaVersionRpc(['2'.repeat(64)], () => ({ result: solanaTransaction(2) }));
    const connector = new SolanaMintConnector('https://rpc.example', '1'.repeat(32), fetcher);
    const cursor = { signature: '1'.repeat(64), slot: 97 };
    const error = await runRpc(() => connector.fetch(cursor)).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ classification: 'PERMANENT' });
    expect((error as Error).message).toContain('交易版本');
    expect(cursor).toEqual({ signature: '1'.repeat(64), slot: 97 });
  });
});
