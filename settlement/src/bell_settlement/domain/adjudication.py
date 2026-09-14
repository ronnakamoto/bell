"""Challenge adjudication: re-run a committed fit from its committed inputs.

This is the mechanism that makes a challenge a *verification* rather than a matter of testimony. The
arbiter does not decide whether a published parameter is good; it decides whether the parameter
matches what the committed inputs produce. That is a deterministic re-run, and it is only possible
because `inputsHash` is committed alongside the parameter -- without it the whole mechanism degrades
to trusting the publisher, which is the exact failure the commitment exists to prevent.

Result types throughout, because every outcome here is expected rather than exceptional: a parameter
that matches, a parameter that does not, and inputs that cannot be retrieved are three ordinary
results of running the check, not three errors.

The fit itself is injected. `adjudicate` takes a callable rather than importing the calibrator's
fitters, so that the settlement service decides *what to compare* and the calibrator decides *how to
fit* -- and so that the comparison can be tested against a stub without a sample.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal

from bell_calibrator.domain.constants import WAD
from bell_calibrator.domain.digest import commitment_digest
from bell_calibrator.domain.models import Wad
from bell_calibrator.domain.ports import Keccak

# ---------------------------------------------------------------- tolerances
#
# Both are derived rather than chosen, and the derivation is the reason the two differ by six orders
# of magnitude.

#: The leverage is an integer on the harmonic ladder, so it is published exactly and must match
#: exactly. A tolerance here would be a tolerance on which instrument was listed.
LEVERAGE_TOLERANCE_WAD = 0

#: The premium is published to four decimal places -- `0.1740`, `0.1465` -- so the published figure
#: carries a rounding uncertainty of 5e-5 absolute. A re-run that lands inside that is consistent
#: with the published number; one that lands outside it is not.
PREMIUM_TOLERANCE_WAD = 5 * 10**13


@dataclass(frozen=True, slots=True)
class CommittedParameterSet:
    """What a publisher committed to, as the chain holds it."""

    name_id: bytes
    for_session: int
    lambda_wad: int
    premium_wad: int
    inputs_hash: bytes

    def __post_init__(self) -> None:
        if len(self.name_id) != 32:
            raise ValueError("name_id must be 32 bytes")
        if len(self.inputs_hash) != 32:
            raise ValueError("inputs_hash must be 32 bytes")
        if self.for_session < 0:
            raise ValueError("for_session cannot be negative")


@dataclass(frozen=True, slots=True)
class RefittedParameters:
    """What re-running the fit from the committed inputs produced."""

    lambda_wad: int
    premium_wad: int


# ---------------------------------------------------------------- the result type


@dataclass(frozen=True, slots=True)
class PublisherUpheld:
    """The committed parameter matches the committed inputs. The publisher keeps its bond."""

    commitment: CommittedParameterSet
    refitted: RefittedParameters
    premium_delta_wad: int
    digest: bytes


@dataclass(frozen=True, slots=True)
class PublisherSlashed:
    """The committed parameter does not match the committed inputs."""

    commitment: CommittedParameterSet
    refitted: RefittedParameters
    reason: str
    digest: bytes


@dataclass(frozen=True, slots=True)
class InputsUnavailable:
    """The committed inputs could not be retrieved, so no ruling is possible.

    A distinct outcome from a slash, and the distinction matters: a publisher whose inputs are
    missing has not been shown to have published a wrong parameter, and slashing it would make the
    bond forfeitable by anyone who can suppress a data source.
    """

    commitment: CommittedParameterSet
    reason: str


@dataclass(frozen=True, slots=True)
class DigestMismatch:
    """The commitment is internally inconsistent: its digest is not the digest of its fields.

    Also distinct from a slash, and the difference is who is at fault. A digest mismatch means the
    chain holds a commitment whose fields do not hash to what was recorded, which is a fault in the
    commitment rather than a bad fit.
    """

    commitment: CommittedParameterSet
    expected: bytes
    computed: bytes


AdjudicationResult = (
    PublisherUpheld | PublisherSlashed | InputsUnavailable | DigestMismatch
)

#: A re-run of a committed fit. Returns `None` when the inputs cannot be retrieved, which is a
#: domain outcome rather than an exception -- an unavailable data source is ordinary, not
#: exceptional, and making it an exception would force every caller to catch one.
RefitRunner = Callable[[bytes], RefittedParameters | None]


def adjudicate(
    commitment: CommittedParameterSet,
    refit: RefitRunner,
    keccak: Keccak,
    *,
    expected_digest: bytes | None = None,
    leverage_tolerance_wad: int = LEVERAGE_TOLERANCE_WAD,
    premium_tolerance_wad: int = PREMIUM_TOLERANCE_WAD,
) -> AdjudicationResult:
    """Rule on whether a committed parameter matches its committed inputs.

    The order of the checks is the order of their precedence. The digest is verified first, since a
    commitment whose fields do not hash to its recorded digest is not the commitment the publisher
    made and nothing downstream of it means anything. Then the re-run, because an unavailable input
    is not a ruling. Only then the comparison.
    """
    computed_digest = commitment_digest(
        keccak,
        commitment.name_id,
        commitment.for_session,
        Wad(commitment.lambda_wad),
        Wad(commitment.premium_wad),
        commitment.inputs_hash,
    )
    if expected_digest is not None and computed_digest != expected_digest:
        return DigestMismatch(
            commitment=commitment, expected=expected_digest, computed=computed_digest
        )

    refitted = refit(commitment.inputs_hash)
    if refitted is None:
        return InputsUnavailable(
            commitment=commitment,
            reason="the committed inputs could not be retrieved, so no ruling is possible",
        )

    leverage_delta = abs(refitted.lambda_wad - commitment.lambda_wad)
    if leverage_delta > leverage_tolerance_wad:
        return PublisherSlashed(
            commitment=commitment,
            refitted=refitted,
            reason=(
                f"the committed leverage is off the lattice the committed inputs produce by "
                f"{leverage_delta} wei; the leverage is an integer and is published exactly"
            ),
            digest=computed_digest,
        )

    premium_delta = abs(refitted.premium_wad - commitment.premium_wad)
    if premium_delta > premium_tolerance_wad:
        return PublisherSlashed(
            commitment=commitment,
            refitted=refitted,
            reason=(
                f"the committed premium differs from the re-run by {premium_delta} wei, beyond the "
                f"{premium_tolerance_wad} wei the published precision allows"
            ),
            digest=computed_digest,
        )

    return PublisherUpheld(
        commitment=commitment,
        refitted=refitted,
        premium_delta_wad=premium_delta,
        digest=computed_digest,
    )


def digest_matches(
    commitment: CommittedParameterSet, expected_digest: bytes, keccak: Keccak
) -> bool:
    """Whether the commitment's fields hash to the digest the chain recorded.

    Exposed separately because a challenger needs it *before* committing a bond: a commitment whose
    digest does not reproduce is a challenge that cannot lose, and a challenger who has to spend the
    bond to find that out is being charged for the publisher's bookkeeping.
    """
    computed = commitment_digest(
        keccak,
        commitment.name_id,
        commitment.for_session,
        Wad(commitment.lambda_wad),
        Wad(commitment.premium_wad),
        commitment.inputs_hash,
    )
    return computed == expected_digest


def premium_tolerance_from_precision(decimal_places: int) -> int:
    """The premium tolerance implied by a published precision, at WAD scale.

    Half a unit in the last published place. Four decimal places gives 5e-5, which is the value
    `PREMIUM_TOLERANCE_WAD` carries; the function exists so that a change to the published precision
    is a change in one place rather than a constant someone has to remember to update.
    """
    if decimal_places < 0:
        raise ValueError("a precision cannot be negative")
    half_unit = Decimal(5) / (Decimal(10) ** (decimal_places + 1))
    return int(half_unit * WAD)
