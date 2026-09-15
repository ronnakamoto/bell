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
 * `moments`, the families, `leverage`, and this module's two *conversions* to and from a decimal
 * literal. Keeping the two apart means the common path is integer arithmetic, and it means the few
 * modules that need arbitrary-precision *decimal* are the ones you can point at when asking whether
 * the numerics are sound.
 *
 * The conversions import the domain's single `Decimal.clone` from `moments.ts` rather than declaring a
 * second one, so a value that enters as a decimal literal and leaves as one cannot be rounded at a
 * precision no other module uses.
 *
 * **The byte helpers are not here.** `NameId`, `hexOf`, `bytesEqual` and `bytesFromHex` moved to
 * `bytes.ts` when this file crossed §8.1's 400-line limit, and the seam is a real one: everything
 * over there operates on a `Uint8Array`, and nothing there knows what a `Wad` is.
 */

import { type Decimal } from 'decimal.js';

import { WAD } from './constants.js';
import { D } from './moments.js';

/** The closed-session taxonomy. Mirrors `contracts/src/types/SessionKind.sol`. */
export const SessionKind = {
  OVERNIGHT: 'E',
  WEEKEND: 'W',
  HOLIDAY: 'H',
  EVENT: 'C',
} as const;

export type SessionKind = (typeof SessionKind)[keyof typeof SessionKind];

/**
 * The scale of a `Wad`, as a `bigint`, for the arithmetic below.
 *
 * **Imported rather than declared.** Until the TypeScript constants module existed this file wrote
 * the value down as `10n ** 18n`, which was the one place the port departed from the single-source
 * rule — the same number in two files, which is a bug waiting to diverge (build brief §6). It now has
 * exactly one definition, in the generated `constants.ts`, and this alias exists only so that the
 * arithmetic below reads in the scale it operates at. A caller wanting the constant itself imports
 * it from there; re-exporting it from here would put a second name on the one value.
 */
const WAD_BIGINT = WAD;

/** The number of decimal places a `Wad` holds exactly. The scale it is fixed at, as a count. */
const WAD_DECIMALS = 18;

/** `WAD` as a decimal, for the two conversions below. Derived, never written down a second time. */
const WAD_DECIMAL = new D(WAD.toString());

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

  /**
   * Exact conversion from a decimal, refusing one that is not representable at WAD scale.
   *
   * **The `decimalPlaces` check is what makes this precision-independent, and it is not redundant with
   * the integrality check below.** The Python's `from_decimal` multiplies by 1e18 in `decimal`'s
   * *ambient* context and compares against `to_integral_value()`, so for a value with more than
   * ~28 significant digits the multiply rounds first and the comparison then succeeds on a *rounded*
   * result. Measured: `Wad.from_str("123456789012345678.123456789012345678").raw` is
   * `123456789012345678123456789000000000` where the exact answer is
   * `123456789012345678123456789012345678` — wrong in the last eight digits, silently, and with the
   * check passing. That is `DESIGN_NOTES.md` F60's second observable member, and this is where it is
   * fixed: a value with more than eighteen decimal places is refused *before* the multiply, so the
   * multiply never has to be trusted for exactness.
   *
   * A non-finite value falls through to the integrality check rather than to a check of its own, so
   * that `NaN` produces the same message the Python produces.
   */
  static fromDecimal(value: Decimal): Wad {
    if (value.isFinite() && value.decimalPlaces() > WAD_DECIMALS) {
      throw new DomainError(
        `${value.toExponential().toUpperCase()} is not exactly representable at WAD scale`,
      );
    }
    const scaled = value.times(WAD_DECIMAL);
    if (!scaled.isInteger()) {
      throw new DomainError(
        `${value.toExponential().toUpperCase()} is not exactly representable at WAD scale`,
      );
    }
    return new Wad(BigInt(scaled.toFixed(0)));
  }

  /**
   * Exact conversion from a decimal literal, e.g. `"0.0188"`.
   *
   * **One deliberate narrowing, and it is not the one this comment used to name.** The claim was that
   * `decimal.js` refuses underscore separators where Python's `Decimal` accepts them. Measured, that is
   * backwards: `new Decimal("1_000.00")` is `1000`, exactly as `Decimal("1_000.00")` is `1000.00`. What
   * `decimal.js` *does* refuse is a literal carrying surrounding whitespace — `new Decimal("  100.00  ")`
   * and `new Decimal("\u00a0100")` both throw, where Python's `Decimal` returns `100.00`. So a caller
   * passing a padded literal is refused by the port and accepted by the oracle.
   *
   * The CSV adapter is unaffected, because it trims every cell before calling this — and the trimming
   * is where the two languages genuinely diverge, in both directions. See F65 and the adapter's header.
   * Recorded rather than reproduced: reproducing Python's parser would mean writing one, and a padded
   * literal is not a format any exchange emits.
   *
   * A non-numeric literal throws `decimal.js`'s own error, which the CSV adapter catches and renames.
   * That mirrors the Python, where `Decimal("one hundred")` raises `InvalidOperation` — a
   * `decimal.DecimalException` and *not* a `ValueError`, which is why the adapter's handler has to
   * name both.
   */
  static fromStr(text: string): Wad {
    return Wad.fromDecimal(new D(text));
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

// `NameId`, `hexOf`, `bytesEqual` and `bytesFromHex` live in `bytes.ts`, which imports this module
// rather than the reverse — see that file's header for the seam, and for why `bytesEqual` exists at
// all. `DIGEST_BYTES` stays here because `ParameterSet` below is the other thing that checks a width.

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
