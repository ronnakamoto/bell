#!/usr/bin/env node
/**
 * Generate every consumer of `spec/constants.yaml`.
 *
 * The build brief (§6) makes `spec/constants.yaml` the only place a domain constant is written down,
 * and requires each language side to read it at build time. A *runtime* read would put a filesystem
 * access inside `domain/`, which §5.1 forbids, so each side gets a generated module instead. The YAML
 * is the source; these three are build products.
 *
 * Emits:
 *     contracts/src/generated/Constants.sol
 *     calibrator/src/domain/constants.ts
 *     spec/fixtures/canonical.json
 *
 * **This generator accepted the port, and the Python it was checked against is gone (B1).** Until
 * Phase B it emitted a fourth file — `calibrator/src/bell_calibrator/domain/constants.py` — and
 * `make check-generated` ran this generator and `tools/gen_constants.py` in `--check` mode together,
 * so the pair asserted that two independent renderings of the same YAML produced the same bytes.
 * Neither was edited to agree with the other: an oracle adjusted to match its subject proves nothing.
 * With the Python tree deleted the differential has no second participant, so the emission is gone
 * rather than kept as a mode nobody runs.
 *
 * **The banner names this generator now.** The Solidity header used to say "Produced by
 * tools/gen_constants.py" in both renderings, because byte-identity was the test and correcting one
 * side would have destroyed the diff that proved it — a provenance banner is not a value, so it
 * waited (F55, F72). The Python's deletion is that one step: the banner now names the tool that
 * actually writes the file.
 *
 * Determinism matters more here than anywhere else in the repository: `make check-generated` re-runs
 * this and fails if a committed file differs, which is what stops a hand-edit from silently
 * diverging. Everything below is therefore pure — no clock, no locale, and no iteration over an
 * unordered set.
 *
 * Usage:
 *     node tools/gen_constants.ts            # write, reporting what changed
 *     node tools/gen_constants.ts --check    # the same, but exit non-zero if anything was stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';
import { parse } from 'yaml';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SPEC = resolve(REPO_ROOT, 'spec/constants.yaml');
const SOLIDITY_OUT = resolve(REPO_ROOT, 'contracts/src/generated/Constants.sol');
const TYPESCRIPT_OUT = resolve(REPO_ROOT, 'calibrator/src/domain/constants.ts');
const CANONICAL_OUT = resolve(REPO_ROOT, 'spec/fixtures/canonical.json');

const GENERATED_BANNER = 'GENERATED FILE - DO NOT EDIT BY HAND.';

/** 1e18, as the exact integer. `bigint` is the only type that holds it exactly. */
const WAD = 10n ** 18n;

/**
 * The decimal constructor, at 60 significant digits.
 *
 * 60 is not a preference: it is the width the committed fixtures were rendered at and the width the
 * port's differential was run at, so a narrower working precision here would silently re-render a
 * fixture the Solidity suite already asserts.
 *
 * `Decimal.clone` rather than `Decimal.set`: a clone is a separate constructor carrying its own
 * precision, so this generator's width cannot leak into a caller's arithmetic and nothing can lower
 * it. `Decimal.set` would be a mutable global.
 */
const D = Decimal.clone({ precision: 60 });
const WAD_DECIMAL = new D(WAD.toString());

/** Exact decimal string -> WAD integer. Refuses a value that is not representable. */
function wad(decimalString: string): bigint {
  const value = new D(decimalString).times(WAD_DECIMAL);
  if (!value.isInteger()) {
    throw new Error(`${decimalString} is not exactly representable at WAD scale`);
  }
  return BigInt(value.toFixed(0));
}

/** `1234567n` -> `"1_234_567"`, so a WAD literal is readable and miscount-proof. */
function group(value: bigint | number): string {
  const text = String(value);
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += '_';
    out += digits.charAt(index);
  }
  return negative ? `-${out}` : out;
}

/**
 * A YAML integer as exact text.
 *
 * Refused rather than coerced when it is not one: the value lands in a JSON fixture as a string and
 * in a TypeScript module as a `bigint` literal, and neither has a spelling for `94849.0`. Every such
 * value in the spec is an integer today, so a non-integer is a spec error rather than a rendering
 * choice, and it fails here where the message can name the file.
 */
function exactInteger(value: number): string {
  if (!Number.isInteger(value)) {
    throw new Error(`expected an integer in spec/constants.yaml, got ${String(value)}`);
  }
  return String(value);
}

