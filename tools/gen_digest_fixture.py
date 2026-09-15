#!/usr/bin/env python3
"""Generate `spec/digest.json`, the cross-language commitment fixture.

The fixture is the contract between the on-chain registry and the off-chain publisher. It is
consumed by two tests that must agree byte for byte:

    contracts/test/differential/Digest.t.sol        (Solidity: keccak256(abi.encode(...)))
    calibrator/tests/contract/test_digest_contract.py   (Python: domain.digest layout)

The expected digests are computed here by the Python layout and hashed with a reference keccak
implementation. If the Solidity side disagrees, the two sides' *encodings* have diverged -- which is
the failure this fixture exists to catch, because a digest mismatch would make every honest
challenge fail.

Run with `make build`. Deterministic.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from Crypto.Hash import keccak  # type: ignore[import-untyped]

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT = REPO_ROOT / "spec" / "digest.json"
CALIBRATOR_SRC = REPO_ROOT / "calibrator" / "src"

sys.path.insert(0, str(CALIBRATOR_SRC))

from bell_calibrator.domain import digest as digest_module  # noqa: E402
from bell_calibrator.domain.models import SessionKind, Symbol, Wad  # noqa: E402

WAD = 10**18

# Cases are chosen to exercise every part of the encoding that could plausibly diverge: a multi-
# character symbol, a session kind that is not the first enum member, a leverage and premium that
# are not round numbers, a source list with more than one entry, and a `forSession` whose high bytes
# are non-zero so a truncating uint64 encoding would be caught.
CASES = [
    {
        "label": "overnight",
        "symbol": "NVDA",
        "session": SessionKind.OVERNIGHT,
        "for_session": 12_345,
        "lambda_wad": 15 * WAD,
        "premium_wad": 174_000_000_000_000_000,
        "window_sessions": 504,
        "source_ids": ["nasdaq-daily-ohlc"],
        "row_count": 1_965,
        "rows_seed": "NVDA/E/504",
    },
    {
        "label": "weekend-multi-source",
        "symbol": "TSLA",
        "session": SessionKind.WEEKEND,
        "for_session": 4_294_967_296,  # 2^32: catches a uint32 encoding of forSession
        "lambda_wad": 10 * WAD,
        "premium_wad": 169_300_000_000_000_000,
        "window_sessions": 126,
        "source_ids": ["nasdaq-daily-ohlc", "nyse-consolidated"],
        "row_count": 452,
        "rows_seed": "TSLA/W/126",
    },
    {
        "label": "event",
        "symbol": "AAPL",
        "session": SessionKind.EVENT,
        "for_session": 18_446_744_073_709_551_615,  # uint64 max
        "lambda_wad": 11 * WAD,
        "premium_wad": 361_300_000_000_000_000,
        "window_sessions": 34,
        "source_ids": ["nasdaq-earnings-calendar"],
        "row_count": 35,
        "rows_seed": "AAPL/C/34",
    },
]


def reference_keccak(data: bytes) -> bytes:
    hasher = keccak.new(digest_bits=256)
    hasher.update(data)
    return hasher.digest()


def render() -> tuple[str, int]:
    """The fixture's text, and its case count.

    Split out of `main` so `--check` can compare without writing, mirroring `gen_constants.py` and
    `gen_moments_fixture.py`. See DESIGN_NOTES.md F72.
    """
    entries = []
    for case in CASES:
        symbol = Symbol(case["symbol"])
        session: SessionKind = case["session"]
        lam = Wad(case["lambda_wad"])
        premium = Wad(case["premium_wad"])

        name_id = digest_module.name_id(reference_keccak, symbol)
        rows_digest = reference_keccak(case["rows_seed"].encode("ascii"))
        inputs = digest_module.inputs_hash(
            reference_keccak,
            case["window_sessions"],
            session,
            case["source_ids"],
            case["row_count"],
            rows_digest,
        )
        commitment = digest_module.commitment_digest(
            reference_keccak, name_id, case["for_session"], lam, premium, inputs
        )

        entries.append(
            {
                "label": case["label"],
                "symbol": symbol.text,
                "nameId": "0x" + name_id.hex(),
                # A string, like `lambdaWad` and `premiumWad` below, and for the same reason: the
                # value can exceed the range a JSON consumer can represent exactly. `forSession` is a
                # uint64, and the boundary case is uint64 max, which is larger than JavaScript's
                # `Number.MAX_SAFE_INTEGER` (2^53 - 1). A JSON parser in a language with one numeric
                # type reads `18446744073709551615` as `18446744073709552000` -- which is exactly
                # 2^64, so the boundary case silently becomes an *out-of-range* value rather than a
                # wrong digest. Emitting it as a string is what makes the fixture losslessly readable
                # by every consumer.
                "forSession": str(case["for_session"]),
                "sessionCode": session.value,
                "windowSessions": case["window_sessions"],
                "sourceIds": case["source_ids"],
                "rowCount": case["row_count"],
                "rowsSeed": case["rows_seed"],
                "rowsDigest": "0x" + rows_digest.hex(),
                "lambdaWad": str(lam.raw),
                "premiumWad": str(premium.raw),
                "inputsHash": "0x" + inputs.hex(),
                "digest": "0x" + commitment.hex(),
                "preimageLength": len(
                    digest_module.commitment_preimage(
                        name_id, case["for_session"], lam, premium, inputs
                    )
                ),
            }
        )

    payload = {
        "_generated": "GENERATED FILE - DO NOT EDIT BY HAND.",
        # Both provenance strings name the derivation rather than the generator or the language that
        # produced them. `tools/gen_digest_fixture.ts` writes this fixture too, and
        # `make check-generated` runs both and requires them to agree byte for byte, so a banner
        # naming one of them is false whenever the other ran. The values are unchanged; see
        # DESIGN_NOTES.md F72.
        "_source": "domain/digest (keccak256 over the packed preimage)",
        "_spec": "paper Appendix B, and DESIGN_NOTES.md on the serialisation of inputsHash",
        "_note": (
            "The digest is keccak256 of the concatenation: nameId (bytes32), forSession "
            "(uint64 right-aligned in 32 bytes), lambdaWad (uint256), premiumWad (uint256), "
            "inputsHash (bytes32). The off-chain side builds that preimage in `domain/digest`; the "
            "Solidity side uses abi.encode."
        ),
        "cases": entries,
        # Carried explicitly so the Solidity consumer does not have to guess the array length:
        # `vm.parseJson` gives no way to ask a JSON array how long it is.
        "caseCount": len(entries),
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n", len(entries)


def main() -> int:
    """Write the fixture, or with `--check` report whether the committed one is stale."""
    content, case_count = render()
    OUT.parent.mkdir(parents=True, exist_ok=True)

    stale = not OUT.exists() or OUT.read_text() != content
    if stale:
        OUT.write_text(content)

    if "--check" in sys.argv and stale:
        print("generated files are stale:", file=sys.stderr)
        print(f"  {OUT.relative_to(REPO_ROOT)}", file=sys.stderr)
        print("run `make build`", file=sys.stderr)
        return 1
    state = "stale, rewritten" if stale else "up to date"
    print(f"  {OUT.relative_to(REPO_ROOT)}: {state}, {case_count} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
