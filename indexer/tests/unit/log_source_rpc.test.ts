/**
 * The RPC-backed log source.
 *
 * The adapter the domain's `LogSource` port exists for when the producer is a node rather than a
 * file. Fetch is injected through `JsonRpcClient` so a happy-path log, an HTTP refusal, and a
 * JSON-RPC error object are all checkable without a network.
 */

import { describe, expect, it } from 'vitest';

import { JsonRpcClient, RpcMalformed, RpcUnavailable } from '../../src/adapters/json_rpc_client.js';
import { RpcLogSource } from '../../src/adapters/log_source_rpc.js';

const URL = 'http://rpc.test';
const FACTORY = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const PREMIUM = '0x3333333333333333333333333333333333333333';
const ADDRESSES = [FACTORY, REGISTRY, PREMIUM] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function postedBody(init: RequestInit | undefined): { method?: string; params?: unknown } {
  if (typeof init?.body !== 'string') {
    throw new Error('expected a JSON string body');
  }
  return JSON.parse(init.body) as { method?: string; params?: unknown };
}

function sourceOf(fetchImpl: typeof fetch): RpcLogSource {
  return new RpcLogSource({
    client: new JsonRpcClient({ url: URL, fetchImpl }),
    addresses: ADDRESSES,
  });
}

describe('RpcLogSource', () => {
  it('maps one eth_getLogs record onto a RawLog whose emitter is address', async () => {
    let envelope: { method?: string; params?: unknown } = {};
    const fetchImpl: typeof fetch = (_input, init): Promise<Response> => {
      envelope = postedBody(init);
      return Promise.resolve(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: [
            {
              address: FACTORY,
              topics: ['0xabc'],
              data: '0xdef',
              blockNumber: '0x1',
              transactionHash: '0xdead',
            },
          ],
        }),
      );
    };
    expect(await sourceOf(fetchImpl).logs()).toEqual([
      { emitter: FACTORY, topics: ['0xabc'], data: '0xdef' },
    ]);
    expect(envelope.method).toBe('eth_getLogs');
    expect(envelope.params).toEqual([
      { address: [...ADDRESSES], fromBlock: 'earliest', toBlock: 'latest' },
    ]);
  });

  it('an HTTP error is unavailable rather than malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(new Response('down', { status: 502 }));
    await expect(sourceOf(fetchImpl).logs()).rejects.toThrow(RpcUnavailable);
    await expect(sourceOf(fetchImpl).logs()).rejects.toThrow(/HTTP 502/);
  });

  it('a JSON-RPC error object is malformed rather than unavailable', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }),
      );
    await expect(sourceOf(fetchImpl).logs()).rejects.toThrow(RpcMalformed);
    await expect(sourceOf(fetchImpl).logs()).rejects.toThrow(/invalid params/);
  });

  it('an empty result is an empty log stream', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: [] }));
    expect(await sourceOf(fetchImpl).logs()).toEqual([]);
  });

  it('refuses a result that is not a log array', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: { logs: [] } }));
    await expect(sourceOf(fetchImpl).logs()).rejects.toThrow(RpcMalformed);
  });

  it('refuses a log whose address, topics or data are the wrong shape', async () => {
    const bad = async (result: unknown): Promise<void> => {
      const fetchImpl: typeof fetch = (): Promise<Response> =>
        Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result }));
      await expect(sourceOf(fetchImpl).logs()).rejects.toThrow(RpcMalformed);
    };
    await bad([null]);
    await bad([[]]);
    await bad([{ topics: ['0x'], data: '0x', address: 1 }]);
    await bad([{ address: FACTORY, topics: [1], data: '0x' }]);
    await bad([{ address: FACTORY, topics: ['0x'], data: 1 }]);
  });
});
