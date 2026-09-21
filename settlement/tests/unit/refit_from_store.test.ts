/**
 * Re-fit from a committed-input store: window → calibrate → λ/premium, or undefined.
 *
 * Missing windows and insufficient samples are ordinary unavailability, not exceptions. The runner
 * does not stub parameters; it calls `calibrate` on the stored bars.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { rowsDigest } from '@bell/calibrator/application/calibrate.js';
import { bytesFromHex, hexOf } from '@bell/calibrator/domain/bytes.js';
import { inputsHash } from '@bell/calibrator/domain/digest.js';
import { DailyBar, Wad } from '@bell/calibrator/domain/models.js';
import { describe, expect, it } from 'vitest';

import {
  FileCommittedInputStore,
  parseCommittedInputsDocument,
} from '../../src/adapters/committed_input_store_file.js';
import { nobleKeccak } from '../../src/adapters/keccak_noble.js';
import { refitFromStore } from '../../src/adapters/refit_from_store.js';
import { type CommittedInputStore, type CommittedWindow } from '../../src/domain/ports.js';

const STORE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/committed_inputs.json', import.meta.url),
);
const CHALLENGE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/challenge.json', import.meta.url),
);

const SAMPLE_HASH = `0x${'ab'.repeat(32)}`;
const SAMPLE_BAR = {
  tradingDate: '2020-01-06',
  closeWad: '100000000000000000000',
  nextOpenWad: '101000000000000000000',
};

interface ChallengeCaseRow {
  readonly label: string;
  readonly lambdaWad: string;
  readonly premiumWad: string;
  readonly inputsHash: string;
}

function challengeCases(): readonly ChallengeCaseRow[] {
  const document = JSON.parse(readFileSync(CHALLENGE_PATH, 'utf8')) as {
    cases: readonly ChallengeCaseRow[];
  };
  return document.cases;
}

function caseNamed(label: string): ChallengeCaseRow {
  const found = challengeCases().find((entry) => entry.label === label);
  if (found === undefined) throw new Error(`fixture has no ${label} case`);
  return found;
}

function fixtureStore(): FileCommittedInputStore {
  return new FileCommittedInputStore(
    parseCommittedInputsDocument(STORE_PATH, readFileSync(STORE_PATH, 'utf8')),
    nobleKeccak,
  );
}

function storeOf(window: CommittedWindow, hashHex = SAMPLE_HASH): FileCommittedInputStore {
  const payload = {
    windows: {
      [hashHex]: {
        symbol: window.symbol,
        session: window.session,
        windowSessions: window.windowSessions,
        sourceIds: window.sourceIds,
        familyName: window.familyName,
        bars: window.bars.map((bar) => ({
          tradingDate: bar.tradingDate,
          closeWad: String(bar.closeWad),
          nextOpenWad: String(bar.nextOpenWad),
        })),
      },
    },
  };
  return new FileCommittedInputStore(
    parseCommittedInputsDocument('/store.json', JSON.stringify(payload)),
    nobleKeccak,
  );
}

/** The `inputsHash` a window's own content produces, so a test can store a window under its own key. */
function hashOf(window: CommittedWindow): string {
  const digest = inputsHash(
    nobleKeccak,
    window.windowSessions,
    window.session,
    window.sourceIds,
    window.windowSessions,
    rowsDigestOf(window),
  );
  return `0x${hexOf(digest)}`;
}

function rowsDigestOf(window: CommittedWindow): Uint8Array {
  return rowsDigest(
    nobleKeccak,
    window.bars.map(
      (bar) => new DailyBar(bar.tradingDate, new Wad(bar.closeWad), new Wad(bar.nextOpenWad)),
    ),
  );
}

