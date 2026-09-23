// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ResolveForm } from '../../src/components/ResolveForm.js';

const NAME_ID = '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';
const PREMIUM = '0x2222222222222222222222222222222222222222';
const ARBITER = '0x7777777777777777777777777777777777777777';
const OTHER = '0x8888888888888888888888888888888888888888';

function addressWord(address: string): string {
  return `0x${'00'.repeat(12)}${address.slice(2)}`;
}

/** A mock EIP-1193 provider answering arbiter() and recording sends. */
function providerOf(account: string): {
  provider: { request(options: { method: string; params?: unknown[] }): Promise<unknown> };
  sent: { to: string; data: string }[];
} {
  const sent: { to: string; data: string }[] = [];
  return {
    sent,
    provider: {
      request: (options: { method: string; params?: unknown[] }): Promise<unknown> => {
        if (options.method === 'eth_requestAccounts') return Promise.resolve([account]);
        if (options.method === 'eth_call') {
          const params = options.params as [{ to: string; data: string }, string];
          if (params[0].data === '0xfe25e00a') return Promise.resolve(addressWord(ARBITER));
          throw new Error(`no mock read for ${params[0].data}`);
        }
        if (options.method === 'eth_sendTransaction') {
          const params = options.params as [{ to: string; data: string }];
          sent.push(params[0]);
          return Promise.resolve(`0x${sent.length.toString(16).padStart(64, '0')}`);
        }
        return Promise.resolve(null);
      },
    },
  };
}

afterEach(() => {
  cleanup();
  delete (globalThis as { ethereum?: unknown }).ethereum;
});

describe('ResolveForm', () => {
  it('broadcasts the ruling when the connected account is the arbiter', async () => {
    const { provider, sent } = providerOf(ARBITER);
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    render(
      <ResolveForm
        nameId={NAME_ID}
        forSession="7"
        publisherCorrect={true}
        premiumAddress={PREMIUM}
      />,
    );

    fireEvent.click(screen.getByTestId('resolve-submit'));
    await waitFor(() => expect(screen.getByTestId('resolve-hashes')).toBeInTheDocument());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(PREMIUM);
    expect(sent[0]?.data.startsWith('0x0564e9d1')).toBe(true);
  });

  it('refuses a connected account that is not the arbiter, by name', async () => {
    const { provider, sent } = providerOf(OTHER);
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    render(
      <ResolveForm
        nameId={NAME_ID}
        forSession="7"
        publisherCorrect={false}
        premiumAddress={PREMIUM}
      />,
    );

    fireEvent.click(screen.getByTestId('resolve-submit'));
    await waitFor(() => expect(screen.getByTestId('resolve-error')).toBeInTheDocument());

    expect(screen.getByTestId('resolve-error')).toHaveTextContent(/only the arbiter/);
    expect(sent).toHaveLength(0);
  });

  it('refuses when no wallet is injected', async () => {
    render(
      <ResolveForm
        nameId={NAME_ID}
        forSession="7"
        publisherCorrect={true}
        premiumAddress={PREMIUM}
      />,
    );

    fireEvent.click(screen.getByTestId('resolve-submit'));
    await waitFor(() => expect(screen.getByTestId('resolve-error')).toBeInTheDocument());
    expect(screen.getByTestId('resolve-error')).toHaveTextContent(/no injected wallet/);
  });

  it('surfaces a broadcast failure as a named error', async () => {
    const { provider } = providerOf(ARBITER);
    const failing = {
      ...provider,
      request: (options: { method: string; params?: unknown[] }): Promise<unknown> => {
        if (options.method === 'eth_sendTransaction') {
          return Promise.reject(new Error('user rejected the request'));
        }
        return provider.request(options);
      },
    };
    (globalThis as { ethereum?: unknown }).ethereum = failing;
    render(
      <ResolveForm
        nameId={NAME_ID}
        forSession="7"
        publisherCorrect={true}
        premiumAddress={PREMIUM}
      />,
    );

    fireEvent.click(screen.getByTestId('resolve-submit'));
    await waitFor(() => expect(screen.getByTestId('resolve-error')).toBeInTheDocument());
    expect(screen.getByTestId('resolve-error')).toHaveTextContent(/user rejected the request/);
  });
});
