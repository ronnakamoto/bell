/**
 * Value objects. No primitive obsession, no mutable domain state.
 *
 * Every type here is immutable and validated at construction, which is the same contract the Python
 * implementation held: a malformed value cannot be built, so no other module has to check for one.
 *
 * One deliberate difference from the Python, and it is a narrowing rather than a relaxation.
 * `Wad` holds a **`bigint`**, not a `Decimal`. Its raw value is an exact integer at 1e18 — 19 digits,
 * and intermediate products reach 38 — which is exactly what `bigint` is for. `Decimal` is reserved
 * for the modules that need a transcendental function or a configurable rounding mode, which is
 * `moments` and nothing else. Keeping the two apart means the common path is integer arithmetic, and
 * it means the one module that needs arbitrary-precision *decimal* is the one module you can point
 * at when asking whether the numerics are sound.
 */

/** The closed-session taxonomy. Mirrors `contracts/src/types/SessionKind.sol`. */
export const SessionKind = {
  OVERNIGHT: 'E',
  WEEKEND: 'W',
  HOLIDAY: 'H',
  EVENT: 'C',
} as const;

export type SessionKind = (typeof SessionKind)[keyof typeof SessionKind];

/** The scale of every fixed-point quantity in the protocol. */
export const WAD = 10n ** 18n;

/** The scale of a `Wad`, as a `bigint`, for the arithmetic below. */
const WAD_BIGINT = WAD;

/**
 * Thrown by a value object that refuses its input.
 *
 * A named type rather than a bare `Error` so that a caller can distinguish "the domain rejected this
 * datum" from "something threw", which is the distinction the adapters are written around.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * A fixed-point quantity at 1e18, as an exact integer.
 *
 * Exists so that a unit error is not writable: a `Wad` cannot be added to a `bigint`, and a `number`
 * cannot reach the type at all. Multiplication is WAD multiplication, which is what a fixed-point
 * type's `*` should mean.
 */
export class Wad {
  /** The raw integer, at 1e18 scale. */
  readonly raw: bigint;

  constructor(raw: bigint) {
    this.raw = raw;
  }

  /**
   * Exact conversion from a scaled integer already at WAD scale.
   *
   * Named rather than a second constructor overload, because `new Wad(5n)` and `Wad.fromWad(5n)`
   * reading differently is the point: the first is a raw value and the second is a quantity.
   */
  static fromRaw(raw: bigint): Wad {
    return new Wad(raw);
  }

  /** `value * 1e18`, exactly, from an integer count of whole units. */
  static fromWhole(whole: bigint): Wad {
    return new Wad(whole * WAD_BIGINT);
  }

  static get zero(): Wad {
    return new Wad(0n);
  }

  static get one(): Wad {
    return new Wad(WAD_BIGINT);
  }

