// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BroadcastButton } from '../../src/components/BroadcastButton.js';
import { buildBuyLong } from '../../src/domain/trade.js';

const SESSION = '0x1111111111111111111111111111111111111111';
const COLLATERAL = '0x2222222222222222222222222222222222222222';
const ACCOUNT = '0x7777777777777777777777777777777777777777';

function addressWord(address: string): string {
  return `0x${'00'.repeat(12)}${address.slice(2)}`;
}

/** A mock EIP-1193 provider answering the read and recording sends. */
function mockProvider(): {
  provider: { request(options: { method: string; params?: unknown[] }): Promise<unknown> };
  sent: { to: string; data: string }[];
} {
  const sent: { to: string; data: string }[] = [];
  return {
    sent,
    provider: {
      request: (options: { method: string; params?: unknown[] }): Promise<unknown> => {
        if (options.method === 'eth_requestAccounts') return Promise.resolve([ACCOUNT]);
        if (options.method === 'eth_call') {
          const params = options.params as [{ to: string; data: string }, string];
          if (params[0].data === '0xd8dfeb45') return Promise.resolve(addressWord(COLLATERAL));
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

describe('BroadcastButton', () => {
  it('broadcasts the batch and shows one hash per step', async () => {
    const { provider, sent } = mockProvider();
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    const batch = buildBuyLong({ collateralIn: 50n, minLongOut: 1n });
    render(<BroadcastButton build={() => batch} targets={{ session: SESSION }} />);

    fireEvent.click(screen.getByTestId('broadcast'));
    await waitFor(() => expect(screen.getByTestId('broadcast-hashes')).toBeInTheDocument());

    expect(sent).toHaveLength(2);
    expect(sent[0]?.to).toBe(COLLATERAL);
    expect(sent[1]?.to).toBe(SESSION);
    expect(screen.getAllByTestId('broadcast-hashes')[0]).toBeInTheDocument();
  });

  it('shows the refusal when no wallet is injected', async () => {
    const batch = buildBuyLong({ collateralIn: 50n, minLongOut: 1n });
    render(<BroadcastButton build={() => batch} targets={{ session: SESSION }} />);

    fireEvent.click(screen.getByTestId('broadcast'));
    await waitFor(() => expect(screen.getByTestId('broadcast-error')).toBeInTheDocument());
    expect(screen.getByTestId('broadcast-error')).toHaveTextContent(/no injected wallet/);
  });

  it('shows the domain error when the batch cannot be built', async () => {
    const { provider } = mockProvider();
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    render(
      <BroadcastButton
        build={() => buildBuyLong({ collateralIn: 0n, minLongOut: 1n })}
        targets={{ session: SESSION }}
      />,
    );

    fireEvent.click(screen.getByTestId('broadcast'));
    await waitFor(() => expect(screen.getByTestId('broadcast-error')).toBeInTheDocument());
    expect(screen.getByTestId('broadcast-error')).toHaveTextContent(/must be positive/);
  });
});
