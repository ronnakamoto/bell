"""Ports. Protocols only -- no implementations, and no imports beyond the standard library and the
shared domain core.

Ports are declared in the domain and implemented by adapters, so the dependency arrow points inward.
The reference-print source is a port rather than a concrete client for the reason the brief gives:
the feed will change, and the domain must not.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from bell_settlement.domain.prints import ReferencePrint


@runtime_checkable
class ReferencePrintSource(Protocol):
    """A source of reference prints for a session.

    Implemented by an HTTP client against the issuer's feed, by a file reader for a replay, and by a
    list for the tests. The domain never learns which.
    """

    def prints_for(self, reference_token: str) -> Sequence[ReferencePrint]:
        """Every print currently held for `reference_token`, in no particular order.

        Unordered on purpose. The selection is total and deterministic, so imposing an order at the
        port would be a second ordering rule that the domain would have to ignore -- and a source
        that returned a different order on a retry would look like a different input set.
        """
        ...


@runtime_checkable
class CommittedInputStore(Protocol):
    """Retrieves the raw inputs a committed fit consumed, so that the fit can be re-run.

    The digest is the key, not the session: the commitment names an `inputsHash`, and a store that
    could only be asked by session could return a different input set from the one committed.
    """

    def rows_digest(self, inputs_hash: bytes) -> bytes | None:
        """The digest of the rows the committed fit consumed, or `None` if they are unavailable.

        `None` rather than an exception, because an unavailable input is an ordinary outcome that
        adjudication reports as `InputsUnavailable`. Making it an exception would force every caller
        to catch one to say the same thing.
        """
        ...
