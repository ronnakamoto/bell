"""The commitment digest, checked against the shared fixture.

The counterpart is `contracts/test/differential/Digest.t.sol`, which reads the same file and
recomputes the same values with `keccak256(abi.encode(...))`. Paper Appendix B makes this a
cross-language contract: if the two encodings ever diverge, every honest challenge fails, and the
failure is silent because a digest mismatch looks exactly like a dishonest publisher.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from Crypto.Hash import keccak

from bell_calibrator.domain import digest as digest_module
from bell_calibrator.domain.models import SessionKind, Symbol, Wad

FIXTURE = Path(__file__).resolve().parents[3] / "spec" / "digest.json"


def reference_keccak(data: bytes) -> bytes:
    hasher = keccak.new(digest_bits=256)
    hasher.update(data)
    return hasher.digest()


def load_cases() -> list[dict[str, Any]]:
    payload: dict[str, Any] = json.loads(FIXTURE.read_text())
    cases: list[dict[str, Any]] = payload["cases"]
    assert len(cases) == payload["caseCount"]
    return cases


def test_commitment_digest_matches_the_fixture() -> None:
    for case in load_cases():
        computed = digest_module.commitment_digest(
            reference_keccak,
            bytes.fromhex(case["nameId"][2:]),
            case["forSession"],
            Wad(int(case["lambdaWad"])),
            Wad(int(case["premiumWad"])),
            bytes.fromhex(case["inputsHash"][2:]),
        )
        assert "0x" + computed.hex() == case["digest"], case["label"]


def test_inputs_hash_matches_the_fixture() -> None:
    for case in load_cases():
        computed = digest_module.inputs_hash(
            reference_keccak,
            case["windowSessions"],
            SessionKind(case["sessionCode"]),
            case["sourceIds"],
            case["rowCount"],
            bytes.fromhex(case["rowsDigest"][2:]),
        )
        assert "0x" + computed.hex() == case["inputsHash"], case["label"]


def test_name_id_matches_the_fixture() -> None:
    for case in load_cases():
        computed = digest_module.name_id(reference_keccak, Symbol(case["symbol"]))
        assert "0x" + computed.hex() == case["nameId"], case["label"]


def test_preimage_is_five_words() -> None:
    for case in load_cases():
        preimage = digest_module.commitment_preimage(
            bytes.fromhex(case["nameId"][2:]),
            case["forSession"],
            Wad(int(case["lambdaWad"])),
            Wad(int(case["premiumWad"])),
            bytes.fromhex(case["inputsHash"][2:]),
        )
        assert len(preimage) == case["preimageLength"] == 160


def test_inputs_serialisation_cannot_be_confused_by_source_splits() -> None:
    # Length-prefixing the source identifiers is what prevents this collision. Without it a
    # publisher could commit one input set and be challenged against another.
    digest = b"\x00" * 32
    joined = digest_module.inputs_preimage(126, SessionKind.WEEKEND, ["AB", "C"], 10, digest)
    split = digest_module.inputs_preimage(126, SessionKind.WEEKEND, ["A", "BC"], 10, digest)
    assert joined != split


def test_rejects_a_for_session_beyond_uint64() -> None:
    with __import__("pytest").raises(ValueError, match="uint64"):
        digest_module.commitment_preimage(
            b"\x00" * 32, 2**64, Wad(10**18), Wad(10**17), b"\x00" * 32
        )