// ---------------------------------------------------------------------------- emission tables
//
// Written out longhand rather than derived from YAML keys so that a rename in the YAML is a loud
// failure here rather than a silently missing constant. The tables were transcribed from
// `gen_constants.py` when this generator was its port, and that transcription is what the
// differential checked; the Python is gone (B1) and these are now the only copy.

interface Row {
  readonly solidity: string;
  readonly typescript: string;
  readonly value: bigint;
  readonly note: string;
  readonly source: string;
}

/**
 * A route row. One identifier serves both sides here — the route code is carried by the name
 * (`ROUTE_R1_...`) — so unlike `Row` there is no separate `solidity`/`typescript` pair to get out of
 * step.
 */
interface RouteRow {
  readonly name: string;
  readonly decimal: string;
  readonly note: string;
  readonly source: string;
}

/**
 * A row with a TypeScript consumer and no Solidity one.
 *
 * The single-source rule says `spec/constants.yaml` is the only place a domain constant is written
 * down; it does not say every consumer is Solidity. The event session's shape constant and
 * cross-sectional spread are read by the off-chain shrinkage rule and by nothing on chain — the
 * chain receives a leverage, never a shape — so they are emitted here and deliberately not into
 * `Constants.sol`.
 *
 * **These two read the YAML rather than transcribing it, unlike `UINT_ROWS` and `ROUTE_ROWS`.** Those
 * tables carry their values as literals, which makes them a second copy of scalars the YAML also
 * declares and nothing asserts the two agree — recorded as F90. Reproducing that pattern here would
 * have meant writing `1.596142` in two places, and the whole reason the constant is being emitted at
 * all is that a second copy can diverge silently. So this table is a function of the parsed document
 * and cannot.
 *
 * `pooled_shape_q_C` already reached `spec/fixtures/canonical.json` as `eventSession.pooledShapeQWad`
 * before this table existed, and that emission is read by nothing — neither the Solidity suite nor the
 * TypeScript one. It is left in place rather than removed here because the fixture is a published
 * object with its own readers; the constant now has a real consumer on this side.
 * `cross_sectional_tau` had no consumer at all in either language. Both were declarations awaiting
 * G1, which is this.
 */
interface TypeScriptOnlyRow {
  readonly typescript: string;
  readonly value: bigint;
  readonly note: string;
  readonly source: string;
}

function typescriptOnlyRows(document: ConstantsDocument): readonly TypeScriptOnlyRow[] {
  return [
    {
      typescript: 'EVENT_SESSION_POOLED_SHAPE_Q_WAD',
      value: wad(document.event_session.pooled_shape_q_C.value),
      note: 'q_C, the pooled shape constant: median over names of Q_0.99(|G_C|) / sigma_C',
      source: 'paper §7.10, Table 17',
    },
    {
      typescript: 'EVENT_SESSION_CROSS_SECTIONAL_TAU_WAD',
      value: wad(document.event_session.cross_sectional_tau.value),
      note: 'tau, the cross-sectional spread of the event multiplier r = sigma_C / sigma_nonC',
      source: "derived from paper Table 17 (F9, F89); unrounded, not the brief's 1.596",
    },
  ];
}

