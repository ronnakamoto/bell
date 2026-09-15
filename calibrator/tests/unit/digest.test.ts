/**
 * The commitment digest's own layout and its input validation, at unit level.
 *
 * `tests/contract/digest.test.ts` checks this module against the shared fixture, which is the
 * cross-language contract. That suite is the important one — and the Python's equivalent was passing
 * while every guard below was unexercised, because a fixture test exercises the *happy* path by
 * construction: a fixture is a set of valid inputs. Eight of the module's eleven statements that can
 * raise had never raised, and they are the statements that keep the encoding unambiguous.
 *
 * The claim is worth restating because it is why these guards matter: the source identifiers are
 * length-prefixed so that `["AB", "C"]` and `["A", "BC"]` cannot collide, and a collision "would let a
 * publisher commit one input set and be challenged against another". A guard that has never fired is
 * indistinguishable from one that does nothing, and this is the module where that difference is a
 * security property rather than a tidiness preference.
 *
 * Two notes on the port, so a reader comparing the two files knows which differences are deliberate.
 *
 *  - **The Python takes `Wad` objects and reaches for `.raw`; these functions take the raw `bigint`.**
 *    The preimage is defined in raw terms, so a `Wad` would be a wrapper the encoding immediately
 *    unwraps.
 *  - **The expected encodings are built by the test-local `beBytes` below, not by `uintToBytes`.**
 *    `uintToBytes` is exported from this module and used by it, so asserting against it would be
 *    asserting a function against itself. The Python had the standard library's `int.to_bytes` for the
 *    same job.
 *
 * Every guard here is probed: `.recon/a8/probe.py` breaks each one and requires this file to go red,
 * because a ported test suite is a gate and a gate that has never failed has never been tested. Two
 * things that probing established and that reading would not have:
 *
 *  - **The `rowsDigest` width guard was one-sided**, here and in the Python. `rows_digest_width_upper_bound_only`
 *    left this file green until the over-long case was added below.
 *  - **The negative-parameter assertion is behavioural, not structural.** `commitmentPreimage` refuses a
 *    negative and so does `uintToBytes`, with the same message, so removing *either* guard changes
 *    nothing observable — `negative_parameter_outer_guard_removed` and
 *    `negative_parameter_inner_guard_removed` both stay green, and only
 *    `negative_parameter_both_guards_removed` goes red. The test pins the refusal, not which layer
 *    performs it. That is the intended shape rather than a gap: a guard belongs in the library *and* at
 *    its callers, and this is what the "and" costs.
 */

import { describe, expect, it } from 'vitest';

import { commitmentPreimage, inputsPreimage, uintToBytes } from '../../src/domain/digest.js';
import { SessionKind } from '../../src/domain/models.js';

/** `bytes(range(start, start + 32))` — the Python's fixture constants, spelled the same way. */
function range32(start: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => start + index);
}