  /** The raw value as a decimal string at WAD scale, e.g. `"0.174"`. */
  toDecimalString(): string {
    const negative = this.raw < 0n;
    const magnitude = negative ? -this.raw : this.raw;
    const whole = magnitude / WAD_BIGINT;
    const fraction = magnitude % WAD_BIGINT;
    if (fraction === 0n) return `${negative ? '-' : ''}${String(whole)}`;
    const padded = fraction.toString().padStart(18, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${String(whole)}.${padded}`;
  }

  /** WAD multiplication: `(a * b) / 1e18`, truncated toward zero. */
  mul(other: Wad): Wad {
    return new Wad((this.raw * other.raw) / WAD_BIGINT);
  }

  /** Exact addition on the raw scale. */
  add(other: Wad): Wad {
    return new Wad(this.raw + other.raw);
  }

  /** Exact subtraction on the raw scale; can go negative, which is meaningful for a gap. */
  sub(other: Wad): Wad {
    return new Wad(this.raw - other.raw);
  }

  negate(): Wad {
    return new Wad(-this.raw);
  }

  isZero(): boolean {
    return this.raw === 0n;
  }

  isNegative(): boolean {
    return this.raw < 0n;
  }

  /** The magnitude, `|raw|`, as an unsigned `Wad`. */
  abs(): Wad {
    return new Wad(this.raw < 0n ? -this.raw : this.raw);
  }

  equals(other: Wad): boolean {
    return this.raw === other.raw;
  }

  lessThan(other: Wad): boolean {
    return this.raw < other.raw;
  }

  lessThanOrEqual(other: Wad): boolean {
    return this.raw <= other.raw;
  }

  greaterThan(other: Wad): boolean {
    return this.raw > other.raw;
  }

  greaterThanOrEqual(other: Wad): boolean {
    return this.raw >= other.raw;
  }

  /** The raw value as a `bigint`, for the callers that must speak to the chain in raw terms. */
  toRaw(): bigint {
    return this.raw;
  }
}

/** A canonical reference-equity ticker. */
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;

export class Symbol {
  readonly text: string;

  constructor(text: string) {
    if (!SYMBOL_PATTERN.test(text)) {
      throw new DomainError(`not a canonical ticker: ${JSON.stringify(text)}`);
    }
    this.text = text;
  }

  equals(other: Symbol): boolean {
    return this.text === other.text;
  }

  /** The ASCII bytes hashed to form the `NameId`. */
  toBytes(): Uint8Array {
    return new TextEncoder().encode(this.text);
  }
}

/** The number of bytes in a `bytes32`. */
export const DIGEST_BYTES = 32;

/**
 * `keccak256(bytes(symbol))`, as a 32-byte value.
 *
 * Constructed by the adapter that owns a hash function rather than by `Symbol` itself, because
 * `domain/` may not depend on a hashing library — the port is the whole reason this is a separate
 * type rather than a method.
 */
export class NameId {
  readonly digest: Uint8Array;

  constructor(digest: Uint8Array) {
    if (digest.length !== DIGEST_BYTES) {
      throw new DomainError(`a name id is 32 bytes, got ${String(digest.length)}`);
    }
    this.digest = digest;
  }

  /** `0x`-prefixed lowercase hex, the form the fixture and the Solidity side both use. */
  toHex(): string {
    return `0x${hexOf(this.digest)}`;
  }
}

/** Lowercase hex of a byte array, without a prefix. */
export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Parse a `0x`-prefixed hex string into bytes. Rejects an odd length or a non-hex character. */
export function bytesFromHex(text: string): Uint8Array {
  const body = text.startsWith('0x') ? text.slice(2) : text;
  if (body.length % 2 !== 0) throw new DomainError(`odd-length hex string: ${text}`);
  if (!/^[0-9a-fA-F]*$/.test(body)) throw new DomainError(`not hex: ${text}`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** A publisher's committed calibration for one name and one session. */
export class ParameterSet {
  readonly symbol: Symbol;
  readonly session: SessionKind;
  readonly lam: Wad;
  readonly premium: Wad;
  readonly inputsHash: Uint8Array;
  readonly model: string;

  constructor(fields: {
    symbol: Symbol;
    session: SessionKind;
    lam: Wad;
    premium: Wad;
    inputsHash: Uint8Array;
    model: string;
  }) {
    if (fields.inputsHash.length !== DIGEST_BYTES) {
      throw new DomainError('an inputs hash is 32 bytes');
    }
    if (fields.lam.raw <= 0n) {
      throw new DomainError('a leverage of zero is not priceable');
    }
    if (fields.premium.raw <= 0n || fields.premium.raw > WAD_BIGINT) {
      throw new DomainError('a premium outside (0, 1] is not priceable');
    }
    this.symbol = fields.symbol;
    this.session = fields.session;
    this.lam = fields.lam;
    this.premium = fields.premium;
    this.inputsHash = fields.inputsHash;
    this.model = fields.model;
  }
}

/**
 * One session's close and the next session's open.
 *
 * Only the two prints the gap is defined from are carried. A full OHLC bar would invite a domain
 * function to reach for a high or a low, and nothing in this protocol prices off either.
 */
export class DailyBar {
  readonly tradingDate: string;
  readonly close: Wad;
  readonly nextOpen: Wad;

  constructor(tradingDate: string, close: Wad, nextOpen: Wad) {
    this.tradingDate = tradingDate;
    this.close = close;
    this.nextOpen = nextOpen;
  }

  /**
   * `G = O / C_prev - 1`, the closed-session return, signed.
   *
   * The signed gap is directional; its magnitude is a volatility quantity. The flagship instrument
   * settles on the magnitude, because the dominant demand is from holders of inventory who are short
   * the gap in both directions.
   */
  gap(): Wad {
    if (this.close.raw <= 0n) {
      throw new DomainError('a close must be positive to form a ratio');
    }
    return new Wad((this.nextOpen.raw * WAD_BIGINT) / this.close.raw - WAD_BIGINT);
  }
}

/** The sample supported an estimate. */
export interface Calibrated {
  readonly kind: 'calibrated';
  readonly parameters: ParameterSet;
}

/**
 * The sample could not support an estimate.
 *
 * A domain *result*, not an exception: "the sample cannot place a quantile" is an expected outcome of
 * the leverage rule, and modelling it as an error would push the caller towards catching rather than
 * branching.
 */
export interface InsufficientSample {
  readonly kind: 'insufficient';
  readonly symbol: Symbol;
  readonly session: SessionKind;
  readonly observations: number;
  readonly requiredTailObservations: number;
}

export type CalibrationResult = Calibrated | InsufficientSample;