const UINT_ROWS: readonly Row[] = [
  {
    solidity: 'WAD',
    typescript: 'WAD',
    value: WAD,
    note: '1e18, the fixed-point scale',
    source: 'paper §2',
  },
  {
    solidity: 'ALPHA_WAD',
    typescript: 'ALPHA_WAD',
    value: wad('0.01'),
    note: 'saturation probability',
    source: 'paper §6.1 Eq 14',
  },
  {
    solidity: 'TIER1_HALT_BAND_WAD',
    typescript: 'TIER1_HALT_BAND_WAD',
    value: wad('0.05'),
    note: 'guard G3, Tier-1 band',
    source: 'paper §12.4',
  },
  {
    solidity: 'HALT_BAND_DEFAULT_WAD',
    typescript: 'HALT_BAND_DEFAULT_WAD',
    value: wad('0.25'),
    note: 'guard G3, legacy default',
    source: 'paper §9.4',
  },
  {
    solidity: 'COLLATERAL_DECIMALS',
    typescript: 'COLLATERAL_DECIMALS',
    value: 6n,
    note: 'USDG decimals, asserted at construction',
    source: 'paper Table 6',
  },
  {
    solidity: 'EQUITY_TOKEN_DECIMALS',
    typescript: 'EQUITY_TOKEN_DECIMALS',
    value: 18n,
    note: 'reference token decimals',
    source: 'paper check D1',
  },
  {
    solidity: 'PROTOCOL_FEE_ANNUALISED_WAD',
    typescript: 'PROTOCOL_FEE_ANNUALISED_WAD',
    value: wad('0.12'),
    note: 'eta_ann',
    source: 'paper §6.3 Eq 17',
  },
  {
    solidity: 'HOURS_PER_YEAR',
    typescript: 'HOURS_PER_YEAR',
    value: 8760n,
    note: '365 * 24',
    source: 'paper §6.3 Eq 17',
  },
  {
    solidity: 'PROTOCOL_FEE_CAP_OF_PREMIUM_WAD',
    typescript: 'PROTOCOL_FEE_CAP_OF_PREMIUM_WAD',
    value: wad('0.05'),
    note: 'eta <= 0.05 * pL',
    source: 'paper §6.3 Eq 18',
  },
  {
    solidity: 'BLENDED_FEE_TARGET_BP_WAD',
    typescript: 'BLENDED_FEE_TARGET_BP_WAD',
    value: wad('4.106'),
    note: 'blended fee, basis points',
    source: 'paper §11.2',
  },
  {
    solidity: 'RAMP_PHI_0_WAD',
    typescript: 'RAMP_PHI_0_WAD',
    value: wad('0.001'),
    note: 'trading fee at the close',
    source: 'paper §6.3 Eq 19',
  },
  {
    solidity: 'RAMP_PHI_1_WAD',
    typescript: 'RAMP_PHI_1_WAD',
    value: wad('0.01'),
    note: 'trading fee at the open',
    source: 'paper §6.3 Eq 19',
  },
  {
    solidity: 'RAMP_TIME_AVERAGE_CEILING_WAD',
    typescript: 'RAMP_TIME_AVERAGE_CEILING_WAD',
    value: wad('0.007'),
    note: 'phi_0 + (phi_1 - phi_0)*2/3',
    source: 'paper §6.3',
  },
  {
    solidity: 'TRADING_FEE_REFERENCE_WAD',
    typescript: 'TRADING_FEE_REFERENCE_WAD',
    value: wad('0.0055'),
    note: 'phi_ref, a fee not a volatility',
    source: 'paper §6.3 Eq 20',
  },
  {
    solidity: 'ROUNDING_LATTICE_WAD',
    typescript: 'ROUNDING_LATTICE_WAD',
    value: wad('0.0025'),
    note: 'cap grid; 0.25% reproduces the published lambdas',
    source: 'paper §6.1, Table 26',
  },
  {
    solidity: 'STALENESS_SESSIONS',
    typescript: 'STALENESS_SESSIONS',
    value: 12n,
    note: 'commitment usable horizon, in sessions',
    source: 'paper Table 19',
  },
  {
    solidity: 'BOND_LOCK_SESSIONS',
    typescript: 'BOND_LOCK_SESSIONS',
    value: 13n,
    note: 'rotation period plus challenge window',
    source: 'paper Table 19',
  },
  {
    solidity: 'PUBLISHER_KEYS_PER_NAME',
    typescript: 'PUBLISHER_KEYS_PER_NAME',
    value: 1n,
    note: 'one compromised key costs one name',
    source: 'paper Table 19',
  },
  {
    solidity: 'OVERNIGHT_WINDOW_SESSIONS',
    typescript: 'OVERNIGHT_WINDOW_SESSIONS',
    value: 504n,
    note: 'E, selected by forward error',
    source: 'paper §7.9 Table 15',
  },
  {
    solidity: 'OVERNIGHT_WINDOW_SESSIONS_AAPL',
    typescript: 'OVERNIGHT_WINDOW_SESSIONS_AAPL',
    value: 378n,
    note: 'E for AAPL',
    source: 'paper §7.9 Table 15',
  },
  {
    solidity: 'WEEKEND_WINDOW_SESSIONS',
    typescript: 'WEEKEND_WINDOW_SESSIONS',
    value: 126n,
    note: 'W; the longest the sample supports',
    source: 'paper §7.9 Table 15',
  },
];

