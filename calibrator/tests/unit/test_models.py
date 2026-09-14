"""The value objects' invariants and arithmetic, at unit level.

`models.py` had no unit test file. Its value objects are constructed all over the suite, so the
*happy* path is exercised everywhere and the coverage report showed 84% -- the lowest module in the
workspace. What was missing was the other half: six validation guards that had never fired, and
three methods that nothing called at all.

Both halves matter here. The guards are what make a malformed value unconstructible, and this is the
module whose docstring says validation lives here "so that no other module has to". A guard that has
never been observed to fire is indistinguishable from one that does nothing, and the alternative to
testing them is discovering that `NameId` accepts a 31-byte digest at the point where a challenge
fails.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from bell_calibrator.domain import constants
from bell_calibrator.domain.models import (
    Calibrated,
    DailyBar,
    InsufficientSample,
    NameId,
    ParameterSet,
    SessionKind,
    Symbol,
    Wad,
)

DIGEST = b"\x11" * 32


def _parameters(**overrides: object) -> ParameterSet:
    """A valid `ParameterSet`, with named fields overridable so each test varies one thing."""
    fields: dict[str, object] = {
        "symbol": Symbol("NVDA"),
        "session": SessionKind.OVERNIGHT,
        "lam": Wad(15 * 10**18),
        "premium": Wad(174 * 10**15),
        "inputs_hash": DIGEST,
        "model": "empirical",
    }
    fields.update(overrides)
    return ParameterSet(**fields)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- Wad


def test_wad_from_decimal_refuses_a_value_that_is_not_representable() -> None:
    """More than 18 decimal places cannot survive the scaling, and truncating silently would make
    the type's claim to exactness false."""
    with pytest.raises(ValueError, match="not exactly representable"):
        Wad.from_decimal(Decimal("0.0000000000000000001"))


def test_wad_from_decimal_accepts_the_full_eighteen_places() -> None:
    """The boundary: the smallest representable increment is accepted."""
    assert Wad.from_decimal(Decimal("0.000000000000000001")).raw == 1


def test_wad_to_decimal_round_trips_exactly() -> None:
    """`to_decimal` is the lossless way back, and it is what a report or a log would use."""
    for raw in (0, 1, 174 * 10**15, 15 * 10**18, constants.WAD):
        assert Wad(raw).to_decimal() == Decimal(raw) / Decimal(constants.WAD)
    assert Wad.from_str("0.0188").to_decimal() == Decimal("0.0188")


def test_wad_arithmetic_is_fixed_point() -> None:
    """Add, subtract and negate are exact on the raw scale; multiply is WAD multiplication.

    Pinned together because they are one contract: a caller may mix them, and the only way `Wad`
    keeps a unit error unwritable is if every operator agrees on the scale.
    """
    assert Wad(3 * 10**18) + Wad(2 * 10**18) == Wad(5 * 10**18)
    assert Wad(3 * 10**18) - Wad(5 * 10**18) == Wad(-2 * 10**18), "subtraction can go negative"
    assert -Wad(2 * 10**18) == Wad(-2 * 10**18)
    assert Wad(2 * 10**18) * Wad(3 * 10**18) == Wad(6 * 10**18), "WAD multiplication"
    assert Wad(5 * 10**17) * Wad(4 * 10**18) == Wad(2 * 10**18), "one half times four"
    assert Wad(1) * Wad(1) == Wad(0), "and it truncates toward zero"


def test_wad_is_ordered() -> None:
    """Ordering is relied on wherever a quantile is taken.

    `order=True` on the dataclass is what provides it, and a quantile over an unordered type
    would return an arbitrary element rather than a rank.
    """
    assert Wad(1) < Wad(2)
    assert Wad(2) >= Wad(2)
    assert sorted([Wad(3), Wad(1), Wad(2)]) == [Wad(1), Wad(2), Wad(3)]


# --------------------------------------------------------------------------- Symbol


def test_symbol_accepts_a_canonical_ticker() -> None:
    for text in ("NVDA", "BRK.B", "A", "ABCDEFGHIJ"):
        assert Symbol(text).text == text


def test_symbol_refuses_anything_that_is_not_a_canonical_ticker() -> None:
    """A `str` would make this validation optional, which is the same as absent."""
    for text in ("nvda", "1NVDA", "", "TOOLONGTICKER", "NV DA", "-NVDA"):
        with pytest.raises(ValueError, match="not a canonical ticker"):
            Symbol(text)


# --------------------------------------------------------------------------- NameId


