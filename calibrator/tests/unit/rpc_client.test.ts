/**
 * The JSON-RPC client: transport failures become `RpcUnavailable`, envelope failures become
 * `RpcMalformed`, and a well-formed reply returns its result. Fetch is injected, so no socket.
 */

import { describe, expect, it } from 'vitest';

import { JsonRpcClient, RpcMalformed, RpcUnavailable } from '../../src/adapters/rpc_client.js';

function responseOf(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('JsonRpcClient.call', () => {
  it('posts the method and params and returns the result', async () => {
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      expect(typeof input).toBe('string');
      const body = JSON.parse(init?.body as string) as { method: string; params: unknown };
      expect(body.method).toBe('eth_chainId');
      expect(body.params).toEqual([]);
      return Promise.resolve(
        responseOf(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' })),
      );
    };
    const client = new JsonRpcClient({ url: 'http://node', fetchImpl });
    await expect(client.call('eth_chainId', [])).resolves.toBe('0x10');
  });

  it('turns a refused connection into RpcUnavailable', async () => {
    const fetchImpl = (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    const client = new JsonRpcClient({ url: 'http://node', fetchImpl });
    await expect(client.call('eth_chainId', [])).rejects.toBeInstanceOf(RpcUnavailable);
  });

  it('turns a non-OK status into RpcUnavailable', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(responseOf(500, 'boom'));
    const client = new JsonRpcClient({ url: 'http://node', fetchImpl });
    await expect(client.call('eth_chainId', [])).rejects.toBeInstanceOf(RpcUnavailable);
  });

  it('turns a non-JSON body into RpcMalformed', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(responseOf(200, 'not json'));
    const client = new JsonRpcClient({ url: 'http://node', fetchImpl });
    await expect(client.call('eth_chainId', [])).rejects.toBeInstanceOf(RpcMalformed);
  });

  it('turns a JSON-RPC error member into RpcMalformed', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        responseOf(
          200,
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } }),
        ),
      );
    const client = new JsonRpcClient({ url: 'http://node', fetchImpl });
    await expect(client.call('eth_chainId', [])).rejects.toBeInstanceOf(RpcMalformed);
  });

  it('turns a missing result member into RpcMalformed', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(responseOf(200, JSON.stringify({ jsonrpc: '2.0', id: 1 })));
    const client = new JsonRpcClient({ url: 'http://node', fetchImpl });
    await expect(client.call('eth_chainId', [])).rejects.toBeInstanceOf(RpcMalformed);
  });
});