// Bond amounts are in the collateral's own base units (6 decimals), per ruling R2 in DESIGN_NOTES.
// They are NOT WAD: writing them as 500_000e18 is the incoherence DESIGN_NOTES F4 records.
const BOND_ROWS: readonly Row[] = [
  {
    solidity: 'MIN_PUBLISHER_BOND',
    typescript: 'MIN_PUBLISHER_BOND',
    value: 500_000n * 10n ** 6n,
    note: '3x the largest one-session mispricing gain',
    source: 'paper Table 19',
  },
  {
    solidity: 'CHALLENGER_BOND',
    typescript: 'CHALLENGER_BOND',
    value: 50_000n * 10n ** 6n,
    note: 'upper bound on a guessing challenger',
    source: 'paper Table 19',
  },
];

const ROUTE_ROWS: readonly RouteRow[] = [
  { name: 'ROUTE_R1_COST_BP_WAD', decimal: '29.7', note: 'void at 0.50', source: 'paper Table 22' },
  {
    name: 'ROUTE_R2_COST_BP_WAD',
    decimal: '0.021',
    note: 'deferred settlement on the first valid print',
    source: 'paper Table 22',
  },
  {
    name: 'ROUTE_R4_COST_BP_WAD',
    decimal: '1.37',
    note: 'constant refund with a plausibility band',
    source: 'paper Table 22',
  },
  {
    name: 'ROUTE_R5_COST_BP_WAD',
    decimal: '1.37',
    note: 'optimistic challenge window',
    source: 'paper Table 22',
  },
];

// ---------------------------------------------------------------------------- the YAML's shape
//
// Only the parts this generator reads. Declared rather than left as `any` so that a renamed key is a
// type error here instead of an `undefined` in a generated file.

interface Cell {
  readonly name: string;
  readonly session: string;
  readonly n: number;
  readonly sigma: string;
  readonly q99: string;
  readonly lambda: number;
  readonly pL: string;
}

interface ConstantsDocument {
  readonly deployment: { readonly chain_id: number; readonly fork_block_l2: number };
  readonly gas_budget: {
    readonly truncated_moment_closed_form: { readonly baseline: number };
    readonly premium_read_from_storage: { readonly baseline: number };
    readonly registry_operations_max: { readonly commit: number };
  };
  readonly canonical_parameters: {
    readonly cells: readonly Cell[];
    readonly gaussian_reference_pL: { readonly cells: Record<string, Record<string, string>> };
  };
  readonly event_session: {
    readonly pooled_shape_q_C: { readonly value: string };
    readonly gaussian_shape_reference: { readonly value: string };
    readonly cross_sectional_tau: { readonly value: string };
  };
  readonly bond_sizing: {
    readonly rows: readonly {
      readonly name: string;
      readonly lambda: number;
      readonly dp_dlambda: string;
      readonly one_session_gain_usd: number;
    }[];
  };
}

// ---------------------------------------------------------------------------- renderers

