/**
 * The EIP-1193 wallet adapter.
 *
 * Wraps an injected provider (`window.ethereum` in a browser, a test double in tests) behind the
 * `WalletProvider` port. The three methods map onto three JSON-RPC calls: `eth_requestAccounts`,
 * `eth_call` and `eth_sendTransaction`. A missing provider is a refusal naming the gap — the app
 * must not pretend a wallet exists — and a rejected request surfaces the provider's own error.
 */

import { type WalletProvider, type WalletTx } from '../domain/ports.js';

/** The EIP-1193 provider surface this adapter needs. */
export interface Eip1193Provider {
  request(options: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** A wallet backed by an injected EIP-1193 provider. */
export class Eip1193Wallet implements WalletProvider {
  readonly provider: Eip1193Provider;

  constructor(provider: Eip1193Provider) {
    this.provider = provider;
  }

  async connect(): Promise<string> {
    const accounts = (await this.provider.request({
      method: 'eth_requestAccounts',
      params: [],
    })) as unknown[];
    const account = accounts[0];
    if (typeof account !== 'string' || account.length === 0) {
      throw new Error('wallet returned no account');
    }
    return account;
  }

  async read(address: string, calldata: string): Promise<string> {
    const result = await this.provider.request({
      method: 'eth_call',
      params: [{ to: address, data: calldata }, 'latest'],
    });
    if (typeof result !== 'string') {
      throw new Error('eth_call returned a non-string result');
    }
    return result;
  }

  async send(tx: WalletTx): Promise<string> {
    const hash = await this.provider.request({
      method: 'eth_sendTransaction',
      params: [{ to: tx.to, data: tx.data }],
    });
    if (typeof hash !== 'string') {
      throw new Error('eth_sendTransaction returned a non-string hash');
    }
    return hash;
  }
}

/** The injected provider, or a refusal naming the gap when no wallet is installed. */
export function injectedWallet(provider: unknown): Eip1193Wallet {
  if (provider === null || provider === undefined) {
    throw new Error('no injected wallet: install a wallet extension to broadcast');
  }
  return new Eip1193Wallet(provider as Eip1193Provider);
}
