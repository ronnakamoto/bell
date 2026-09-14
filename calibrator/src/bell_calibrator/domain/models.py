"""Value objects. No primitive obsession, no mutable domain state.

Every type here is a frozen, slotted dataclass. A mutable domain value object is a design error
(build brief §7.3): it makes identity-dependent behaviour possible, and in this domain identity is
exactly what a symbol and a session kind are.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum

from bell_calibrator.domain import constants

_WAD_DECIMAL = Decimal(constants.WAD)
_SYMBOL_PATTERN = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
_DIGEST_BYTES = 32


class SessionKind(StrEnum):
    """The closed-session taxonomy.

    A session is classified by the calendar span of its gap, and the classification is semantic
    rather than cosmetic: it selects which calibration window and which parameter set applies.
    Mirrors `contracts/src/types/SessionKind.sol`.
    """

    OVERNIGHT = "E"
    WEEKEND = "W"
    HOLIDAY = "H"
    EVENT = "C"


@dataclass(frozen=True, slots=True, order=True)
class Wad:
    """A fixed-point quantity at 1e18.

    Exists so that a unit error is not writable: a `Wad` cannot be added to an `int`, and a `float`
    cannot reach the type at all. Multiplication is WAD multiplication, which is what a fixed-point
    type's `*` should mean.
    """

    raw: int

    @classmethod
    def from_decimal(cls, value: Decimal) -> Wad:
        """Exact conversion; refuses a value with more than 18 decimal places."""
        scaled = value * _WAD_DECIMAL
        if scaled != scaled.to_integral_value():
            raise ValueError(f"{value} is not exactly representable at WAD scale")
        return cls(int(scaled))

    @classmethod
    def from_str(cls, text: str) -> Wad:
        """Exact conversion from a decimal literal, e.g. `"0.0188"`."""
        return cls.from_decimal(Decimal(text))

    def to_decimal(self) -> Decimal:
        """Lossless conversion back to a decimal."""
        return Decimal(self.raw) / _WAD_DECIMAL

    def __add__(self, other: Wad) -> Wad:
        return Wad(self.raw + other.raw)

    def __sub__(self, other: Wad) -> Wad:
        return Wad(self.raw - other.raw)

    def __mul__(self, other: Wad) -> Wad:
        """WAD multiplication: `a * b / 1e18`, truncated toward zero."""
        return Wad(self.raw * other.raw // constants.WAD)

    def __neg__(self) -> Wad:
        return Wad(-self.raw)


@dataclass(frozen=True, slots=True)
class Symbol:
    """A reference-equity ticker.

    Validated at construction so that no other module has to. A `str` would make the validation
    optional and therefore absent.
    """

    text: str

    def __post_init__(self) -> None:
        if not _SYMBOL_PATTERN.match(self.text):
            raise ValueError(f"not a canonical ticker: {self.text!r}")


@dataclass(frozen=True, slots=True)
class NameId:
    """`keccak256(bytes(symbol))`, as a 32-byte value.

    Constructed by the adapter that owns a hash function rather than by `Symbol` itself, because
    `domain/` may not depend on a hash library (build brief §7.4).
    """

    digest: bytes

    def __post_init__(self) -> None:
        if len(self.digest) != _DIGEST_BYTES:
            raise ValueError(f"a name id is 32 bytes, got {len(self.digest)}")

    def to_hex(self) -> str:
        return "0x" + self.digest.hex()


@dataclass(frozen=True, slots=True)
class ParameterSet:
    """A publisher's committed calibration for one name and one session.

    `inputs_hash` is what makes a challenge a verification rather than a matter of testimony: any
    party can re-run the committed fit from the committed inputs and check the committed parameter
    against the result. Without it the mechanism degrades to trusting the publisher, which is the
    exact failure the commitment exists to prevent (paper Appendix B).
    """

    symbol: Symbol
    session: SessionKind
    lam: Wad
    premium: Wad
    inputs_hash: bytes
    model: str

    def __post_init__(self) -> None:
        if len(self.inputs_hash) != _DIGEST_BYTES:
            raise ValueError("an inputs hash is 32 bytes")
        if self.lam.raw <= 0:
            raise ValueError("a leverage of zero is not priceable")
        if not 0 < self.premium.raw <= constants.WAD:
            raise ValueError("a premium outside (0, 1] is not priceable")


@dataclass(frozen=True, slots=True)
class DailyBar:
    """One session's close and the next session's open.

    Only the two prints the gap is defined from are carried. A full OHLC bar would invite a domain
    function to reach for a high or a low, and nothing in this protocol prices off either.
    """

    trading_date: date
    close: Wad
    next_open: Wad

    def gap(self) -> Wad:
        """`G = O / C_prev - 1`, the closed-session return.

        The signed gap is directional; its magnitude is a volatility quantity. The flagship
        instrument settles on the magnitude, because the dominant demand is from holders of
        inventory who are short the gap in both directions.
        """
        if self.close.raw <= 0:
            raise ValueError("a close must be positive to form a ratio")
        return Wad((self.next_open.raw * constants.WAD) // self.close.raw - constants.WAD)


@dataclass(frozen=True, slots=True)
class Calibrated:
    """The sample supported an estimate."""

    parameters: ParameterSet


@dataclass(frozen=True, slots=True)
class InsufficientSample:
    """The sample could not support an estimate.

    A domain *result*, not an exception: "the sample cannot place a quantile" is an expected
    outcome of the leverage rule, and modelling it as an error would push the caller towards
    catching rather than branching (build brief §9.2).
    """

    symbol: Symbol
    session: SessionKind
    observations: int
    required_tail_observations: int


CalibrationResult = Calibrated | InsufficientSample