function renderSolidity(document: ConstantsDocument): string {
  const lines: string[] = [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity 0.8.26;',
    '',
    '/// @title Constants',
    `/// @notice ${GENERATED_BANNER}`,
    '/// @dev Produced by tools/gen_constants.ts from spec/constants.yaml.',
    '///      Regenerate with `make build`. `make check` fails if this file is stale.',
    '///',
    '///      Every value carries its provenance. A constant that appears in a second source file',
    '///      is a bug waiting to diverge (build brief §6).',
    'library Constants {',
  ];

  const sections: readonly (readonly [string, readonly Row[]])[] = [
    ['protocol', UINT_ROWS],
    ['bonds, in collateral base units (USDG, 6 decimals)', BOND_ROWS],
  ];
  for (const [section, rows] of sections) {
    lines.push(
      `    // ---------------------------------------------------------------- ${section}`,
    );
    for (const row of rows) {
      lines.push(`    /// @dev ${row.note}. Source: ${row.source}.`);
      lines.push(`    uint256 internal constant ${row.solidity} = ${group(row.value)};`);
    }
    lines.push('');
  }

  lines.push(
    '    // ---------------------------------------------------------------- settlement route costs, bp',
  );
  for (const row of ROUTE_ROWS) {
    lines.push(`    /// @dev ${row.note}. Source: ${row.source}.`);
    lines.push(`    uint256 internal constant ${row.name} = ${group(wad(row.decimal))};`);
  }
  lines.push('');

  lines.push('    // ---------------------------------------------------------------- chain');
  lines.push('    /// @dev Robinhood Chain. Source: paper §1, §9.2.');
  lines.push(`    uint256 internal constant CHAIN_ID = ${group(document.deployment.chain_id)};`);
  lines.push('    /// @dev The fork block the end-to-end suite pins. Source: paper §9.2.');
  lines.push(
    `    uint256 internal constant FORK_BLOCK_L2 = ${group(document.deployment.fork_block_l2)};`,
  );
  lines.push('');

  lines.push('    // ---------------------------------------------------------------- gas budget');
  lines.push(
    "    /// @dev Baselines are the paper's measurements; budgets are the brief's §13.3 multiples.",
  );
  const gas = document.gas_budget;
  lines.push(
    `    uint256 internal constant GAS_TRUNCATED_MOMENT_BASELINE = ${group(gas.truncated_moment_closed_form.baseline)};`,
  );
  lines.push(
    `    uint256 internal constant GAS_PREMIUM_STORAGE_BASELINE = ${group(gas.premium_read_from_storage.baseline)};`,
  );
  lines.push(
    `    uint256 internal constant GAS_REGISTRY_OPERATION_MAX = ${group(gas.registry_operations_max.commit)};`,
  );
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * The TypeScript module.
 *
 * **Every value is a `bigint`.** `bigint` is arbitrary precision and a `number` is not: a `number`
 * would be an IEEE-754 double, and "a monetary value silently became one" is the exact failure the
 * WAD type exists to prevent — so the module is uniform rather than splitting counts from amounts,
 * and a caller that needs a count converts explicitly at that one point, where the conversion is
 * visible and the value is bounded by construction.
 */
function renderTypeScript(document: ConstantsDocument): string {
  const lines: string[] = [
    '/**',
    ` * ${GENERATED_BANNER}`,
    ' *',
    ' * Produced by tools/gen_constants.ts from spec/constants.yaml.',
    ' * Regenerate with `make build`. `make check` fails if this file is stale.',
    ' *',
    ' * Every value is a `bigint`. `bigint` is arbitrary precision and a `number` is not: a `number`',
    ' * here would be an IEEE-754 double, and "a monetary value silently became one" is the failure the',
    ' * `Wad` type exists to prevent. A caller that needs a count — a loop bound, a slice length —',
    ' * converts explicitly at that one point, where the conversion is visible.',
    ' */',
    '',
  ];

  const sections: readonly (readonly [string, readonly Row[]])[] = [
    ['', UINT_ROWS],
    ['Bonds, in collateral base units (USDG, 6 decimals). Ruling R2 in DESIGN_NOTES.', BOND_ROWS],
  ];
  for (const [section, rows] of sections) {
    if (section !== '') lines.push(`// ${section}`, '');
    for (const row of rows) {
      lines.push(`/** ${row.note}. Source: ${row.source}. */`);
      lines.push(`export const ${row.typescript} = ${group(row.value)}n;`);
      lines.push('');
    }
  }

  lines.push('// Event session (C), read by the off-chain shrinkage rule only.', '');
  for (const row of typescriptOnlyRows(document)) {
    lines.push(`/** ${row.note}. Source: ${row.source}. */`);
    lines.push(`export const ${row.typescript} = ${group(row.value)}n;`);
    lines.push('');
  }

  lines.push('// Settlement route costs, in basis points at WAD scale.', '');
  for (const row of ROUTE_ROWS) {
    lines.push(`/** ${row.note}. Source: ${row.source}. */`);
    lines.push(`export const ${row.name} = ${group(wad(row.decimal))}n;`);
    lines.push('');
  }

  lines.push('// Chain', '');
  lines.push('/** Robinhood Chain. Source: paper §1, §9.2. */');
  lines.push(`export const CHAIN_ID = ${group(document.deployment.chain_id)}n;`);
  lines.push('');
  lines.push('/** The fork block the end-to-end suite pins. Source: paper §9.2. */');
  lines.push(`export const FORK_BLOCK_L2 = ${group(document.deployment.fork_block_l2)}n;`);
  return `${lines.join('\n')}\n`;
}

/**
 * The golden fixture, in a form Solidity can read (it cannot parse YAML).
 *
 * Values are emitted as WAD integers rather than decimal strings. Solidity has no decimal parser, and
 * hand-rolling one in a test would put a second implementation of the fixture's meaning into the
 * repository. `capWad` is derived as `1e18 / lambda` rather than taken from the YAML's rounded `cap`
 * field, so the fixture carries the exact saturation point.
 *
 * **Every integer is emitted as a JSON string**, uniformly, for the reason F52 records: a JSON number
 * is exact only where a double is. This fixture was the third to be found with the defect, and unlike
 * the other two it was genuinely lossy — `capWad` for the reciprocal of 15, 11 and 22
 * (`66666666666666666`, `90909090909090909`, `45454545454545454`) round to `...664`, `...912` and
 * `...456` in a JavaScript reader, because those values have no trailing zeros to carry factors of
 * two. `tools/check_fixtures.ts` is the guard that now makes a fourth occurrence impossible.
 *
 * `vm.parseJsonUint` accepts a string-encoded number, so the Solidity readers are unaffected.
 */
function renderCanonical(document: ConstantsDocument): string {
  const canonical = document.canonical_parameters;

  const cells = canonical.cells.map((cell) => ({
    name: cell.name,
    session: cell.session,
    n: exactInteger(cell.n),
    sigmaWad: String(wad(cell.sigma)),
    q99Wad: String(wad(cell.q99)),
    lambdaWad: String(wad(exactInteger(cell.lambda))),
    capWad: String(WAD / BigInt(cell.lambda)),
    pLWad: String(wad(cell.pL)),
  }));

  const gaussian: { name: string; session: string; pLWad: string }[] = [];
  for (const [name, bySession] of Object.entries(canonical.gaussian_reference_pL.cells)) {
    for (const [session, value] of Object.entries(bySession)) {
      gaussian.push({ name, session, pLWad: String(wad(value)) });
    }
  }

  const payload = {
    _generated: GENERATED_BANNER,
    _source: 'spec/constants.yaml (paper §7.8 Table 13, §7.11 Table 18)',
    _note:
      'pLWad is the EMPIRICAL truncated mean, the seed model. gaussian_pL is the differential ' +
      "reference computed from sigmaWad and lambdaWad via the paper's Eq (12): " +
      'pL = lambda * E[min(|G|, 1/lambda)]. Every integer is a STRING: a JSON number is exact ' +
      "only where a double is, and three of this repository's fixtures were found carrying " +
      'values that a JavaScript reader silently rounds. See DESIGN_NOTES.md F52.',
    cells,
    gaussian_pL: gaussian,
    // Counts, because a Solidity reader can no longer decode the arrays wholesale. `abi.decode`
    // over `vm.parseJson` required the JSON values to be numbers; with every integer now a string
    // the reader walks the array by index and needs to know where it ends. The other two fixtures
    // carry `pointCount` and `caseCount` for the same reason.
    cellCount: cells.length,
    gaussianCount: gaussian.length,
    event_session: {
      pooledShapeQWad: String(wad(document.event_session.pooled_shape_q_C.value)),
      gaussianShapeReferenceWad: String(wad(document.event_session.gaussian_shape_reference.value)),
    },
    bond_sizing: document.bond_sizing.rows.map((row) => ({
      name: row.name,
      lambdaWad: String(wad(exactInteger(row.lambda))),
      dpDlambdaWad: String(wad(row.dp_dlambda)),
      notionalUsd: exactInteger(row.one_session_gain_usd),
      oneSessionGainUsd: exactInteger(row.one_session_gain_usd),
    })),
  };
  // The provenance strings carry section marks and the fixtures are read by humans as well as by two
  // test suites, so the JSON is emitted with them raw rather than `\u`-escaped. `JSON.stringify` does
  // that by default; the comment is here because the Python writer this replaced had to ask for it.
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function main(): number {
  const document = parse(readFileSync(SPEC, 'utf8')) as ConstantsDocument;
  const outputs = new Map<string, string>([
    [SOLIDITY_OUT, renderSolidity(document)],
    [TYPESCRIPT_OUT, renderTypeScript(document)],
    [CANONICAL_OUT, renderCanonical(document)],
  ]);

  const stale: string[] = [];
  for (const [path, content] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && readFileSync(path, 'utf8') === content) continue;
    stale.push(path);
    writeFileSync(path, content);
  }

  if (process.argv.includes('--check') && stale.length > 0) {
    console.error('generated files are stale:');
    for (const path of stale) console.error(`  ${relative(REPO_ROOT, path)}`);
    console.error('run `make build`');
    return 1;
  }
  for (const path of outputs.keys()) {
    const state = stale.includes(path) ? 'stale, rewritten' : 'up to date';
    console.log(`  ${relative(REPO_ROOT, path)}: ${state}`);
  }
  return 0;
}

process.exitCode = main();
