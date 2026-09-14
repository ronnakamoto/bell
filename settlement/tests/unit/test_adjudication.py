"""Challenge adjudication.

The adjudication is the mechanism that makes a challenge a verification rather than a matter of
testimony, so every outcome it can produce is asserted: upheld, slashed on the leverage, slashed on
the premium, inputs unavailable, and a digest that does not reproduce.
"""

from __future__ import annotations

from decimal import Decimal

from bell_calibrator.domain.constants import WAD
from bell_calibrator.domain.digest import commitment_digest
from bell_calibrator.domain.models import Wad
from Crypto.Hash import keccak

from bell_settlement.domain.adjudication import (
    PREMIUM_TOLERANCE_WAD,
    CommittedParameterSet,
    DigestMismatch,
    InputsUnavailable,
    PublisherSlashed,
    PublisherUpheld,
    RefitRunner,
    RefittedParameters,
    adjudicate,
    digest_matches,
    premium_tolerance_from_precision,
)

NAME_ID = keccak.new(digest_bits=256)
NAME_ID.update(b"NVDA")
NAME = NAME_ID.digest()
INPUTS_HASH = keccak.new(digest_bits=256)
INPUTS_HASH.update(b"NVDA/E/504/canonical-rows")
INPUTS = INPUTS_HASH.digest()

LAMBDA_WAD = 15 * WAD
PREMIUM_WAD = int(Decimal("0.1740") * WAD)


def reference_keccak(data: bytes) -> bytes:
    hasher = keccak.new(digest_bits=256)
    hasher.update(data)
    return bytes(hasher.digest())


def commitment(
    *, lam: int = LAMBDA_WAD, premium: int = PREMIUM_WAD, inputs_hash: bytes = INPUTS
) -> CommittedParameterSet:
    return CommittedParameterSet(
        name_id=NAME,
        for_session=42,
        lambda_wad=lam,
        premium_wad=premium,
        inputs_hash=inputs_hash,
    )


def expected_digest(entry: CommittedParameterSet) -> bytes:
    return commitment_digest(
        reference_keccak,
        entry.name_id,
        entry.for_session,
        Wad(entry.lambda_wad),
        Wad(entry.premium_wad),
        entry.inputs_hash,
    )


def refit_returning(lam: int, premium: int) -> RefitRunner:
    """A re-run that always produces the same parameter set."""

    def run(_inputs_hash: bytes) -> RefittedParameters | None:
        return RefittedParameters(lambda_wad=lam, premium_wad=premium)

    return run


def refit_unavailable(_inputs_hash: bytes) -> RefittedParameters | None:
    return None


class TestToleranceDerivation:
    def test_the_premium_tolerance_is_half_a_unit_in_the_last_published_place(self) -> None:
        # Four decimal places, so 5e-5. Derived rather than chosen, and asserted against the
        # constant
        # so a change to one without the other fails here rather than in production.
        assert premium_tolerance_from_precision(4) == PREMIUM_TOLERANCE_WAD

    def test_a_coarser_precision_gives_a_wider_tolerance(self) -> None:
        assert premium_tolerance_from_precision(2) > premium_tolerance_from_precision(4)

    def test_a_negative_precision_is_refused(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="precision"):
            premium_tolerance_from_precision(-1)


class TestUpheld:
    def test_an_exact_match_is_upheld(self) -> None:
        result = adjudicate(commitment(), refit_returning(LAMBDA_WAD, PREMIUM_WAD),
        reference_keccak)
        assert isinstance(result, PublisherUpheld)
        assert result.premium_delta_wad == 0

    def test_a_match_inside_the_published_precision_is_upheld(self) -> None:
        # The published premium carries a rounding uncertainty of its own, so a re-run inside it is
        # consistent with the published number.
        drifted = PREMIUM_WAD + PREMIUM_TOLERANCE_WAD - 1
        result = adjudicate(commitment(), refit_returning(LAMBDA_WAD, drifted), reference_keccak)
        assert isinstance(result, PublisherUpheld)
        assert result.premium_delta_wad == PREMIUM_TOLERANCE_WAD - 1

    def test_the_upheld_result_carries_the_digest(self) -> None:
        entry = commitment()
        result = adjudicate(entry, refit_returning(LAMBDA_WAD, PREMIUM_WAD), reference_keccak)
        assert isinstance(result, PublisherUpheld)
        assert result.digest == expected_digest(entry)