/** Big-endian, left-padded to `width` bytes. Deliberately independent of `uintToBytes`. */
function beBytes(value: bigint, width: number): number[] {
  const out = new Array<number>(width).fill(0);
  let remaining = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** A string's UTF-8 bytes, as plain numbers, for comparison against a decoded preimage. */
function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

const NAME_ID = range32(0);
const INPUTS_HASH = range32(32);
const ROWS_DIGEST = range32(64);
const FOR_SESSION = 42n;
const LAM = 15n * 10n ** 18n;
const PREMIUM = 174n * 10n ** 15n;

describe('the commitment preimage layout', () => {
  it('lays the fields out at the documented offsets', () => {
    // The contract suite asserts the *hash* agrees with Solidity, which would still hold if this module
    // and the fixture generator drifted together. This asserts the layout the docstring specifies, so a
    // change to it fails here as well as in the cross-language suite.
    const preimage = commitmentPreimage(NAME_ID, FOR_SESSION, LAM, PREMIUM, INPUTS_HASH);

    expect(preimage.length, 'five 32-byte words').toBe(160);
    expect(Array.from(preimage.slice(0, 32)), 'nameId').toEqual(Array.from(NAME_ID));
    expect(Array.from(preimage.slice(32, 64)), 'uint64 right-aligned in 32 bytes').toEqual([
      ...new Array<number>(24).fill(0),
      ...beBytes(FOR_SESSION, 8),
    ]);
    expect(Array.from(preimage.slice(64, 96)), 'lambdaWad').toEqual(beBytes(LAM, 32));
    expect(Array.from(preimage.slice(96, 128)), 'premiumWad').toEqual(beBytes(PREMIUM, 32));
    expect(Array.from(preimage.slice(128, 160)), 'inputsHash').toEqual(Array.from(INPUTS_HASH));
  });
});

describe('the inputs preimage layout', () => {
  it('lays the fields out in the documented order', () => {
    // Window, session, length-prefixed sources, row count, rows digest — in that order. The contract
    // suite proves the split is *unambiguous*; this proves it is the split the docstring specifies.
    const encoded = inputsPreimage(126, SessionKind.WEEKEND, ['AB', 'C'], 10, ROWS_DIGEST);

    expect(Array.from(encoded)).toEqual([
      ...beBytes(126n, 4), // windowSessions, uint32 big-endian
      0x01, // session code length
      0x57, // 'W'
      0x02, // two source identifiers
      0x02,
      ...utf8('AB'),
      0x01,
      ...utf8('C'),
      ...beBytes(10n, 4), // rowCount, uint32 big-endian
      ...Array.from(ROWS_DIGEST),
    ]);
  });
});

describe('commitmentPreimage validation', () => {
  it('rejects a nameId that is not 32 bytes', () => {
    expect(() =>
      commitmentPreimage(new Uint8Array(31), FOR_SESSION, LAM, PREMIUM, INPUTS_HASH),
    ).toThrow(/nameId must be 32 bytes/);
    expect(() =>
      commitmentPreimage(new Uint8Array(33), FOR_SESSION, LAM, PREMIUM, INPUTS_HASH),
    ).toThrow(/nameId must be 32 bytes/);
  });

  it('rejects an inputsHash that is not 32 bytes', () => {
    expect(() =>
      commitmentPreimage(NAME_ID, FOR_SESSION, LAM, PREMIUM, new Uint8Array(31)),
    ).toThrow(/inputsHash must be 32 bytes/);
    expect(() =>
      commitmentPreimage(NAME_ID, FOR_SESSION, LAM, PREMIUM, new Uint8Array(33)),
    ).toThrow(/inputsHash must be 32 bytes/);
  });

  it('rejects a negative parameter', () => {
    // A negative WAD has no `uint256` encoding, and the byte writer would raise a less specific error.
    // `Wad` itself does not refuse a negative raw — it is a fixed-point quantity, not a non-negative
    // one — so the refusal belongs here, where the encoding is defined.
    expect(() => commitmentPreimage(NAME_ID, FOR_SESSION, -1n, PREMIUM, INPUTS_HASH)).toThrow(
      /cannot be negative/,
    );
    expect(() => commitmentPreimage(NAME_ID, FOR_SESSION, LAM, -1n, INPUTS_HASH)).toThrow(
      /cannot be negative/,
    );
  });

  it('rejects a negative forSession', () => {
    expect(() => commitmentPreimage(NAME_ID, -1n, LAM, PREMIUM, INPUTS_HASH)).toThrow(/uint64/);
  });

  it('rejects a forSession beyond uint64', () => {
    // The upper bound, and the one assertion in this file that came from the Python's *contract* suite
    // rather than its unit suite. It is a guard like the others here, so the port moves it in with them —
    // and it was the last one-sided bound left: `.recon/a8/probe.py` enumerates both languages' test names
    // per module, and this was the only Python test name with no TypeScript counterpart at all.
    //
    // The fixture cannot reach it, because a fixture is a set of valid inputs: its boundary case is uint64
    // *max*, which is legal, so nothing else in the suite asserts that max + 1 is refused.
    expect(() => commitmentPreimage(NAME_ID, 2n ** 64n, LAM, PREMIUM, INPUTS_HASH)).toThrow(
      /uint64/,
    );

    // And the boundary itself is accepted, which is what makes the refusal above a bound rather than an
    // off-by-one that happens to catch everything above it. The Python asserts only the refusal.
    const preimage = commitmentPreimage(NAME_ID, 2n ** 64n - 1n, LAM, PREMIUM, INPUTS_HASH);
    expect(preimage.length).toBe(160);
    expect(Array.from(preimage.slice(32, 64))).toEqual([
      ...new Array<number>(24).fill(0),
      ...beBytes(2n ** 64n - 1n, 8),
    ]);
  });
});

describe('inputsPreimage validation', () => {
  it('rejects a window that does not fit a uint32', () => {
    expect(() => inputsPreimage(2 ** 32, SessionKind.OVERNIGHT, ['S'], 1, ROWS_DIGEST)).toThrow(
      /windowSessions must fit a uint32/,
    );
    expect(() => inputsPreimage(-1, SessionKind.OVERNIGHT, ['S'], 1, ROWS_DIGEST)).toThrow(
      /windowSessions must fit a uint32/,
    );
  });

  it('rejects a row count that does not fit a uint32', () => {
    expect(() => inputsPreimage(126, SessionKind.OVERNIGHT, ['S'], 2 ** 32, ROWS_DIGEST)).toThrow(
      /rowCount must fit a uint32/,
    );
    expect(() => inputsPreimage(126, SessionKind.OVERNIGHT, ['S'], -1, ROWS_DIGEST)).toThrow(
      /rowCount must fit a uint32/,
    );
  });

  it('rejects a rowsDigest that is not 32 bytes', () => {
    // **The over-long case is an addition**, for the same reason the `inputsHash` one is: the guard is
    // `!= 32` rather than `< 32`, and the Python tests only the short side. Found by probing rather than
    // by reading — weakening the guard to `< BYTES32_BYTES` left every test green until this line
    // existed (`.recon/a8/probe.py`, `rows_digest_width_upper_bound_only`).
    expect(() => inputsPreimage(126, SessionKind.OVERNIGHT, ['S'], 1, new Uint8Array(31))).toThrow(
      /rowsDigest must be 32 bytes/,
    );
    expect(() => inputsPreimage(126, SessionKind.OVERNIGHT, ['S'], 1, new Uint8Array(33))).toThrow(
      /rowsDigest must be 32 bytes/,
    );
  });

  it('rejects more than 255 sources', () => {
    // The source count is a single byte, so 256 would encode as zero and silently lose them all.
    const sources = new Array<string>(256).fill('S');
    expect(() => inputsPreimage(126, SessionKind.OVERNIGHT, sources, 1, ROWS_DIGEST)).toThrow(
      /at most 255 source identifiers/,
    );
  });

  it('accepts exactly 255 sources', () => {
    // The bound is inclusive at 255, which is the value the byte can hold.
    const sources = new Array<string>(255).fill('S');
    const encoded = inputsPreimage(126, SessionKind.OVERNIGHT, sources, 1, ROWS_DIGEST);

    // window (4) + session-length byte (1) + session code, then the count byte.
    const countOffset = 4 + 1 + utf8(SessionKind.OVERNIGHT).length;
    expect(encoded[countOffset], 'the count byte holds 255').toBe(255);
  });

  it('rejects an over-long source identifier', () => {
    // The length prefix is a single byte, and this is the guard that keeps it honest. Without it, a
    // 256-byte identifier would encode its length as zero and the identifier would be read as the start
    // of the next field — the collision the length prefix exists to prevent, arrived at from the other
    // direction.
    expect(() =>
      inputsPreimage(126, SessionKind.OVERNIGHT, ['x'.repeat(256)], 1, ROWS_DIGEST),
    ).toThrow(/source identifier too long/);
  });

  it('measures the identifier in UTF-8 bytes, not characters', () => {
    // A multi-byte character costs more than one byte, and the prefix counts bytes. A guard that counted
    // characters would admit a 200-character identifier of 2-byte characters, which is 400 bytes and
    // overflows the prefix.
    expect(() =>
      inputsPreimage(126, SessionKind.OVERNIGHT, ['\u00e9'.repeat(200)], 1, ROWS_DIGEST),
    ).toThrow(/source identifier too long/);

    // And one that fits in bytes is accepted even though it is many characters. The Python asserts only
    // that this call succeeds; the exact length is asserted here, because the byte accounting is the
    // claim — 4 + 1 + 1 + 1 + 1 + 254 + 4 + 32.
    const encoded = inputsPreimage(
      126,
      SessionKind.OVERNIGHT,
      ['\u00e9'.repeat(127)],
      1,
      ROWS_DIGEST,
    );
    expect(encoded.length).toBe(298);
  });
});

describe('uintToBytes', () => {
  it('encodes big-endian at the width it is given', () => {
    // The shared encoder, exported rather than private because `rowsDigest` needs the same
    // encode-and-range-check and a second copy of it is a second place for the range check to be
    // dropped. Both ends of the width are asserted, since the loop's direction is the claim.
    expect([...uintToBytes(0x0102n, 4, 'value')]).toEqual([0, 0, 1, 2]);
    expect([...uintToBytes(255n, 1, 'value')], 'one byte holds 255').toEqual([255]);
    expect([...uintToBytes(0n, 4, 'value')], 'zero fills the width').toEqual([0, 0, 0, 0]);
  });

  it('refuses a negative value and one that does not fit its width', () => {
    // **Both refusals are unreachable from every caller in the port, and that is why they are tested
    // directly rather than through one.** Each call site has its own guard for the same bound and
    // fires first — `commitmentPreimage` refuses a negative parameter and a `forSession` beyond
    // uint64 before calling, so the library's own checks had executed 13,306 times without either
    // consequent being taken once.
    //
    // The guard is kept, not deleted, because that redundancy is the arrangement the project already
    // ruled on for `Amm`'s reserve check (F44/F45): a depth guard belongs in the library and not only
    // at its callers, because the caller that forgets is the one the guard is for. And it is *tested*
    // rather than assumed, because a silent truncation here produces a preimage that hashes to
    // something plausible and matches nothing — the failure this whole module exists to prevent, and
    // one that is indistinguishable from a dishonest publisher when a challenge fails.
    expect(() => uintToBytes(-1n, 8, 'value')).toThrow(/value cannot be negative/);
    expect(() => uintToBytes(256n, 1, 'value')).toThrow(/does not fit 1 bytes/);
    expect(() => uintToBytes(2n ** 64n, 8, 'value')).toThrow(/does not fit 8 bytes/);

    // The bound is exclusive and the largest value the width holds is inclusive, which is the pair a
    // one-sided test would collapse.
    expect(
      [...uintToBytes(2n ** 64n - 1n, 8, 'value')],
      'the widest value eight bytes hold',
    ).toEqual(new Array<number>(8).fill(255));
  });
});
