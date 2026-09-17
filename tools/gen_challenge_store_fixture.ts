#!/usr/bin/env node
/**
 * Generate the committed-input store and the challenge-verify cases that re-fit it.
 *
 * Slice 2 replaces the stub `refit` map with a real `calibrate` round-trip. These two fixtures are
 * the contract that round-trip has to keep:
 *
 *     spec/fixtures/committed_inputs.json   windows keyed by inputsHash
 *     spec/fixtures/challenge.json          upheld-store / digest-mismatch /
 *                                           inputs-unavailable / slashed-premium
 *
 * The window is 100 constant-gap bars so the default tail screen (`count * ALPHA >= WAD`) passes,
 * and λ / premium / `inputsHash` / `expectedDigest` are taken from `calibrate` rather than copied
 * from `digest.json`. A hand-written fixture would drift from the bars the first time the fitter
 * changed; this generator is what makes that drift a `--check` failure instead of a silent slash.
 *
 * **It imports the compiled calibrator through its package specifier**, for the reason
 * `gen_moments_fixture.ts` states: a bare `node` will not resolve `models.ts`'s `'./constants.js'`
 * to `constants.ts`, so the source tree is not loadable outside the build tools (F73).
 *
 * Run with `make build`, which compiles the calibrator first. Deterministic.
 *
 * Usage:
 *     node tools/gen_challenge_store_fixture.ts            # write both fixtures
 *     node tools/gen_challenge_store_fixture.ts --check    # the same, but exit non-zero if stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { calibrate, CalibrationRequest } from '@bell/calibrator/application/calibrate.js';
import { hexOf } from '@bell/calibrator/domain/bytes.js';
import { WAD } from '@bell/calibrator/domain/constants.js';
import { commitmentDigest, nameId } from '@bell/calibrator/domain/digest.js';
import { SEED_FAMILY, seedFamily } from '@bell/calibrator/domain/families/index.js';
import {
  DailyBar,
  DIGEST_BYTES,
  SessionKind,
  Symbol,
  Wad,
} from '@bell/calibrator/domain/models.js';
import { PREMIUM_TOLERANCE_WAD } from '@bell/settlement/domain/adjudication.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Decimal } from 'decimal.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STORE_OUT = resolve(REPO_ROOT, 'spec/fixtures/committed_inputs.json');
const CHALLENGE_OUT = resolve(REPO_ROOT, 'spec/fixtures/challenge.json');

const GENERATED_BANNER = 'GENERATED FILE - DO NOT EDIT BY HAND.';

const SYMBOL_TEXT = 'NVDA';
const SESSION = SessionKind.OVERNIGHT;
const WINDOW_SESSIONS = 100;
const SOURCE_IDS: readonly string[] = ['test-fixture'];
const FOR_SESSION = 12_345n;
const GAP = '0.01';
const BAR_START = '2020-01-06';

/** One challenge case as it appears in the fixture. Integers and hashes are strings. */
interface ChallengeEntry {
  readonly label: string;
  readonly nameId: string;
  readonly forSession: string;
  readonly lambdaWad: string;
  readonly premiumWad: string;
  readonly inputsHash: string;
  readonly expectedDigest: string;
}

/** One bar as the store file records it. WADs are strings so a JS reader cannot round them. */
interface StoreBar {
  readonly tradingDate: string;
  readonly closeWad: string;
  readonly nextOpenWad: string;
}

/** The window payload keyed by `inputsHash`. Enough to rebuild a `CalibrationRequest` and bars. */
interface StoreWindow {
  readonly symbol: string;
  readonly session: typeof SESSION;
  readonly windowSessions: number;
  readonly sourceIds: readonly string[];
  readonly familyName: string;
  readonly bars: readonly StoreBar[];
}

/** The honest fit this generator commits, before the four cases diverge. */
interface HonestFit {
  readonly nameId: Uint8Array;
  readonly forSession: bigint;
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
  readonly inputsHash: Uint8Array;
  readonly digest: Uint8Array;
  readonly window: StoreWindow;
}