class TestSlashed:
    def test_a_leverage_off_the_lattice_is_slashed(self) -> None:
        # The leverage is an integer on the harmonic ladder and is published exactly, so a tolerance
        # on it would be a tolerance on which instrument was listed.
        result = adjudicate(
            commitment(), refit_returning(LAMBDA_WAD + 1, PREMIUM_WAD), reference_keccak
        )
        assert isinstance(result, PublisherSlashed)
        assert "lattice" in result.reason

    def test_a_premium_outside_the_published_precision_is_slashed(self) -> None:
        result = adjudicate(
            commitment(),
            refit_returning(LAMBDA_WAD, PREMIUM_WAD + PREMIUM_TOLERANCE_WAD + 1),
            reference_keccak,
        )
        assert isinstance(result, PublisherSlashed)
        assert "premium" in result.reason

    def test_the_slash_is_symmetric_in_the_sign_of_the_error(self) -> None:
        # A publisher that overstates and one that understates are both wrong. An asymmetric test
        # would let a publisher shade its premium in whichever direction the comparison allowed.
        high = adjudicate(
            commitment(),
            refit_returning(LAMBDA_WAD, PREMIUM_WAD + 10**15),
            reference_keccak,
        )
        low = adjudicate(
            commitment(),
            refit_returning(LAMBDA_WAD, PREMIUM_WAD - 10**15),
            reference_keccak,
        )
        assert isinstance(high, PublisherSlashed)
        assert isinstance(low, PublisherSlashed)

    def test_the_leverage_is_checked_before_the_premium(self) -> None:
        # Both wrong: the reason names the leverage, because the leverage is the coarser error and
        # the one that changes the instrument.
        result = adjudicate(
            commitment(),
            refit_returning(LAMBDA_WAD + 5, PREMIUM_WAD + 10**16),
            reference_keccak,
        )
        assert isinstance(result, PublisherSlashed)
        assert "lattice" in result.reason


class TestNoRuling:
    def test_unavailable_inputs_are_not_a_slash(self) -> None:
        # The distinction matters: a publisher whose inputs are missing has not been shown to have
        # published a wrong parameter, and slashing it would make the bond forfeitable by anyone who
        # can suppress a data source.
        result = adjudicate(commitment(), refit_unavailable, reference_keccak)
        assert isinstance(result, InputsUnavailable)

    def test_a_digest_that_does_not_reproduce_is_a_mismatch(self) -> None:
        entry = commitment()
        result = adjudicate(
            entry,
            refit_returning(LAMBDA_WAD, PREMIUM_WAD),
            reference_keccak,
            expected_digest=b"\x00" * 32,
        )
        assert isinstance(result, DigestMismatch)
        assert result.computed == expected_digest(entry)

    def test_the_digest_is_checked_before_the_fit_is_re_run(self) -> None:
        # A commitment whose fields do not hash to its recorded digest is not the commitment the
        # publisher made, so nothing downstream of it means anything -- and the fit must not be run
        # against inputs that the digest says are not the committed ones.
        def must_not_run(_inputs_hash: bytes) -> RefittedParameters | None:
            raise AssertionError("the fit was re-run before the digest was verified")

        result = adjudicate(
            commitment(), must_not_run, reference_keccak, expected_digest=b"\x00" * 32
        )
        assert isinstance(result, DigestMismatch)

    def test_a_correct_digest_passes_the_check(self) -> None:
        entry = commitment()
        assert digest_matches(entry, expected_digest(entry), reference_keccak)

    def test_a_wrong_digest_fails_the_check(self) -> None:
        # Exposed separately because a challenger needs it *before* posting a bond: a commitment
        # whose digest does not reproduce is a challenge that cannot lose.
        assert not digest_matches(commitment(), b"\x00" * 32, reference_keccak)


class TestValueObject:
    def test_a_short_name_id_is_refused(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="name_id"):
            CommittedParameterSet(
                name_id=b"short",
                for_session=1,
                lambda_wad=LAMBDA_WAD,
                premium_wad=PREMIUM_WAD,
                inputs_hash=INPUTS,
            )

    def test_a_short_inputs_hash_is_refused(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="inputs_hash"):
            CommittedParameterSet(
                name_id=NAME,
                for_session=1,
                lambda_wad=LAMBDA_WAD,
                premium_wad=PREMIUM_WAD,
                inputs_hash=b"short",
            )

    def test_a_negative_session_is_refused(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="for_session"):
            CommittedParameterSet(
                name_id=NAME,
                for_session=-1,
                lambda_wad=LAMBDA_WAD,
                premium_wad=PREMIUM_WAD,
                inputs_hash=INPUTS,
            )
