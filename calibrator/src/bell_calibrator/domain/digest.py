"""The commitment digest: the cross-language contract of paper Appendix B.

Two things cross the language boundary in this protocol and both are specified once and tested on
both sides. This module is the second of them. The Solidity side is
`keccak256(abi.encode(nameId, forSession, lambdaWad, premiumWad, inputsHash))`; this module
reproduces that byte for byte, and `tests/contract/test_digest_contract.py` plus
`contracts/test/differential/Digest.t.sol` both read the same fixture from `spec/digest.json` and
assert agreement.

The hash itself is injected rather than imported. `domain/` may not depend on a hashing library
(build brief §7.4), so this module owns the *preimage layout* -- which is the part that has to be
identical across languages -- and the adapter owns the primitive.
"""

from __future__ import annotations

from collections.abc import Sequence

from bell_calibrator.domain.models import SessionKind, Symbol, Wad
from bell_calibrator.domain.ports import Keccak

_UINT64_BYTES = 8
_UINT256_BYTES = 32
_UINT32_BYTES = 4
_BYTES32_BYTES = 32
_SOURCE_ID_LENGTH_BYTES = 1


def commitment_preimage(
    name_id: bytes,
    for_session: int,
    lam: Wad,
    premium: Wad,
    inputs_hash: bytes,
) -> bytes:
    """The 112-byte preimage of the commitment digest, in `abi.encode` order.

    `abi.encode` pads each argument to 32 bytes and leaves fixed-size types unpadded in value, so
    the layout is exactly the concatenation of the big-endian encodings below. This is spelled out
    rather than delegated to an ABI library because a library that changes its encoding rules would
    silently break the contract with the chain, and because the layout is short enough to check by
    reading it.

    Layout, 32 + 32 + 32 + 32 + 32 = 160 bytes:

        [  0,  32)  nameId       bytes32
        [ 32,  64)  forSession   uint64, right-aligned in 32 bytes
        [ 64,  96)  lambdaWad    uint256
        [ 96, 128)  premiumWad   uint256
        [128, 160)  inputsHash   bytes32
    """
    if len(name_id) != _BYTES32_BYTES:
        raise ValueError("nameId must be 32 bytes")
    if len(inputs_hash) != _BYTES32_BYTES:
        raise ValueError("inputsHash must be 32 bytes")
    if not 0 <= for_session < 2**64:
        raise ValueError("forSession must fit a uint64")
    if lam.raw < 0 or premium.raw < 0:
        raise ValueError("a uint256 parameter cannot be negative")

    return (
        name_id
        + for_session.to_bytes(_UINT64_BYTES, "big").rjust(_UINT256_BYTES, b"\x00")
        + lam.raw.to_bytes(_UINT256_BYTES, "big")
        + premium.raw.to_bytes(_UINT256_BYTES, "big")
        + inputs_hash
    )


def commitment_digest(
    keccak: Keccak,
    name_id: bytes,
    for_session: int,
    lam: Wad,
    premium: Wad,
    inputs_hash: bytes,
) -> bytes:
    """`keccak256` of `commitment_preimage`, i.e. the value the registry stores and a challenger
    recomputes."""
    return keccak(
        commitment_preimage(name_id, for_session, lam, premium, inputs_hash)
    )


def inputs_preimage(
    window_sessions: int,
    session: SessionKind,
    source_ids: Sequence[str],
    row_count: int,
    rows_digest: bytes,
) -> bytes:
    """The canonical serialisation of the raw inputs a fit consumed.

    This is what makes a challenge a verification rather than a matter of testimony: any party can
    re-run the committed fit from these inputs and check the committed parameter against the result.
    Without it the mechanism degrades to trusting the publisher, which is the exact failure the
    commitment exists to prevent.

    The brief names the contents -- "window, session kind, source ids, row count, and a digest of
    the rows" -- but does not define the serialisation, and a cross-language contract needs an
    exact definition. This one is fixed here and mirrored by the Solidity fixture test:

        uint32  windowSessions            big-endian
        uint8   session code              the SessionKind value, one byte
        uint8   source count, then for each: uint8 length + UTF-8 bytes
        uint32  rowCount                  big-endian
        bytes32 rowsDigest

    Variable-length source identifiers are length-prefixed so that `["AB", "C"]` and `["A", "BC"]`
    cannot collide -- an ambiguity that would let a publisher commit one input set and be challenged
    against another.
    """
    if window_sessions < 0 or window_sessions >= 2**32:
        raise ValueError("windowSessions must fit a uint32")
    if row_count < 0 or row_count >= 2**32:
        raise ValueError("rowCount must fit a uint32")
    if len(rows_digest) != _BYTES32_BYTES:
        raise ValueError("rowsDigest must be 32 bytes")
    if len(source_ids) > 255:
        raise ValueError("at most 255 source identifiers")

    encoded_sources = bytearray()
    for source_id in source_ids:
        payload = source_id.encode("utf-8")
        if len(payload) > 255:
            raise ValueError(f"source identifier too long: {source_id!r}")
        encoded_sources += bytes([len(payload)]) + payload

    return (
        window_sessions.to_bytes(_UINT32_BYTES, "big")
        + bytes([len(session.value)])
        + session.value.encode("ascii")
        + bytes([len(source_ids)])
        + bytes(encoded_sources)
        + row_count.to_bytes(_UINT32_BYTES, "big")
        + rows_digest
    )


def inputs_hash(
    keccak: Keccak,
    window_sessions: int,
    session: SessionKind,
    source_ids: Sequence[str],
    row_count: int,
    rows_digest: bytes,
) -> bytes:
    """`keccak256` of `inputs_preimage`."""
    return keccak(
        inputs_preimage(window_sessions, session, source_ids, row_count, rows_digest)
    )


def name_id(keccak: Keccak, symbol: Symbol) -> bytes:
    """`keccak256(bytes(symbol))` -- a `bytes32`, not a string.

    Hashing the ticker rather than storing it keeps the commitment a fixed-width value, and the
    domain's `Symbol` validation is what stops a non-canonical ticker reaching this point.
    """
    return keccak(symbol.text.encode("ascii"))
