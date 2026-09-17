/**
 * A `RefitRunner` that re-runs `calibrate` on a window from a `CommittedInputStore`.
 *
 * Settlement `application/` never imports this: the composition root wires the runner, and
 * `adjudicate` only sees the port. Missing windows and insufficient samples resolve `undefined`,
 * which adjudication reports as `inputs-unavailable` rather than a slash.
 */

import { calibrate, CalibrationRequest } from '@bell/calibrator/application/calibrate.js';
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
  return async (inputsHash: Uint8Array): Promise<RefittedParameters | undefined> => {
    const window = await store.window(inputsHash);
    if (window === undefined) return undefined;
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
