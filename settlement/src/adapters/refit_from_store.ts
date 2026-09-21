/**
 * A `RefitRunner` that re-runs `calibrate` on a window from a `CommittedInputStore`.
 *
 * Settlement `application/` never imports this: the composition root wires the runner, and
 * `adjudicate` only sees the port. Missing windows and insufficient samples resolve `undefined`,
 * which adjudication reports as `inputs-unavailable` rather than a slash.
 */

import {
  calibrate,
  CalibrationRequest,
  rowsDigest,
} from '@bell/calibrator/application/calibrate.js';
import { bytesEqual } from '@bell/calibrator/domain/bytes.js';
import { inputsHash } from '@bell/calibrator/domain/digest.js';
import { familyFor } from '@bell/calibrator/domain/families/index.js';
import { DailyBar, Symbol, Wad } from '@bell/calibrator/domain/models.js';
import { type Keccak } from '@bell/calibrator/domain/ports.js';

import { type RefitRunner, type RefittedParameters } from '../domain/adjudication.js';
import {
  type CommittedBar,
  type CommittedInputStore,
  type CommittedWindow,
} from '../domain/ports.js';

/** Re-fit from stored bars. `undefined` when the window is missing or the sample cannot support a fit. */
export function refitFromStore(store: CommittedInputStore, keccak: Keccak): RefitRunner {
  return async (inputsHash_: Uint8Array): Promise<RefittedParameters | undefined> => {
    const window = await store.window(inputsHash_);
    if (window === undefined) return undefined;
    // The store is keyed by the committed `inputsHash`, but the key alone is not the binding: a
    // store that returns a *different* window for a committed key would make the re-fit judge
    // against inputs the publisher never committed. Recompute the hash from the window's own
    // metadata and rows and refuse a mismatch — the committed inputs are the tail the fit
    // consumed, so the digest is over the last `windowSessions` bars, exactly as the publisher
    // computed it.
    const tail = dailyBarsOf(window.bars).slice(-window.windowSessions);
    const computed = inputsHash(
      keccak,
      window.windowSessions,
      window.session,
      window.sourceIds,
      window.windowSessions,
      rowsDigest(keccak, tail),
    );
    if (!bytesEqual(computed, inputsHash_)) return undefined;
    const result = calibrate(
      requestOf(window),
      dailyBarsOf(window.bars),
      familyFor(window.familyName),
      keccak,
    );
    if (result.kind === 'insufficient') return undefined;
    return {
      lambdaWad: result.parameters.lam.raw,
      premiumWad: result.parameters.premium.raw,
    };
  };
}

function requestOf(window: CommittedWindow): CalibrationRequest {
  return new CalibrationRequest({
    symbol: new Symbol(window.symbol),
    session: window.session,
    windowSessions: window.windowSessions,
    sourceIds: window.sourceIds,
    familyName: window.familyName,
  });
}

function dailyBarsOf(bars: readonly CommittedBar[]): DailyBar[] {
  return bars.map(
    (bar) => new DailyBar(bar.tradingDate, new Wad(bar.closeWad), new Wad(bar.nextOpenWad)),
  );
}