/** A keccak256 function of the shape the domain's digest module takes. */
function referenceKeccak(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/** `"0x"` + lowercase hex, matching `gen_digest_fixture.ts`. */
function prefixed(bytes: Uint8Array): string {
  return `0x${hexOf(bytes)}`;
}

/** `date(2020, 1, 6) + timedelta(days=offset)`, independent of `dateOrdinal`. */
function isoDateFrom(startIso: string, offset: number): string {
  const base = Date.UTC(
    Number(startIso.slice(0, 4)),
    Number(startIso.slice(5, 7)) - 1,
    Number(startIso.slice(8, 10)),
  );
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A bar series whose gaps are exactly the ones given.
 *
 * Copied from `calibrator/tests/unit/calibrate.test.ts` `barsFromGaps`: close held at 100, next
 * open set from the gap, `Decimal` product truncated rather than rounded so a gap of `0.01` is a
 * bar with `nextOpen = 101`.
 */
function barsFromGaps(gaps: readonly string[], start = BAR_START): DailyBar[] {
  return gaps.map((gap, index) => {
    const move = BigInt(new Decimal(gap).times(WAD.toString()).trunc().toFixed(0));
    return new DailyBar(
      isoDateFrom(start, index),
      new Wad(100n * WAD),
      new Wad(100n * WAD + move * 100n),
    );
  });
}

function challengeEntry(
  label: string,
  nameIdBytes: Uint8Array,
  forSession: bigint,
  lambdaWad: bigint,
  premiumWad: bigint,
  inputs: Uint8Array,
  expectedDigest: Uint8Array,
): ChallengeEntry {
  return {
    label,
    nameId: prefixed(nameIdBytes),
    forSession: String(forSession),
    lambdaWad: String(lambdaWad),
    premiumWad: String(premiumWad),
    inputsHash: prefixed(inputs),
    expectedDigest: prefixed(expectedDigest),
  };
}

function honestFit(): HonestFit {
  const symbol = new Symbol(SYMBOL_TEXT);
  const bars = barsFromGaps(Array.from({ length: WINDOW_SESSIONS }, () => GAP));
  const request = new CalibrationRequest({
    symbol,
    session: SESSION,
    windowSessions: WINDOW_SESSIONS,
    sourceIds: SOURCE_IDS,
    familyName: SEED_FAMILY,
  });
  const result = calibrate(request, bars, seedFamily(), referenceKeccak);
  if (result.kind !== 'calibrated') {
    throw new Error(
      `expected a calibration over ${String(WINDOW_SESSIONS)} bars of gap ${GAP}, got ${result.kind}`,
    );
  }

  const { parameters } = result;
  const symbolNameId = nameId(referenceKeccak, symbol);
  const digest = commitmentDigest(
    referenceKeccak,
    symbolNameId,
    FOR_SESSION,
    parameters.lam.raw,
    parameters.premium.raw,
    parameters.inputsHash,
  );

  return {
    nameId: symbolNameId,
    forSession: FOR_SESSION,
    lambdaWad: parameters.lam.raw,
    premiumWad: parameters.premium.raw,
    inputsHash: parameters.inputsHash,
    digest,
    window: {
      symbol: symbol.text,
      session: SESSION,
      windowSessions: WINDOW_SESSIONS,
      sourceIds: SOURCE_IDS,
      familyName: SEED_FAMILY,
      bars: bars.map((bar) => ({
        tradingDate: bar.tradingDate,
        closeWad: String(bar.close.raw),
        nextOpenWad: String(bar.nextOpen.raw),
      })),
    },
  };
}

function wrongDigest(): Uint8Array {
  const bytes = new Uint8Array(DIGEST_BYTES);
  bytes[DIGEST_BYTES - 1] = 1;
  return bytes;
}

function absentInputsHash(honest: Uint8Array): Uint8Array {
  const absent = referenceKeccak(new TextEncoder().encode('inputs-unavailable'));
  if (hexOf(absent) === hexOf(honest)) {
    throw new Error('absent inputsHash collided with the stored window; pick another seed');
  }
  return absent;
}

function renderStore(fit: HonestFit): string {
  const payload = {
    _generated: GENERATED_BANNER,
    _source: 'application/calibrate over 100 constant-gap bars (gap 0.01, empirical seed family)',
    _spec: 'F2 slice 2: windows keyed by inputsHash; bars honestly round-trip through calibrate',
    _note:
      'Windows keyed by inputsHash. File adapters derive rowsDigest from the bars rather than ' +
      'storing a second digest that can drift. closeWad / nextOpenWad are WAD-scale strings.',
    windows: {
      [prefixed(fit.inputsHash)]: fit.window,
    } satisfies Record<string, StoreWindow>,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderChallenge(fit: HonestFit): string {
  const poisonedPremium = fit.premiumWad + PREMIUM_TOLERANCE_WAD + 1n;
  const slashedDigest = commitmentDigest(
    referenceKeccak,
    fit.nameId,
    fit.forSession,
    fit.lambdaWad,
    poisonedPremium,
    fit.inputsHash,
  );
  const missingInputs = absentInputsHash(fit.inputsHash);
  const unavailableDigest = commitmentDigest(
    referenceKeccak,
    fit.nameId,
    fit.forSession,
    fit.lambdaWad,
    fit.premiumWad,
    missingInputs,
  );

  const cases: readonly ChallengeEntry[] = [
    challengeEntry(
      'upheld-store',
      fit.nameId,
      fit.forSession,
      fit.lambdaWad,
      fit.premiumWad,
      fit.inputsHash,
      fit.digest,
    ),
    challengeEntry(
      'digest-mismatch',
      fit.nameId,
      fit.forSession,
      fit.lambdaWad,
      fit.premiumWad,
      fit.inputsHash,
      wrongDigest(),
    ),
    challengeEntry(
      'inputs-unavailable',
      fit.nameId,
      fit.forSession,
      fit.lambdaWad,
      fit.premiumWad,
      missingInputs,
      unavailableDigest,
    ),
    challengeEntry(
      'slashed-premium',
      fit.nameId,
      fit.forSession,
      fit.lambdaWad,
      poisonedPremium,
      fit.inputsHash,
      slashedDigest,
    ),
  ];

  const payload = {
    _generated: GENERATED_BANNER,
    _source: 'application/calibrate; commitmentDigest over the honest (or poisoned) fields',
    _spec: 'F2 slice 2: challenge cases without stub refit; store re-fit is the happy path',
    _note:
      'No stub refit field. Re-fit is store.window → calibrate. slashed-premium poisons ' +
      'commitment premiumWad by PREMIUM_TOLERANCE_WAD + 1 and recomputes expectedDigest so ' +
      'adjudicate reaches the premium check rather than digest-mismatch.',
    cases,
    caseCount: cases.length,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function writeIfStale(path: string, content: string): boolean {
  const stale = !existsSync(path) || readFileSync(path, 'utf8') !== content;
  if (stale) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return stale;
}

function main(): number {
  const fit = honestFit();
  const store = renderStore(fit);
  const challenge = renderChallenge(fit);
  const storeStale = writeIfStale(STORE_OUT, store);
  const challengeStale = writeIfStale(CHALLENGE_OUT, challenge);
  const stale = storeStale || challengeStale;

  if (process.argv.includes('--check') && stale) {
    console.error('generated files are stale:');
    if (storeStale) console.error(`  ${relative(REPO_ROOT, STORE_OUT)}`);
    if (challengeStale) console.error(`  ${relative(REPO_ROOT, CHALLENGE_OUT)}`);
    console.error('run `make build`');
    return 1;
  }

  const windows = Object.keys(
    (JSON.parse(store) as { windows: Record<string, StoreWindow> }).windows,
  ).length;
  const cases = (JSON.parse(challenge) as { caseCount: number }).caseCount;
  const storeState = storeStale ? 'stale, rewritten' : 'up to date';
  const challengeState = challengeStale ? 'stale, rewritten' : 'up to date';
  console.log(`  ${relative(REPO_ROOT, STORE_OUT)}: ${storeState}, ${String(windows)} window(s)`);
  console.log(`  ${relative(REPO_ROOT, CHALLENGE_OUT)}: ${challengeState}, ${String(cases)} cases`);
  return 0;
}

process.exitCode = main();
