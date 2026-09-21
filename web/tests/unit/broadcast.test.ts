/**
 * The broadcast use case.
 *
 * A mock wallet records the reads and sends; the tests assert target resolution (which addresses
 * are read, from where), step sequencing (intent order preserved), and the named refusals.
 */

import { nobleKeccak } from '@bell/settlement/adapters/keccak_noble.js';
import { describe, expect, it } from 'vitest';

import { broadcastIntents } from '../../src/application/broadcast.js';
import { buildChallenge } from '../../src/domain/challenge_intent.js';
import { type WalletProvider, type WalletTx } from '../../src/domain/ports.js';
import { buildClaim } from '../../src/domain/settlement.js';
import { buildBuyLong } from '../../src/domain/trade.js';

const SESSION = '0x1111111111111111111111111111111111111111';
const PREMIUM = '0x2222222222222222222222222222222222222222';
const COLLATERAL = '0x3333333333333333333333333333333333333333';
const LONG_CLAIM = '0x4444444444444444444444444444444444444444';
const SHORT_CLAIM = '0x5555555555555555555555555555555555555555';
const BOND = '0x6666666666666666666666666666666666666666';
const ACCOUNT = '0x7777777777777777777777777777777777777777';

function addressWord(address: string): string {
  return `0x${'00'.repeat(12)}${address.slice(2)}`;
}

/** A wallet whose reads and sends are recorded, with a configurable read table. */
function walletOf(reads: Readonly<Record<string, string>>): {
  wallet: WalletProvider;
  sent: WalletTx[];
  readCalls: { address: string; calldata: string }[];
} {
  const sent: WalletTx[] = [];
  const readCalls: { address: string; calldata: string }[] = [];
  return {
    sent,
    readCalls,
    wallet: {
      connect: (): Promise<string> => Promise.resolve(ACCOUNT),
      read: (address: string, calldata: string): Promise<string> => {
        readCalls.push({ address, calldata });
        const result = reads[`${address}:${calldata}`];
        if (result === undefined) throw new Error(`no mock read for ${address} ${calldata}`);
        return Promise.resolve(result);
      },
      send: (tx: WalletTx): Promise<string> => {
        sent.push(tx);
        return Promise.resolve(`0x${sent.length.toString(16).padStart(64, '0')}`);
      },
    },
  };
}

describe('broadcastIntents', () => {
  it('sends a buy-long batch in intent order, resolving collateral from the session', async () => {
    const { wallet, sent, readCalls } = walletOf({
      [`${SESSION}:0xd8dfeb45`]: addressWord(COLLATERAL),
    });
    const outcome = await broadcastIntents(
      buildBuyLong({ collateralIn: 50n, minLongOut: 1n }),
      { session: SESSION },
      wallet,
      nobleKeccak,
    );

    expect(outcome.account).toBe(ACCOUNT);
    expect(outcome.hashes).toHaveLength(2);
    expect(sent.map((tx) => tx.to)).toEqual([COLLATERAL, SESSION]);
    // approve first, then buyLong — the intent order is preserved.
    expect(sent[0]?.data.startsWith('0x095ea7b3')).toBe(true);
    expect(sent[1]?.data.startsWith('0xcdff7616')).toBe(true);
    // collateral was read from the session, once.
    expect(readCalls).toEqual([{ address: SESSION, calldata: '0xd8dfeb45' }]);
  });

  it('resolves longClaim and shortClaim for an LP batch', async () => {
    const { wallet, sent, readCalls } = walletOf({
      [`${SESSION}:0x1671ce49`]: addressWord(LONG_CLAIM),
      [`${SESSION}:0x223b052d`]: addressWord(SHORT_CLAIM),
    });
    await broadcastIntents(
      {
        kind: 'mintThenSeed',
        steps: [
          { label: 'm', target: 'session', method: 'mintPair', args: [100n] },
          { label: 'a', target: 'longClaim', method: 'approve', args: [60n] },
          { label: 'a', target: 'shortClaim', method: 'approve', args: [40n] },
          { label: 's', target: 'session', method: 'seedPool', args: [60n, 40n] },
        ],
      },
      { session: SESSION },
      wallet,
      nobleKeccak,
    );
    expect(sent.map((tx) => tx.to)).toEqual([SESSION, LONG_CLAIM, SHORT_CLAIM, SESSION]);
    expect(readCalls).toEqual([
      { address: SESSION, calldata: '0x1671ce49' },
      { address: SESSION, calldata: '0x223b052d' },
    ]);
  });

  it('resolves the challenge bond from the premium registry, not any session', async () => {
    const { wallet, sent, readCalls } = walletOf({
      [`${PREMIUM}:0xc28f4392`]: addressWord(BOND),
    });
    const nameId = `0x${'cd'.repeat(32)}`;
    await broadcastIntents(
      buildChallenge({ nameId, forSession: 7n }),
      { premium: PREMIUM },
      wallet,
      nobleKeccak,
    );
    expect(sent.map((tx) => tx.to)).toEqual([BOND, PREMIUM]);
    expect(readCalls).toEqual([{ address: PREMIUM, calldata: '0xc28f4392' }]);
  });

  it('reads nothing for a batch whose targets are all given', async () => {
    const { wallet, readCalls } = walletOf({});
    await broadcastIntents(buildClaim(), { session: SESSION }, wallet, nobleKeccak);
    expect(readCalls).toEqual([]);
  });

  it('refuses a session batch given no session address', async () => {
    const { wallet } = walletOf({});
    await expect(broadcastIntents(buildClaim(), {}, wallet, nobleKeccak)).rejects.toThrow(
      /session target used but no session address/,
    );
  });

  it('refuses a challenge batch given no premium address', async () => {
    const { wallet } = walletOf({});
    await expect(
      broadcastIntents(
        buildChallenge({ nameId: `0x${'cd'.repeat(32)}`, forSession: 7n }),
        {},
        wallet,
        nobleKeccak,
      ),
    ).rejects.toThrow(/premium target used but no premium address/);
  });
});