def test_name_id_refuses_a_digest_that_is_not_32_bytes() -> None:
    """A name id is the keccak of a symbol, so a short one cannot have come from a hash. Catching it
    here is what stops a malformed id reaching the commitment preimage, where it would encode into
    a digest that no honest challenger could reproduce."""
    with pytest.raises(ValueError, match="a name id is 32 bytes"):
        NameId(b"\x00" * 31)

    with pytest.raises(ValueError, match="a name id is 32 bytes"):
        NameId(b"\x00" * 33)


def test_name_id_to_hex_is_the_zero_prefixed_form() -> None:
    """The form the fixture and the Solidity side both use."""
    assert NameId(DIGEST).to_hex() == "0x" + "11" * 32
    assert NameId(DIGEST).to_hex().startswith("0x")
    assert len(NameId(DIGEST).to_hex()) == 66


# --------------------------------------------------------------------------- ParameterSet


def test_parameter_set_accepts_a_priceable_parameter() -> None:
    parameters = _parameters()
    assert parameters.lam == Wad(15 * 10**18)
    assert parameters.model == "empirical"


def test_parameter_set_refuses_a_short_inputs_hash() -> None:
    """The inputs hash is the key a challenge re-runs the fit from, so a truncated one would make
    the re-run impossible while still looking like a commitment."""
    with pytest.raises(ValueError, match="an inputs hash is 32 bytes"):
        _parameters(inputs_hash=b"\x00" * 31)


def test_parameter_set_refuses_a_non_positive_leverage() -> None:
    """A zero leverage makes the saturation cap infinite, which is not a contract that can be
    listed -- the lattice gate refuses it on chain, and this refuses it before publication."""
    with pytest.raises(ValueError, match="a leverage of zero is not priceable"):
        _parameters(lam=Wad(0))

    with pytest.raises(ValueError, match="a leverage of zero is not priceable"):
        _parameters(lam=Wad(-1))


def test_parameter_set_refuses_a_premium_outside_the_unit_interval() -> None:
    """A premium at or below zero is a free claim; one above the collateral unit would promise more
    than the pair can pay."""
    with pytest.raises(ValueError, match="a premium outside"):
        _parameters(premium=Wad(0))

    with pytest.raises(ValueError, match="a premium outside"):
        _parameters(premium=Wad(constants.WAD + 1))


def test_parameter_set_accepts_the_boundary_premium() -> None:
    """The interval is `(0, 1]`, so a premium of exactly the collateral unit is allowed."""
    assert _parameters(premium=Wad(constants.WAD)).premium.raw == constants.WAD


# --------------------------------------------------------------------------- DailyBar


def test_daily_bar_gap_is_the_signed_return() -> None:
    """`G = O / C_prev - 1`, signed. The magnitude is a volatility quantity and the sign is
    directional, so both directions must come out with the right sign."""
    up = DailyBar(date(2026, 1, 2), Wad(100 * 10**18), Wad(102 * 10**18))
    down = DailyBar(date(2026, 1, 2), Wad(100 * 10**18), Wad(98 * 10**18))
    flat = DailyBar(date(2026, 1, 2), Wad(100 * 10**18), Wad(100 * 10**18))

    assert up.gap() == Wad(2 * 10**16), "+2%"
    assert down.gap() == Wad(-2 * 10**16), "-2%"
    assert flat.gap() == Wad(0), "flat"


def test_daily_bar_refuses_a_non_positive_close() -> None:
    """A close of zero has no ratio, and the division would raise a less specific error.

    The guard is in `gap()` rather than in `__post_init__`: a bar with a zero close is
    representable, it simply cannot form a gap, and refusing it at construction would reject a
    datum the adapter may legitimately have read.
    """
    with pytest.raises(ValueError, match="a close must be positive"):
        DailyBar(date(2026, 1, 2), Wad(0), Wad(100 * 10**18)).gap()

    with pytest.raises(ValueError, match="a close must be positive"):
        DailyBar(date(2026, 1, 2), Wad(-1), Wad(100 * 10**18)).gap()


# --------------------------------------------------------------------------- the result union


def test_the_calibration_result_is_a_two_case_union() -> None:
    """A domain result rather than an exception: "the sample cannot place a quantile" is an expected
    outcome, so a caller branches rather than catching."""
    calibrated: Calibrated | InsufficientSample = Calibrated(_parameters())
    insufficient: Calibrated | InsufficientSample = InsufficientSample(
        Symbol("NVDA"), SessionKind.OVERNIGHT, observations=10, required_tail_observations=20
    )

    assert isinstance(calibrated, Calibrated)
    assert isinstance(insufficient, InsufficientSample)
    assert insufficient.observations < insufficient.required_tail_observations
