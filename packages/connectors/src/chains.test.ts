import { describe, expect, it, vi } from 'vitest';
import { EvmFactoryConnector, SolanaMintConnector, PAIR_CREATED_TOPIC } from './chains.js';
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
describe('chain adapters preserve bounded coverage and durable cursors', () => {
  it('collects finalized V2 pair creation and does not claim liquidity or source publication time', async () => {
    const fetcher = rpcFetch((method) =>
      method === 'eth_chainId'
        ? '0x1'
        : method === 'eth_getLogs'
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
          : block,
    );
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    const result = await connector.fetch();
    expect(result.cursor.blockNumber).toBe(100);
    expect(result.items).toHaveLength(1);
    const event = connector.normalize(result.items[0]!);
    expect(event.eventType).toBe('PAIR_CREATED');
    expect(event.sourcePublishedAt).toBeNull();
    expect(event.assetKey).toBe(`ethereum:pair:${pair}`);
    expect(event.project?.stage).toBe('UNVERIFIED');
    expect(event.riskFlags).toContain('UNKNOWN_LIQUIDITY');
  });
  it('refuses a checkpoint hash mismatch and never issues forward getLogs', async () => {
    const fetcher = rpcFetch((method) => (method === 'eth_chainId' ? '0x1' : block));
    const connector = new EvmFactoryConnector('https://rpc.example', factory, fetcher);
    await expect(
      connector.fetch({ blockNumber: 99, blockHash: '0x' + 'e'.repeat(64) }),
    ).rejects.toThrow('重组');
    expect(
      fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).method),
    ).not.toContain('eth_getLogs');
  });
  it('does not use an incorrect EVM chain with a mainnet explorer link', async () => {
    await expect(
      new EvmFactoryConnector(
        'https://rpc.example',
        factory,
        rpcFetch(() => '0xa'),
      ).fetch(),
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
      new SolanaMintConnector('https://rpc.example', '1'.repeat(32), fetcher).fetch({
        signature: '2'.repeat(64),
      }),
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
    const result = await connector.fetch();
    expect(result.items).toHaveLength(1);
    expect(result.cursor.signature).toBe(signature);
    expect(connector.normalize(result.items[0]!).verificationStatus).toBe('UNVERIFIED');
    expect(connector.normalize(result.items[0]!).sourcePublishedAt).toBeNull();
  });
});