describe('refitFromStore', () => {
  it('re-fits the upheld-store window to the fixture λ and premium', async () => {
    const upheld = caseNamed('upheld-store');
    const runner = refitFromStore(fixtureStore(), nobleKeccak);
    await expect(runner(bytesFromHex(upheld.inputsHash))).resolves.toEqual({
      lambdaWad: BigInt(upheld.lambdaWad),
      premiumWad: BigInt(upheld.premiumWad),
    });
  });

  it('a missing window resolves undefined', async () => {
    const unavailable = caseNamed('inputs-unavailable');
    const runner = refitFromStore(fixtureStore(), nobleKeccak);
    await expect(runner(bytesFromHex(unavailable.inputsHash))).resolves.toBeUndefined();
  });

  it('an empty store resolves undefined', async () => {
    const empty: CommittedInputStore = {
      rowsDigest: (): Promise<undefined> => Promise.resolve(undefined),
      window: (): Promise<undefined> => Promise.resolve(undefined),
    };
    const runner = refitFromStore(empty, nobleKeccak);
    await expect(runner(bytesFromHex(SAMPLE_HASH))).resolves.toBeUndefined();
  });

  it('an insufficient window resolves undefined rather than throwing', async () => {
    // A window that binds to its own key but whose sample cannot support a fit: two bars cannot
    // clear the tail-observation screen, so `calibrate` reports insufficient.
    const window: CommittedWindow = {
      symbol: 'NVDA',
      session: 'E',
      windowSessions: 2,
      sourceIds: ['test-fixture'],
      familyName: 'empirical',
      bars: [
        {
          tradingDate: SAMPLE_BAR.tradingDate,
          closeWad: BigInt(SAMPLE_BAR.closeWad),
          nextOpenWad: BigInt(SAMPLE_BAR.nextOpenWad),
        },
        {
          tradingDate: '2020-01-07',
          closeWad: BigInt(SAMPLE_BAR.closeWad),
          nextOpenWad: BigInt(SAMPLE_BAR.nextOpenWad),
        },
      ],
    };
    const store = storeOf(window, hashOf(window));
    const runner = refitFromStore(store, nobleKeccak);
    await expect(runner(bytesFromHex(hashOf(window)))).resolves.toBeUndefined();
  });

  it('a window stored under a key its content does not hash to is refused', async () => {
    // The upheld-store window is a valid, fittable window — but stored under a key that is not
    // its own `inputsHash`. The binding check must refuse it rather than fit it, because the
    // committed inputs are the window that hashes to the key, not whatever the store holds.
    const upheld = caseNamed('upheld-store');
    const store = fixtureStore();
    const runner = refitFromStore(store, nobleKeccak);
    await expect(runner(bytesFromHex(SAMPLE_HASH))).resolves.toBeUndefined();
    // And the window under its own key still fits.
    await expect(runner(bytesFromHex(upheld.inputsHash))).resolves.toEqual({
      lambdaWad: BigInt(upheld.lambdaWad),
      premiumWad: BigInt(upheld.premiumWad),
    });
  });

  it('a window whose bars were tampered with is refused', async () => {
    // Take the upheld window, alter one bar, and store it under the *original* hash. The
    // recomputed digest no longer matches the key, so the runner must refuse it.
    const upheld = caseNamed('upheld-store');
    const document = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as {
      windows: Record<string, unknown>;
    };
    const original = document.windows[upheld.inputsHash] as {
      symbol: string;
      session: string;
      windowSessions: number;
      sourceIds: readonly string[];
      familyName: string;
      bars: readonly { tradingDate: string; closeWad: string; nextOpenWad: string }[];
    };
    const tampered = {
      ...original,
      bars: original.bars.map((bar, index) =>
        index === 0 ? { ...bar, closeWad: '99900000000000000000' } : bar,
      ),
    };
    const store = new FileCommittedInputStore(
      parseCommittedInputsDocument(
        '/store.json',
        JSON.stringify({ windows: { [upheld.inputsHash]: tampered } }),
      ),
      nobleKeccak,
    );
    const runner = refitFromStore(store, nobleKeccak);
    await expect(runner(bytesFromHex(upheld.inputsHash))).resolves.toBeUndefined();
  });
});
