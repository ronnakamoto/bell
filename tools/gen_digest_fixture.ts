#!/usr/bin/env node
/**
 * Generate `spec/digest.json`, the cross-language commitment fixture.
 *
 * The fixture is the contract between the on-chain registry and the off-chain publisher. It is
 * consumed by two tests that must agree byte for byte:
 *
 *     contracts/test/differential/Digest.t.sol    (Solidity: keccak256(abi.encode(...)))
 *     calibrator/tests/unit/digest.test.ts        (TypeScript: the domain's digest layout)
 *
 * The expected digests are computed here by the TypeScript layout and hashed with a reference keccak
 * implementation. If the Solidity side disagrees, the two sides' *encodings* have diverged -- which is
 * the failure this fixture exists to catch, because a digest mismatch would make every honest
 * challenge fail.
 *
 * **The hash is `@noble/hashes`, not Node's `crypto`.** `createHash('sha3-256')` is NIST SHA3, which
 * pads differently from Ethereum's keccak256 and shares none of its output. The domain takes the hash
 * as a parameter rather than importing one, because `domain/` may not depend on a hashing library;
 * this tool is where that parameter is supplied.
 *
 * **It imports the compiled calibrator through its package specifier**, for the reason
 * `gen_moments_fixture.ts` states: `models.ts` imports `'./constants.js'`, and a bare `node` will not
 * resolve that to `constants.ts`, so the source tree is not loadable outside the build tools (F73).
 *
 * Run with `make build`, which compiles the calibrator first. Deterministic.
 *
 * Usage:
 *     node tools/gen_digest_fixture.ts            # write the fixture
 *     node tools/gen_digest_fixture.ts --check    # the same, but exit non-zero if it was stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keccak_256 } from '@noble/hashes/sha3.js';

import {
  commitmentDigest,
  commitmentPreimage,
  inputsHash,
  nameId,
} from '@bell/calibrator/domain/digest.js';
import { hexOf } from '@bell/calibrator/domain/bytes.js';
import { SessionKind, Symbol, Wad } from '@bell/calibrator/domain/models.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(REPO_ROOT, 'spec/digest.json');

const GENERATED_BANNER = 'GENERATED FILE - DO NOT EDIT BY HAND.';
const WAD = 10n ** 18n;

/** One case's inputs, before the digest is computed. */
interface Case {
  readonly label: string;
  readonly symbol: string;
  readonly session: SessionKind;
  readonly forSession: bigint;
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
  readonly windowSessions: number;
  readonly sourceIds: readonly string[];
  readonly rowCount: number;
  readonly rowsSeed: string;
}

/** One case's result, as it appears in the fixture. */
interface Entry {
  readonly label: string;
  readonly symbol: string;
  readonly nameId: string;
  readonly forSession: string;
  readonly sessionCode: string;
  readonly windowSessions: number;
  readonly sourceIds: readonly string[];
  readonly rowCount: number;
  readonly rowsSeed: string;
  readonly rowsDigest: string;
  readonly lambdaWad: string;
  readonly premiumWad: string;
  readonly inputsHash: string;
  readonly digest: string;
  readonly preimageLength: number;
}

// Cases are chosen to exercise every part of the encoding that could plausibly diverge: a multi-
// character symbol, a session kind that is not the first enum member, a leverage and premium that
// are not round numbers, a source list with more than one entry, and a `forSession` whose high bytes
// are non-zero so a truncating uint64 encoding would be caught.
const CASES: readonly Case[] = [
  {
    label: 'overnight',
    symbol: 'NVDA',
    session: SessionKind.OVERNIGHT,
    forSession: 12_345n,
    lambdaWad: 15n * WAD,
    premiumWad: 174_000_000_000_000_000n,
    windowSessions: 504,
    sourceIds: ['nasdaq-daily-ohlc'],
    rowCount: 1_965,
    rowsSeed: 'NVDA/E/504',
  },
  {
    label: 'weekend-multi-source',
    symbol: 'TSLA',
    session: SessionKind.WEEKEND,
    forSession: 4_294_967_296n, // 2^32: catches a uint32 encoding of forSession
    lambdaWad: 10n * WAD,
    premiumWad: 169_300_000_000_000_000n,
    windowSessions: 126,
    sourceIds: ['nasdaq-daily-ohlc', 'nyse-consolidated'],
    rowCount: 452,
    rowsSeed: 'TSLA/W/126',
  },
  {
    label: 'event',
    symbol: 'AAPL',
    session: SessionKind.EVENT,
    forSession: 18_446_744_073_709_551_615n, // uint64 max
    lambdaWad: 11n * WAD,
    premiumWad: 361_300_000_000_000_000n,
    windowSessions: 34,
    sourceIds: ['nasdaq-earnings-calendar'],
    rowCount: 35,
    rowsSeed: 'AAPL/C/34',
  },
];

