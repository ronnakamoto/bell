/**
 * The EIP-1193 wallet adapter.
 *
 * A mock provider records the JSON-RPC requests; the tests assert the three methods map onto the
 * right calls and that a missing provider or a malformed result is refused by name.
 */

import { describe, expect, it } from 'vitest';

import { type Eip1193Provider, Eip1193Wallet, injectedWallet } from '../../src/adapters/wallet.js';

const ACCOUNT = '0x7777777777777777777777777777777777777777';
const HASH = `0x${'ab'.repeat(32)}`;

function providerOf(handler: (method: string, params: unknown[]) => unknown): Eip1193Provider {
  return {
    request: (options: { method: string; params?: unknown[] }): Promise<unknown> =>
      Promise.resolve(handler(options.method, options.params ?? [])),
  };
}

describe('Eip1193Wallet', () => {
  it('connects via eth_requestAccounts and returns the first account', async () => {
    const wallet = new Eip1193Wallet(
      providerOf((method) => (method === 'eth_requestAccounts' ? [ACCOUNT] : null)),
    );
    expect(await wallet.connect()).toBe(ACCOUNT);
  });

  it('refuses a connect that returns no account', async () => {
    const wallet = new Eip1193Wallet(providerOf(() => []));
    await expect(wallet.connect()).rejects.toThrow(/no account/);
  });

  it('reads via eth_call with the address, calldata and latest block', async () => {
    let seen: { method: string; params: unknown[] } | undefined;
    const wallet = new Eip1193Wallet({
      request: (options: { method: string; params?: unknown[] }): Promise<unknown> => {
        seen = { method: options.method, params: options.params ?? [] };
        return Promise.resolve(`0x${'00'.repeat(32)}`);
      },
    });
    const result = await wallet.read('0x1111', '0xdeadbeef');
    expect(result).toBe(`0x${'00'.repeat(32)}`);
    expect(seen?.method).toBe('eth_call');
    expect(seen?.params).toEqual([{ to: '0x1111', data: '0xdeadbeef' }, 'latest']);
  });

  it('refuses a read that returns a non-string result', async () => {
    const wallet = new Eip1193Wallet(providerOf(() => 42));
    await expect(wallet.read('0x1111', '0xdeadbeef')).rejects.toThrow(/non-string/);
  });

  it('sends via eth_sendTransaction and returns the hash', async () => {
    let seen: { method: string; params: unknown[] } | undefined;
    const wallet = new Eip1193Wallet({
      request: (options: { method: string; params?: unknown[] }): Promise<unknown> => {
        seen = { method: options.method, params: options.params ?? [] };
        return Promise.resolve(HASH);
      },
    });
    const hash = await wallet.send({ to: '0x1111', data: '0xdeadbeef' });
    expect(hash).toBe(HASH);
    expect(seen?.method).toBe('eth_sendTransaction');
    expect(seen?.params).toEqual([{ to: '0x1111', data: '0xdeadbeef' }]);
  });

  it('refuses a send that returns a non-string hash', async () => {
    const wallet = new Eip1193Wallet(providerOf(() => null));
    await expect(wallet.send({ to: '0x1111', data: '0xdeadbeef' })).rejects.toThrow(/non-string/);
  });
});

describe('injectedWallet', () => {
  it('refuses a missing provider by name', () => {
    expect(() => injectedWallet(undefined)).toThrow(/no injected wallet/);
  });

  it('wraps a present provider', () => {
    const wallet = injectedWallet(providerOf(() => [ACCOUNT]));
    expect(wallet).toBeInstanceOf(Eip1193Wallet);
  });
});
