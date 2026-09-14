"""The commitment digest's own layout and its input validation, at unit level.

`tests/contract/test_digest_contract.py` checks this module against the shared fixture, which is the
cross-language contract. That suite is the important one and it was passing while every one of the
guards below was unexercised: a fixture test exercises the *happy* path by construction, because a
fixture is a set of valid inputs. Eight of this module's eleven statements that can raise had never
raised, and they are the statements that keep the encoding unambiguous.

The docstring's claim is worth restating because it is the reason these guards matter: the source
identifiers are length-prefixed so that `["AB", "C"]` and `["A", "BC"]` cannot collide, and a
collision "would let a publisher commit one input set and be challenged against another". A guard
that has never fired is indistinguishable from one that does nothing, and this is the module where
that difference is a security property rather than a tidiness preference.
"""

from __future__ import annotations

import pytest

from bell_calibrator.domain.digest import commitment_preimage, inputs_preimage
from bell_calibrator.domain.models import SessionKind, Wad

NAME_ID = bytes(range(32))
INPUTS_HASH = bytes(range(32, 64))
ROWS_DIGEST = bytes(range(64, 96))
FOR_SESSION = 42
LAM = Wad(15 * 10**18)
PREMIUM = Wad(174 * 10**15)


# --------------------------------------------------------------------------- the preimage layout


def test_commitment_preimage_lays_the_fields_out_at_the_documented_offsets() -> None:
    """The 160-byte layout, pinned field by field.

    The contract test asserts the *hash* agrees with Solidity, which would still hold if this module
    and the fixture generator drifted together. This asserts the layout the docstring specifies, so
    a change to it fails here as well as in the cross-language suite.
    """
    preimage = commitment_preimage(NAME_ID, FOR_SESSION, LAM, PREMIUM, INPUTS_HASH)

    assert len(preimage) == 160, "five 32-byte words"
    assert preimage[0:32] == NAME_ID
    assert preimage[32:64] == FOR_SESSION.to_bytes(8, "big").rjust(32, b"\x00"), "uint64 aligned"
    assert preimage[64:96] == LAM.raw.to_bytes(32, "big")
    assert preimage[96:128] == PREMIUM.raw.to_bytes(32, "big")
    assert preimage[128:160] == INPUTS_HASH


def test_inputs_preimage_lays_the_fields_out_in_the_documented_order() -> None:
    """Window, session, length-prefixed sources, row count, rows digest -- in that order."""
    encoded = inputs_preimage(126, SessionKind.WEEKEND, ["AB", "C"], 10, ROWS_DIGEST)

    expected = (
        (126).to_bytes(4, "big")
        + b"\x01"
        + b"W"
        + b"\x02"
        + b"\x02"
        + b"AB"
        + b"\x01"
        + b"C"
        + (10).to_bytes(4, "big")
        + ROWS_DIGEST
    )
    assert encoded == expected


# --------------------------------------------------------------------------- commitment validation


def test_commitment_preimage_rejects_a_name_id_that_is_not_32_bytes() -> None:
    with pytest.raises(ValueError, match="nameId must be 32 bytes"):
        commitment_preimage(b"\x00" * 31, FOR_SESSION, LAM, PREMIUM, INPUTS_HASH)

    with pytest.raises(ValueError, match="nameId must be 32 bytes"):
        commitment_preimage(b"\x00" * 33, FOR_SESSION, LAM, PREMIUM, INPUTS_HASH)


def test_commitment_preimage_rejects_an_inputs_hash_that_is_not_32_bytes() -> None:
    with pytest.raises(ValueError, match="inputsHash must be 32 bytes"):
        commitment_preimage(NAME_ID, FOR_SESSION, LAM, PREMIUM, b"\x00" * 31)

    with pytest.raises(ValueError, match="inputsHash must be 32 bytes"):
        commitment_preimage(NAME_ID, FOR_SESSION, LAM, PREMIUM, b"\x00" * 33)


