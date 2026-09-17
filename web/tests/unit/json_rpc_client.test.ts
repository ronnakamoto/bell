/**
 * The JSON-RPC client the live quote source uses.
 *
 * Fetch is injected so a refused node, a refused HTTP status, and a JSON-RPC error object are all
 * exercised without a network. The envelope is the contract: method and params travel as a 2.0 POST
 * with a fixed id, and the only values that come back are `result` or a typed refusal.
 */

import { describe, expect, it } from 'vitest';

import { JsonRpcClient, RpcMalformed, RpcUnavailable } from '../../src/adapters/json_rpc_client.js';

const URL = 'http://rpc.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function postedBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') {
    throw new Error('expected a JSON string body');
  }
  return JSON.parse(init.body) as unknown;
}

describe('JsonRpcClient.call', () => {
  it('POSTs a JSON-RPC 2.0 envelope and returns result', async () => {
    let requested = '';
    let init: RequestInit | undefined;
    const fetchImpl: typeof fetch = (input, requestInit): Promise<Response> => {
      if (typeof input !== 'string') {
        throw new Error('expected a string url');
      }
      requested = input;
      init = requestInit;
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    };
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).resolves.toBe('0x1');
    expect(requested).toBe(URL);
    expect(init?.method).toBe('POST');
    expect(postedBody(init)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    });
  });

  it('defaults to globalThis.fetch when fetchImpl is omitted', async () => {
    const original = globalThis.fetch;
    let usedDefault = false;
    globalThis.fetch = (): Promise<Response> => {
      usedDefault = true;
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: 7 }));
    };
    try {
      const client = new JsonRpcClient({ url: URL });
      await expect(client.call('eth_chainId', [])).resolves.toBe(7);
      expect(usedDefault).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('a transport failure is unavailable rather than malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.reject(new TypeError('fetch failed'));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcUnavailable);
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(/fetch failed/);
  });

  it('an HTTP non-OK response is unavailable rather than malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(new Response('down', { status: 503 }));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcUnavailable);
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(/HTTP 503/);
  });

  it('an unparseable body is malformed rather than unavailable', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(new Response('{', { status: 200 }));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
  });

  it('a JSON-RPC error object is malformed rather than unavailable', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'unauthorized' } }),
      );
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(/unauthorized/);
  });

  it('a non-object JSON body is malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> => Promise.resolve(jsonResponse([]));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
  });

  it('a null JSON body is malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> => Promise.resolve(jsonResponse(null));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
  });

  it('a primitive JSON body is malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> => Promise.resolve(jsonResponse(1));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
  });

  it('a JSON-RPC error without a message still refuses', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000 } }));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
  });

  it('a JSON-RPC error that is not an object still refuses', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, error: 'boom' }));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(/boom/);
  });

  it('a JSON-RPC error array still refuses', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, error: ['boom'] }));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
  });

  it('a success object without result is malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1 }));
    const client = new JsonRpcClient({ url: URL, fetchImpl });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow(RpcMalformed);
  });
});
