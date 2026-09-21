/**
 * The RPC-backed log source.
 *
 * The adapter the domain's `LogSource` port exists for when the producer is a node rather than a
 * file. Fetch is injected through `JsonRpcClient` so a happy-path log, an HTTP refusal, and a
 * JSON-RPC error object are all checkable without a network.
 *
 * The history is fetched in bounded block pages: `eth_blockNumber` first, then one `eth_getLogs`
 * per page, and a page the node refuses is halved and retried.
 */

import { describe, expect, it } from 'vitest';

import { JsonRpcClient, RpcMalformed, RpcUnavailable } from '../../src/adapters/json_rpc_client.js';
import { RpcLogSource } from '../../src/adapters/log_source_rpc.js';

const URL = 'http://rpc.test';
const FACTORY = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const PREMIUM = '0x3333333333333333333333333333333333333333';
const ADDRESSES = [FACTORY, REGISTRY, PREMIUM] as const;

/** A mock node: `eth_blockNumber` answers `head`, `eth_getLogs` answers per requested range. */
interface Node {
  head: bigint;
  logsFor: (fromBlock: string, toBlock: string) => unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function postedBody(init: RequestInit | undefined): { method?: string; params?: unknown } {
  if (typeof init?.body !== 'string') {
    throw new Error('expected a JSON string body');
  }
  return JSON.parse(init.body) as { method?: string; params?: unknown };
}

function sourceOf(node: Node): RpcLogSource {
  const fetchImpl: typeof fetch = (_input, init): Promise<Response> => {
    const { method, params } = postedBody(init);
    if (method === 'eth_blockNumber') {
      return Promise.resolve(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: `0x${node.head.toString(16)}` }),
      );
    }
    if (method === 'eth_getLogs') {
      const filter = (params as unknown[])[0] as { fromBlock: string; toBlock: string };
      const answer = node.logsFor(filter.fromBlock, filter.toBlock);
      // A node refusal is a JSON-RPC error object, which the mock returns as the whole body.
      if (
        answer !== null &&
        typeof answer === 'object' &&
        'error' in (answer as Record<string, unknown>)
      ) {
        return Promise.resolve(jsonResponse(answer));
      }
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: answer }));
    }
    return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: null }));
  };
  return new RpcLogSource({
    client: new JsonRpcClient({ url: URL, fetchImpl }),
    addresses: ADDRESSES,
  });
}

function log(address: string, block: number): Record<string, unknown> {
  return {
    address,
    topics: ['0xabc'],
    data: '0xdef',
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: '0xdead',
  };
}

describe('RpcLogSource', () => {
  it('maps one eth_getLogs record onto a RawLog whose emitter is address', async () => {
    const requests: { fromBlock: string; toBlock: string }[] = [];
    const source = sourceOf({
      head: 25_000n,
      logsFor: (fromBlock, toBlock) => {
        requests.push({ fromBlock, toBlock });
        return [];
      },
    });
    expect(await source.logs()).toEqual([]);
    // 25,001 blocks page at 10,000: three pages, the last one short.
    expect(requests).toEqual([
      { fromBlock: '0x0', toBlock: '0x270f' },
      { fromBlock: '0x2710', toBlock: '0x4e1f' },
      { fromBlock: '0x4e20', toBlock: '0x61a8' },
    ]);
  });

  it('concatenates pages in block order', async () => {
    const source = sourceOf({
      head: 12_000n,
      logsFor: (fromBlock, toBlock) => {
        const from = Number(fromBlock);
        const to = Number(toBlock);
        return [log(FACTORY, from), log(REGISTRY, to)];
      },
    });
    const logs = await source.logs();
    // Two pages (0..9999 and 10000..12000), two logs each.
    expect(logs).toEqual([
      { emitter: FACTORY, topics: ['0xabc'], data: '0xdef' },
      { emitter: REGISTRY, topics: ['0xabc'], data: '0xdef' },
      { emitter: FACTORY, topics: ['0xabc'], data: '0xdef' },
      { emitter: REGISTRY, topics: ['0xabc'], data: '0xdef' },
    ]);
  });

  it('halves a refused page and retries until the logs come back', async () => {
    const refused = new Set<string>();
    const source = sourceOf({
      head: 30_000n,
      logsFor: (fromBlock, toBlock) => {
        // Refuse the first (full-width) page once; the halves succeed.
        const key = `${fromBlock}-${toBlock}`;
        if (key === '0x0-0x270f') {
          refused.add(key);
          return {
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32005, message: 'query returned more than 10000 results' },
          };
        }
        return [log(FACTORY, Number(fromBlock))];
      },
    });
    const logs = await source.logs();
    expect(refused.has('0x0-0x270f')).toBe(true);
    // First page refused once, then halved into two successful halves; pages 2, 3 and the
    // single-block page 4 succeed whole: 2 + 1 + 1 + 1 = 5 logs.
    expect(logs.length).toBe(5);
  });

  it('propagates a refusal that survives halving down to a single block', async () => {
    const source = sourceOf({
      head: 5_000n,
      logsFor: () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'invalid params' },
      }),
    });
    await expect(source.logs()).rejects.toThrow(RpcMalformed);
    await expect(source.logs()).rejects.toThrow(/invalid params/);
  });

  it('an HTTP error is unavailable rather than malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(new Response('down', { status: 502 }));
    const source = new RpcLogSource({
      client: new JsonRpcClient({ url: URL, fetchImpl }),
      addresses: ADDRESSES,
    });
    await expect(source.logs()).rejects.toThrow(RpcUnavailable);
    await expect(source.logs()).rejects.toThrow(/HTTP 502/);
  });

  it('an empty result is an empty log stream', async () => {
    const source = sourceOf({ head: 0n, logsFor: () => [] });
    expect(await source.logs()).toEqual([]);
  });

  it('refuses a result that is not a log array', async () => {
    const source = sourceOf({ head: 100n, logsFor: () => ({ logs: [] }) });
    await expect(source.logs()).rejects.toThrow(RpcMalformed);
  });

  it('refuses a log whose address, topics or data are the wrong shape', async () => {
    const bad = async (result: unknown): Promise<void> => {
      const source = sourceOf({ head: 100n, logsFor: () => result });
      await expect(source.logs()).rejects.toThrow(RpcMalformed);
    };
    await bad([null]);
    await bad([[]]);
    await bad([{ topics: ['0x'], data: '0x', address: 1 }]);
    await bad([{ address: FACTORY, topics: [1], data: '0x' }]);
    await bad([{ address: FACTORY, topics: ['0x'], data: 1 }]);
  });

  it('refuses an eth_blockNumber that is not a hex quantity', async () => {
    const fetchImpl: typeof fetch = (_input, init): Promise<Response> => {
      const { method } = postedBody(init);
      if (method === 'eth_blockNumber') {
        return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: 'latest' }));
      }
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: [] }));
    };
    const source = new RpcLogSource({
      client: new JsonRpcClient({ url: URL, fetchImpl }),
      addresses: ADDRESSES,
    });
    await expect(source.logs()).rejects.toThrow(/eth_blockNumber/);
  });
});
