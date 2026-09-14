/**
 * Ports. Declarations only — no implementations, and no imports beyond this module's own types.
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
 */

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
 * Where a committed fit's raw inputs are retrieved from.
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
