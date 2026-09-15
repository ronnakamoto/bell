/**
 * Ports. Declarations only — no implementations, and no imports beyond the shared domain core.
 *
 * Ports are declared in the domain and implemented by adapters, so the dependency arrow points
 * inward. The reference-print source is a port rather than a concrete client for the reason the
 * brief gives: the feed will change, and the domain must not.
 *
 * **`CommittedInputStore` lives here, and this file is where that was fixed.** It is declared in
 * `bell_settlement.domain.ports` in the Python; the port put it beside the *calibrator's* ports
 * because that was the only TypeScript `domain/` directory in existence when `ports.ts` was written
 * (DESIGN_NOTES.md F62). That was a real misplacement rather than a harmless one, because the
 * calibrator's domain is now a published surface: a settlement port living there is a dependency the
 * settlement has on the calibrator for one of its *own* interfaces. The two files are asymmetric for
 * a second reason, and the asymmetry is now the intended one — the calibrator's declares the shared
 * primitives (`Keccak`, `GapSource`, `AnnouncementCalendar`, `ParameterPublisher`) and this one
 * declares the settlement service's.
 *
 * **`Keccak` is deliberately not re-declared or re-exported here.** It is genuinely shared —
 * `commitmentDigest` is called by both services over the same preimage layout — so `adjudication.ts`
 * imports it from `@bell/calibrator/domain/ports.js` directly. A re-export would create a second
 * name for one type and make the dependency look like it passed through this file.
 */

import { type ReferencePrint } from './prints.js';

/**
 * A source of reference prints for a session.
 *
 * Implemented by an HTTP client against the issuer's feed, by a file reader for a replay, and by a
 * list for the tests. The domain never learns which.
 *
 * **`Promise`-returning, where the Python's is a plain call.** The Python returns a `Sequence`
 * synchronously, which is honest for its only implementation — a list — and wrong for the real one,
 * which is a network read. This is the same departure `ParameterPublisher.publish` carries, ruled in
 * the calibrator's `ports.ts` and stated there rather than re-argued: every outward-facing port in
 * the port is `Promise`-returning, so a synchronous one would be the odd member of the set rather
 * than the faithful one. The consequence is that a caller that wants the prints is `async`, which is
 * where a network read belongs anyway.
 */
export interface ReferencePrintSource {
  /**
   * Every print currently held for `referenceToken`, in no particular order.
   *
   * Unordered on purpose. The selection is total and deterministic, so imposing an order at the port
   * would be a second ordering rule that the domain would have to ignore — and a source that
   * returned a different order on a retry would look like a different input set.
   */
  printsFor(referenceToken: string): Promise<readonly ReferencePrint[]>;
}

/**
 * Retrieves the raw inputs a committed fit consumed, so that the fit can be re-run.
 *
 * The digest is the key, not the session: the commitment names an `inputsHash`, and a store that
 * could only be asked by session could return a different input set from the one committed.
 */
export interface CommittedInputStore {
  /**
   * The digest of the rows the committed fit consumed, or `undefined` if they are unavailable.
   *
   * `undefined` rather than an exception, because an unavailable input is an ordinary outcome that
   * adjudication reports as `InputsUnavailable`. Making it an exception would force every caller to
   * catch one to say the same thing.
   */
  rowsDigest(inputsHash: Uint8Array): Promise<Uint8Array | undefined>;
}