/** A keccak256 function of the shape the domain's digest module takes. */
function referenceKeccak(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/** `"0x"` + lowercase hex, which is what the Python's `bytes.hex()` produces. */
function prefixed(bytes: Uint8Array): string {
  return `0x${hexOf(bytes)}`;
}

function render(): string {
  const entries: Entry[] = [];
  for (const item of CASES) {
    const symbol = new Symbol(item.symbol);
    const lam = new Wad(item.lambdaWad);
    const premium = new Wad(item.premiumWad);

    const symbolNameId = nameId(referenceKeccak, symbol);
    const rowsDigest = referenceKeccak(new TextEncoder().encode(item.rowsSeed));
    const inputs = inputsHash(
      referenceKeccak,
      item.windowSessions,
      item.session,
      item.sourceIds,
      item.rowCount,
      rowsDigest,
    );
    const commitment = commitmentDigest(
      referenceKeccak,
      symbolNameId,
      item.forSession,
      lam.raw,
      premium.raw,
      inputs,
    );

    entries.push({
      label: item.label,
      symbol: symbol.text,
      nameId: prefixed(symbolNameId),
      // A string, like `lambdaWad` and `premiumWad` below, and for the same reason: the value can
      // exceed the range a JSON consumer can represent exactly. `forSession` is a uint64, and the
      // boundary case is uint64 max, which is larger than JavaScript's `Number.MAX_SAFE_INTEGER`
      // (2^53 - 1). A JSON parser in a language with one numeric type reads
      // `18446744073709551615` as `18446744073709552000` -- which is exactly 2^64, so the boundary
      // case silently becomes an *out-of-range* value rather than a wrong digest. Emitting it as a
      // string is what makes the fixture losslessly readable by every consumer.
      forSession: String(item.forSession),
      sessionCode: item.session,
      windowSessions: item.windowSessions,
      sourceIds: item.sourceIds,
      rowCount: item.rowCount,
      rowsSeed: item.rowsSeed,
      rowsDigest: prefixed(rowsDigest),
      lambdaWad: String(lam.raw),
      premiumWad: String(premium.raw),
      inputsHash: prefixed(inputs),
      digest: prefixed(commitment),
      preimageLength: commitmentPreimage(
        symbolNameId,
        item.forSession,
        lam.raw,
        premium.raw,
        inputs,
      ).length,
    });
  }

  const payload = {
    _generated: GENERATED_BANNER,
    // Names the derivation, not the generator file. See F72 and `gen_moments_fixture.ts`.
    _source: 'domain/digest (keccak256 over the packed preimage)',
    _spec: 'paper Appendix B, and DESIGN_NOTES.md on the serialisation of inputsHash',
    _note:
      'The digest is keccak256 of the concatenation: nameId (bytes32), forSession ' +
      '(uint64 right-aligned in 32 bytes), lambdaWad (uint256), premiumWad (uint256), ' +
      'inputsHash (bytes32). The off-chain side builds that preimage in `domain/digest`; the ' +
      'Solidity side uses abi.encode.',
    cases: entries,
    // Carried explicitly so the Solidity consumer does not have to guess the array length:
    // `vm.parseJson` gives no way to ask a JSON array how long it is.
    caseCount: entries.length,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function main(): number {
  const content = render();
  mkdirSync(dirname(OUT), { recursive: true });

  const stale = !existsSync(OUT) || readFileSync(OUT, 'utf8') !== content;
  if (stale) writeFileSync(OUT, content);

  if (process.argv.includes('--check') && stale) {
    console.error('generated files are stale:');
    console.error(`  ${relative(REPO_ROOT, OUT)}`);
    console.error('run `make build`');
    return 1;
  }
  const cases = (JSON.parse(content) as { caseCount: number }).caseCount;
  const state = stale ? 'stale, rewritten' : 'up to date';
  console.log(`  ${relative(REPO_ROOT, OUT)}: ${state}, ${String(cases)} cases`);
  return 0;
}

process.exitCode = main();
