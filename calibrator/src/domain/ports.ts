/**
 * Ports. Declarations only — no implementations, and no imports beyond the domain's own value types.
 *
 * Ports are declared in the domain and implemented by adapters, so the dependency arrow points
 * inward. The hash primitive is a port for a reason worth restating, because it is the one that is
 * easiest to get wrong in TypeScript: `domain/` may not depend on a hashing library, so the domain
 * owns the *preimage layout* — the part that has to be identical across languages — and the adapter
 * owns the primitive.
 *
 * **Node's `crypto` cannot serve as that adapter.** `createHash('sha3-256')` is NIST SHA3-256, which
 * is not Ethereum's keccak256: the two differ in their domain-separation padding, so they agree on
 * nothing. Verified rather than assumed — for the empty input, `sha3-256` gives
 * `a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a` where keccak256 gives
 * `c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`. A TypeScript implementation
 * that reached for the standard library would produce digests that look entirely plausible and match
 * nothing on chain. The adapter uses `@noble/hashes`, which implements the original Keccak.
 *
 * **The three structural `*Like` types are deliberate, and `ParameterSet` is a real import.** A port
 * that named `DailyBar` would let a change to a domain value object ripple into every adapter; naming
 * the *shape* it needs keeps the domain owning its own types. `ParameterSet` is the exception, because
 * `ParameterPublisher.publish` hands a committed parameter set across the boundary and a structural
 * stand-in would let an adapter commit something the domain would never have built.
 */

import { type ParameterSet } from './models.js';

/**
 * A keccak-256 hash.
 *
 * A function rather than a named method, because that is the shape the primitive actually has and
 * because it makes a test double a one-line lambda rather than a class.
 */
export type Keccak = (data: Uint8Array) => Uint8Array;

/** Where daily bars come from. The source will change; the domain must not. */
export interface GapSource {
  dailyBars(symbol: SymbolLike): Promise<readonly DailyBarLike[]>;
}

/** The minimum a gap source must be able to name. Structural, so the domain keeps ownership. */
export interface SymbolLike {
  readonly text: string;
}

/** The minimum a gap source must return. Structural, for the same reason. */
export interface DailyBarLike {
  readonly tradingDate: string;
  gap(): { readonly raw: bigint };
}

/**
 * A source of *scheduled* announcement dates.
 *
 * Scheduled, not reported. The distinction is the whole basis of the event-session calibration:
 * conditioning on a scheduled release removes the surprise, which is why the event session is
 * high-variance but not fat-tailed and why the fat-tail machinery is required for the non-event pool
 * and not for this one (paper §7.10).
 *
 * **Declared, and nothing implements it or calls it, in either language.** In the Python this
 * protocol is referenced once — its own declaration — and `ARCHITECTURE.md` lists it in the port
 * table as though it were wired. It is not; it is the interface G1 (event-session shrinkage) will
 * need, and it is carried here so that the port does not silently drop a declaration, for the same
 * reason `HOLIDAY_SPANS_DAYS` was carried (F59). A reader of the architecture table should not assume
 * a caller exists.
 */
export interface AnnouncementCalendar {
  /** Scheduled announcement dates for `symbol`, ascending, as ISO 8601 `YYYY-MM-DD`. */
  announcementDates(symbol: SymbolLike): Promise<readonly string[]>;
}

/**
 * The off-chain side of the premium commitment.
 *
 * The trust shift this port creates is deliberate and is policed rather than assumed: the publisher
 * commits a parameter set and the inputs it consumed *before* the session opens, so it cannot fit
 * after seeing the outcome, and the committed inputs make a challenge a re-run rather than a matter
 * of testimony (paper §7.11).
 *
 * **Asynchronous, where the Python's is a plain call.** The Python returns `str` synchronously, which
 * is honest for its only implementation — a recording double — and wrong for the real one, which
 * posts a transaction. The port's other outward-facing ports are already `Promise`-returning for the
 * same reason (`GapSource.dailyBars` here, and the settlement's `CommittedInputStore.rowsDigest`),
 * so this matches them rather than the Python. The consequence is that `publish` is `async`; see
 * `application/publish.ts`.
 */
export interface ParameterPublisher {
  /** Commit `parameters` for `forSession`; return the commitment digest as `0x`-prefixed hex. */
  publish(parameters: ParameterSet, forSession: bigint): Promise<string>;
}