def test_commitment_preimage_rejects_a_negative_parameter() -> None:
    """A negative WAD has no `uint256` encoding, and `to_bytes` would raise a less specific error.

    `Wad` itself does not refuse a negative raw -- it is a fixed-point quantity, not a
    non-negative one -- so the refusal belongs here, where the encoding is defined.
    """
    with pytest.raises(ValueError, match="cannot be negative"):
        commitment_preimage(NAME_ID, FOR_SESSION, Wad(-1), PREMIUM, INPUTS_HASH)

    with pytest.raises(ValueError, match="cannot be negative"):
        commitment_preimage(NAME_ID, FOR_SESSION, LAM, Wad(-1), INPUTS_HASH)


def test_commitment_preimage_rejects_a_negative_for_session() -> None:
    with pytest.raises(ValueError, match="uint64"):
        commitment_preimage(NAME_ID, -1, LAM, PREMIUM, INPUTS_HASH)


# --------------------------------------------------------------------------- inputs validation


def test_inputs_preimage_rejects_a_window_that_does_not_fit_uint32() -> None:
    with pytest.raises(ValueError, match="windowSessions must fit a uint32"):
        inputs_preimage(2**32, SessionKind.OVERNIGHT, ["S"], 1, ROWS_DIGEST)

    with pytest.raises(ValueError, match="windowSessions must fit a uint32"):
        inputs_preimage(-1, SessionKind.OVERNIGHT, ["S"], 1, ROWS_DIGEST)


def test_inputs_preimage_rejects_a_row_count_that_does_not_fit_uint32() -> None:
    with pytest.raises(ValueError, match="rowCount must fit a uint32"):
        inputs_preimage(126, SessionKind.OVERNIGHT, ["S"], 2**32, ROWS_DIGEST)

    with pytest.raises(ValueError, match="rowCount must fit a uint32"):
        inputs_preimage(126, SessionKind.OVERNIGHT, ["S"], -1, ROWS_DIGEST)


def test_inputs_preimage_rejects_a_rows_digest_that_is_not_32_bytes() -> None:
    with pytest.raises(ValueError, match="rowsDigest must be 32 bytes"):
        inputs_preimage(126, SessionKind.OVERNIGHT, ["S"], 1, b"\x00" * 31)


def test_inputs_preimage_rejects_more_than_255_sources() -> None:
    """The source count is a single byte, so 256 would encode as zero and silently lose them all."""
    with pytest.raises(ValueError, match="at most 255 source identifiers"):
        inputs_preimage(126, SessionKind.OVERNIGHT, ["S"] * 256, 1, ROWS_DIGEST)


def test_inputs_preimage_accepts_exactly_255_sources() -> None:
    """The bound is inclusive at 255, which is the value the byte can hold."""
    encoded = inputs_preimage(126, SessionKind.OVERNIGHT, ["S"] * 255, 1, ROWS_DIGEST)

    # window (4) + session-length byte (1) + session code, then the count byte.
    session_code = SessionKind.OVERNIGHT.value.encode("ascii")
    count_offset = 4 + 1 + len(session_code)
    assert encoded[count_offset] == 255, "the count byte holds 255"


def test_inputs_preimage_rejects_an_over_long_source_identifier() -> None:
    """The length prefix is a single byte, and this is the guard that keeps it honest.

    Without it, a 256-byte identifier would encode its length as zero and the identifier would be
    read as the start of the next field -- the collision the length prefix exists to prevent,
    arrived at from the other direction.
    """
    with pytest.raises(ValueError, match="source identifier too long"):
        inputs_preimage(126, SessionKind.OVERNIGHT, ["x" * 256], 1, ROWS_DIGEST)


def test_inputs_preimage_measures_the_identifier_in_utf8_bytes_not_characters() -> None:
    """A multi-byte character costs more than one byte, and the prefix counts bytes.

    A guard that counted characters would admit a 200-character identifier of 3-byte characters,
    which is 600 bytes and overflows the prefix.
    """
    over_long = "\u00e9" * 200  # 400 UTF-8 bytes, 200 characters
    with pytest.raises(ValueError, match="source identifier too long"):
        inputs_preimage(126, SessionKind.OVERNIGHT, [over_long], 1, ROWS_DIGEST)

    # And one that fits in bytes is accepted even though it is many characters.
    fits = "\u00e9" * 127  # 254 UTF-8 bytes
    assert inputs_preimage(126, SessionKind.OVERNIGHT, [fits], 1, ROWS_DIGEST)
