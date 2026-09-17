/**
 * The RPC-backed quote source.
 *
 * The adapter the domain's `QuoteSource` port exists for when the producer is a live
 * `PremiumRegistry` rather than a fixture file. Fetch is injected through `JsonRpcClient` so a
 * Usable/Fallback/Refuse decoding, an HTTP refusal, and a malformed ABI word are all checkable
 * without a network.
 */

import { describe, expect, it } from 'vitest';

import { JsonRpcClient, RpcMalformed, RpcUnavailable } from '../../src/adapters/json_rpc_client.js';
import { RpcQuoteSource } from '../../src/adapters/quote_source_rpc.js';

const URL = 'http://rpc.test';
const PREMIUM = '0x3333333333333333333333333333333333333333';
const SELECTOR = '0x7d989975';
const NAME_ID = '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';
const LAMBDA = 15_000_000_000_000_000_000n;
const PREMIUM_WAD = 174_000_000_000_000_000n;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function postedBody(init: RequestInit | undefined): { method?: string; params?: unknown } {
  if (typeof init?.body !== 'string') {
    throw new Error('expected a JSON string body');
  }
  return JSON.parse(init.body) as { method?: string; params?: unknown };
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function encodedQuote(verdict: 0 | 1 | 2, lambdaWad: bigint, premiumWad: bigint): string {
  return `0x${word(BigInt(verdict))}${word(lambdaWad)}${word(premiumWad)}`;
}

function sourceOf(fetchImpl: typeof fetch): RpcQuoteSource {
  return new RpcQuoteSource({
    client: new JsonRpcClient({ url: URL, fetchImpl }),
    premium: PREMIUM,
  });
}

describe('RpcQuoteSource', () => {
  it('quotes() is empty because RPC is lookup-oriented', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> => {
      throw new Error('quotes() must not call the node');
    };
    expect(await sourceOf(fetchImpl).quotes()).toEqual([]);
  });

  it('decodes a Usable eth_call result', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: encodedQuote(0, LAMBDA, PREMIUM_WAD),
        }),
      );
    await expect(sourceOf(fetchImpl).quote(NAME_ID, 1n)).resolves.toEqual({
      verdict: 'Usable',
      lambdaWad: LAMBDA,
      premiumWad: PREMIUM_WAD,
    });
  });

  it('decodes a Fallback eth_call result', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: encodedQuote(1, 10n ** 18n, 10n ** 17n),
        }),
      );
    await expect(sourceOf(fetchImpl).quote(NAME_ID, 2n)).resolves.toEqual({
      verdict: 'Fallback',
      lambdaWad: 10n ** 18n,
      premiumWad: 10n ** 17n,
    });
  });

  it('Refuse drops the wads even when the node filled them', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: encodedQuote(2, LAMBDA, PREMIUM_WAD),
        }),
      );
    const quote = await sourceOf(fetchImpl).quote(NAME_ID, 3n);
    expect(quote).toEqual({ verdict: 'Refuse' });
    expect(quote).not.toHaveProperty('premiumWad');
    expect(quote).not.toHaveProperty('lambdaWad');
  });

  it('POSTs eth_call with selector, 32-byte nameId, and uint256 forSession', async () => {
    let envelope: { method?: string; params?: unknown } = {};
    const fetchImpl: typeof fetch = (_input, init): Promise<Response> => {
      envelope = postedBody(init);
      return Promise.resolve(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: encodedQuote(0, 1n, 2n) }),
      );
    };
    await sourceOf(fetchImpl).quote(NAME_ID, 1n);
    expect(envelope.method).toBe('eth_call');
    const data = `${SELECTOR}${NAME_ID.slice(2)}${word(1n)}`;
    expect(envelope.params).toEqual([{ to: PREMIUM, data }, 'latest']);
  });

  it('strips or adds 0x so a bare nameId still encodes as 32 bytes', async () => {
    let data = '';
    const fetchImpl: typeof fetch = (_input, init): Promise<Response> => {
      const envelope = postedBody(init);
      const params = envelope.params as [{ data: string }];
      data = params[0].data;
      return Promise.resolve(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: encodedQuote(0, 1n, 2n) }),
      );
    };
    await sourceOf(fetchImpl).quote(NAME_ID.slice(2), 1n);
    expect(data).toBe(`${SELECTOR}${NAME_ID.slice(2)}${word(1n)}`);
  });

  it('strips a 0X prefix and left-pads a short nameId to 32 bytes', async () => {
    let data = '';
    const fetchImpl: typeof fetch = (_input, init): Promise<Response> => {
      const envelope = postedBody(init);
      const params = envelope.params as [{ data: string }];
      data = params[0].data;
      return Promise.resolve(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: encodedQuote(0, 1n, 2n) }),
      );
    };
    await sourceOf(fetchImpl).quote('0Xf1', 1n);
    expect(data).toBe(`${SELECTOR}${'0'.repeat(62)}f1${word(1n)}`);
  });

  it('an HTTP error is unavailable rather than malformed', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(new Response('down', { status: 502 }));
    await expect(sourceOf(fetchImpl).quote(NAME_ID, 1n)).rejects.toThrow(RpcUnavailable);
    await expect(sourceOf(fetchImpl).quote(NAME_ID, 1n)).rejects.toThrow(/HTTP 502/);
  });

  it('a JSON-RPC error object is malformed rather than unavailable', async () => {
    const fetchImpl: typeof fetch = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }),
      );
    await expect(sourceOf(fetchImpl).quote(NAME_ID, 1n)).rejects.toThrow(RpcMalformed);
    await expect(sourceOf(fetchImpl).quote(NAME_ID, 1n)).rejects.toThrow(/invalid params/);
  });

  it('refuses a result that is not 3 ABI words of hex', async () => {
    const bad = async (result: unknown): Promise<void> => {
      const fetchImpl: typeof fetch = (): Promise<Response> =>
        Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result }));
      await expect(sourceOf(fetchImpl).quote(NAME_ID, 1n)).rejects.toThrow(RpcMalformed);
    };
    await bad(1);
    await bad('0x');
    await bad(`0x${word(0n)}${word(1n)}`);
    await bad(`0x${word(3n)}${word(0n)}${word(0n)}`);
  });
});
