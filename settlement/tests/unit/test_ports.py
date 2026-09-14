"""The ports, and the structural contract they impose.

Nothing in the workspace imported `bell_settlement.domain.ports`. The module therefore reported 0%
coverage, and more to the point nothing checked that the protocols are *satisfiable*. A
`Protocol` is a promise about shape: if it declared a member no adapter could implement, or if
`runtime_checkable` were dropped from it, the failure would surface when the first adapter was
written rather than here.

These tests are deliberately structural. There are no adapters yet -- `adapters/` exists so the
`import-linter` contracts are enforced from the first commit rather than bolted on -- so what can be
checked now is that the declared interfaces are coherent and that a conforming object is recognised
as one.
"""

from __future__ import annotations

from collections.abc import Sequence

from bell_settlement.domain.ports import CommittedInputStore, ReferencePrintSource
from bell_settlement.domain.prints import ReferencePrint


class _APrintSource:
    """The smallest object that satisfies `ReferencePrintSource`."""

    def prints_for(self, reference_token: str) -> Sequence[ReferencePrint]:
        return ()


class _AnInputStore:
    """The smallest object that satisfies `CommittedInputStore`."""

    def rows_digest(self, inputs_hash: bytes) -> bytes | None:
        return None


class _Neither:
    """An object that satisfies neither port."""

    def something_else(self) -> None:
        """Not a port method."""


def test_a_conforming_object_satisfies_the_print_source_port() -> None:
    assert isinstance(_APrintSource(), ReferencePrintSource)


def test_a_conforming_object_satisfies_the_input_store_port() -> None:
    assert isinstance(_AnInputStore(), CommittedInputStore)


def test_an_object_without_the_member_does_not_satisfy_the_port() -> None:
    """`runtime_checkable` checks for the *presence* of the declared members, which is the whole
    value of marking these protocols runtime-checkable rather than leaving them structural-only: it
    turns a shape error into something a test can assert rather than something mypy alone knows."""
    assert not isinstance(_Neither(), ReferencePrintSource)
    assert not isinstance(_Neither(), CommittedInputStore)


def test_the_two_ports_are_not_interchangeable() -> None:
    """Each port declares exactly one method, and they are different methods.

    Worth asserting because the two are structurally similar -- one method, taking one argument,
    returning an optional-or-empty value -- so a copy-paste that gave both the same method name
    would make an adapter for one silently satisfy the other.
    """
    assert not isinstance(_APrintSource(), CommittedInputStore)
    assert not isinstance(_AnInputStore(), ReferencePrintSource)
