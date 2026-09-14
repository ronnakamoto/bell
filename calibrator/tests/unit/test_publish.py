"""The publish use case.

The rule under test is the contract's, restated off-chain: `PremiumRegistry.commit` reverts
`SessionAlreadyOpen` when the session has opened, and this refuses the same case so that a publisher
finds out before spending a bond rather than after.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from Crypto.Hash import keccak

from bell_calibrator.application.publish import (
    Published,
    PublishRequest,
    SessionAlreadyOpen,
    publish,
)
from bell_calibrator.domain.constants import WAD
from bell_calibrator.domain.digest import commitment_digest, name_id
from bell_calibrator.domain.models import ParameterSet, SessionKind, Symbol, Wad

NVDA = Symbol("NVDA")
INPUTS_HASH = bytes(range(32))
PARAMETERS = ParameterSet(
    symbol=NVDA,
    session=SessionKind.OVERNIGHT,
    lam=Wad(15 * WAD),
    premium=Wad(int(Decimal("0.1740") * WAD)),
    inputs_hash=INPUTS_HASH,
    model="empirical",
)


def reference_keccak(data: bytes) -> bytes:
    hasher = keccak.new(digest_bits=256)
    hasher.update(data)
    return bytes(hasher.digest())


class RecordingPublisher:
    """A `ParameterPublisher` that records what it was asked to commit."""

    def __init__(self) -> None:
        self.calls: list[tuple[ParameterSet, int]] = []

    def publish(self, parameters: ParameterSet, for_session: int) -> str:
        self.calls.append((parameters, for_session))
        return "0x" + "00" * 32


class TestPublishing:
    def test_a_future_session_is_published(self) -> None:
        publisher = RecordingPublisher()
        result = publish(
            PublishRequest(parameters=PARAMETERS, for_session=10),
            publisher,
            reference_keccak,
            current_session=9,
        )
        assert isinstance(result, Published)
        assert result.for_session == 10
        assert result.lambda_wad == 15 * WAD
        assert result.model == "empirical"
        assert len(publisher.calls) == 1

    def test_the_returned_digest_is_the_one_a_challenger_would_compute(self) -> None:
        # The digest is computed locally as well as by the registry, and that duplication is the
        # point: a challenger recomputes it from the committed fields, so a publisher that computed
        # a different one would find out at challenge time rather than before posting the bond.
        result = publish(
            PublishRequest(parameters=PARAMETERS, for_session=10),
            RecordingPublisher(),
            reference_keccak,
            current_session=9,
        )
        assert isinstance(result, Published)
        assert result.digest == commitment_digest(
            reference_keccak,
            name_id(reference_keccak, NVDA),
            10,
            PARAMETERS.lam,
            PARAMETERS.premium,
            INPUTS_HASH,
        )

    def test_the_digest_is_sensitive_to_the_session(self) -> None:
        first = publish(
            PublishRequest(parameters=PARAMETERS, for_session=10),
            RecordingPublisher(),
            reference_keccak,
            current_session=9,
        )
        second = publish(
            PublishRequest(parameters=PARAMETERS, for_session=11),
            RecordingPublisher(),
            reference_keccak,
            current_session=9,
        )
        assert isinstance(first, Published)
        assert isinstance(second, Published)
        assert first.digest != second.digest


class TestTheNoFitAfterTheOutcomeRule:
    def test_publishing_for_the_current_session_is_refused(self) -> None:
        # `forSession == currentSession` is already too late: the outcome may be known, so the fit
        # could have seen it.
        result = publish(
            PublishRequest(parameters=PARAMETERS, for_session=10),
            RecordingPublisher(),
            reference_keccak,
            current_session=10,
        )
        assert isinstance(result, SessionAlreadyOpen)
        assert result.for_session == 10
        assert result.current_session == 10

    def test_publishing_for_a_past_session_is_refused(self) -> None:
        result = publish(
            PublishRequest(parameters=PARAMETERS, for_session=4),
            RecordingPublisher(),
            reference_keccak,
            current_session=10,
        )
        assert isinstance(result, SessionAlreadyOpen)

    def test_the_publisher_is_not_called_on_a_refusal(self) -> None:
        # The refusal has to happen before the port is touched: a publisher that had already
        # committed would have spent a bond on a parameter set the registry would reject.
        publisher = RecordingPublisher()
        publish(
            PublishRequest(parameters=PARAMETERS, for_session=10),
            publisher,
            reference_keccak,
            current_session=10,
        )
        assert publisher.calls == []


class TestTheRequest:
    def test_a_negative_session_is_refused(self) -> None:
        with pytest.raises(ValueError, match="cannot be negative"):
            PublishRequest(parameters=PARAMETERS, for_session=-1)
