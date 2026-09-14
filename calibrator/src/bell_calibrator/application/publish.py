"""The publish use case: commit a parameter set before the session it describes opens.

The rule this exists to enforce is the contract's, restated on the off-chain side so a publisher
finds out before spending a bond rather than after. `PremiumRegistry.commit` reverts
`SessionAlreadyOpen(forSession, current)` when `forSession <= currentSession`, and this refuses the
same case for the same reason: the whole point of the commitment is that it was made before the
outcome was known, and a publisher that could wait to see the open would not need to fit anything.

The commitment is delegated to a port. `ParameterPublisher` is declared in the domain, so this layer
sequences the call without knowing whether it lands on a chain, on a file, or nowhere.
"""

from __future__ import annotations

from dataclasses import dataclass

from bell_calibrator.domain.digest import commitment_digest, name_id
from bell_calibrator.domain.models import ParameterSet
from bell_calibrator.domain.ports import Keccak, ParameterPublisher


@dataclass(frozen=True, slots=True)
class PublishRequest:
    """What to publish, and for which session."""

    parameters: ParameterSet
    for_session: int

    def __post_init__(self) -> None:
        if self.for_session < 0:
            raise ValueError("a session counter cannot be negative")


@dataclass(frozen=True, slots=True)
class Published:
    """The commitment was made, and this is the digest the publisher will be judged against."""

    digest: bytes
    for_session: int
    lambda_wad: int
    premium_wad: int
    model: str


@dataclass(frozen=True, slots=True)
class SessionAlreadyOpen:
    """The session has opened, so the fit could have seen the outcome. Nothing was published."""

    for_session: int
    current_session: int


#: A publish either committed or refused, and the refusal is a domain result rather than a failure:
#: publishing too late is an ordinary thing for a caller to attempt.
PublishResult = Published | SessionAlreadyOpen


def publish(
    request: PublishRequest,
    publisher: ParameterPublisher,
    keccak: Keccak,
    *,
    current_session: int,
) -> PublishResult:
    """Commit a parameter set, or refuse because the session has opened.

    The digest is computed here as well as by the registry, and that duplication is the point: a
    challenger recomputes it from the committed fields, and a publisher computing a different one
    would find out at challenge time. Computing it locally means the two are compared before the
    is posted.
    """
    if request.for_session <= current_session:
        return SessionAlreadyOpen(
            for_session=request.for_session, current_session=current_session
        )

    digest = commitment_digest(
        keccak,
        name_id(keccak, request.parameters.symbol),
        request.for_session,
        request.parameters.lam,
        request.parameters.premium,
        request.parameters.inputs_hash,
    )
    publisher.publish(request.parameters, request.for_session)
    return Published(
        digest=digest,
        for_session=request.for_session,
        lambda_wad=request.parameters.lam.raw,
        premium_wad=request.parameters.premium.raw,
        model=request.parameters.model,
    )
