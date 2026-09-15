#!/usr/bin/env node
/**
 * Assert the brief's coverage requirements mechanically.
 *
 * The brief states two coverage rules for the contracts and one for the services. Until this script
 * existed, `make coverage` printed tables and left every verdict to the reader — and for the contracts
 * the reader would have got it wrong, because `forge coverage`'s own `Total` row sums *every*
 * instrumented contract including the test helpers and mocks, so it reports a number several points
 * below the source tree's own. Both figures are true and only one of them answers the brief.
 *
 * So this script answers the brief instead:
 *
 *   Solidity
 *     1. Every `src/libraries/*.sol` must be 100% on lines, statements, branches and functions. All
 *        four, not just branches: the brief names branches, but a library at 100% branches and 80%
 *        lines has branches nobody reached.
 *     2. The source tree as a whole — `src/**`, and nothing else — must be at least 95% lines.
 *
 *   TypeScript
 *     3. Each workspace must be at least 95% on **lines and branches**, asserted separately rather
 *        than pooled. The number is the brief's service bar, which was `coverage.py`'s combined
 *        measure until R5 moved the services to TypeScript and B1 deleted the Python. The shape is
 *        deliberately stronger than that combined measure, because either metric alone is satisfiable
 *        while the other is not — a workspace can reach 95% of its lines with every branch untaken.
 *     4. Every file under a `domain/` tree must be 100% on lines, statements, branches and
 *        functions. Requirement 1's analogue at the same layer: `domain/` is the boundary R5.1 draws
 *        as "no dependency that can reach the world", which is the role `contracts/src/libraries/`
 *        plays. A file with nothing to instrument counts as perfect — the convention requirement 1
 *        already applies to `forge`'s `N/A (0/0)`, and the one that makes both `ports.ts` files
 *        legal rather than exempt.
 *
 * **There is no Python rule here, and B1 is why.** Requirement 3 used to be "each service workspace
 * must be at least 95% on `coverage.py`'s own measure", measured by running that workspace's pytest
 * suite under `pytest-cov` with an interpreter this tool resolved and a caller could override with
 * `--interpreter`. The Python is deleted, so the rule is unmeasurable — and a rule that cannot be
 * measured is not asserted, it is a line of prose. The argument the old rule rested on survives
 * intact and is now requirement 4: a `Protocol` body is a declaration, and a declaration nothing
 * imports is a boundary nobody has checked. That was why `bell_settlement.domain.ports` forced the
 * services to carry the contracts' bar rather than a lower one.
 *
 * **B0 set both TypeScript bars, and measurement chose them rather than the other way round.** Before
 * it the two workspaces read 96.41/91.46 and 96.46/86.09 on lines/branches, and every shortfall
 * turned out to be a real gap rather than unreachable code: an uncalled `Wad.one`; `isZero`,
 * `isNegative` and `abs` never invoked; a `toDecimalString` never asked for a negative value; a
 * comparator never asked whether two values were equal, at both sort sites; a print whose magnitude
 * was only ever read for a negative gap; and a route layer whose fixtures carried one timestamp, one
 * insertion index and one shipping route. Sixteen tests closed all of it. Both workspaces now clear
 * 95 on both metrics, and every `domain/` file is perfect on all four.
 *
 * **Five sites are unreached by construction and carry a `v8 ignore` in the source rather than an
 * exemption here.** Three are depth guards whose callers' arithmetic proves them — the rank guard in
 * `leverage.ts` and in `families/base.ts`, and `byteOf`'s width guard, which three callers each check
 * first (F79's redundancy, deliberately kept: a depth guard belongs in the library and not only at
 * its callers). Two are the zero guards the continued-fraction algorithm specifies. Each hint states
 * its reason on the line it silences; an exemption list in this file would be remote from the code it
 * excuses and would fail open the moment the code moved.
 *
 * The *measurement* is not conditional on any of that. A vitest run that fails, or a summary that
 * never appears, or a workspace with no rows in the summary, is a hard failure whatever the
 * threshold is — otherwise "not asserted" would quietly become "not measured", and a rule that cannot
 * fail is not a rule.
 *
 * Exit status is non-zero if any rule fails, so `make check` fails with it.
 *
 * Usage:
 *     tools/check_coverage.ts                          # runs everything
 *     tools/check_coverage.ts --solidity               # contracts only
 *     tools/check_coverage.ts --typescript             # the TypeScript tree only
 *     tools/check_coverage.ts --from FILE              # parse a saved forge report
 *     tools/check_coverage.ts --typescript-from FILE   # read a saved vitest summary
 *     tools/check_coverage.ts --typescript-threshold N # override the 95 for the TypeScript tree
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONTRACTS = join(REPO_ROOT, 'contracts');

/** The bar the brief sets for `contracts/src/libraries/`, and for its TypeScript analogue. */
const LIBRARY_REQUIRED_PERCENT = 100;
/** The bar the brief sets overall, applied to `src/**` rather than to `forge`'s Total row. */
const SOURCE_REQUIRED_PERCENT = 95;
/**
 * The bar for each TypeScript workspace, on lines and branches separately.
 *
 * The brief's service bar, and the shape is B0's: 95 is the number the services already carried under
 * `coverage.py`, and splitting it into two assertions rather than one combined measure is the
 * strengthening R5 made possible when the subject became TypeScript.
 */
const TYPESCRIPT_REQUIRED_PERCENT = 95;

/**
 * The roots the TypeScript measurement is split by.
 *
 * Per workspace rather than one number for the tree, because a single figure lets a well-covered
 * workspace carry a badly-covered one — the same reason the contracts' rule is per library rather
 * than a figure for `src/` as a whole.
 */
const TYPESCRIPT_WORKSPACES: readonly string[] = ['calibrator/src', 'settlement/src'];

/**
 * The TypeScript analogue of `contracts/src/libraries/`, and the bar every file under it must meet.
 *
 * The two `domain/` trees are the layer R5.1 rules may not reach the world, which is what
 * `contracts/src/libraries/` is — so this is requirement 1 at the same place rather than a new rule
 * invented for the port. The bar is written as a reference to that constant so the equivalence is
 * literal and cannot drift.
 */
const TYPESCRIPT_DOMAIN_ROOTS: readonly string[] = [
  'calibrator/src/domain',
  'settlement/src/domain',
];
const TYPESCRIPT_DOMAIN_REQUIRED_PERCENT = LIBRARY_REQUIRED_PERCENT;

/** `| src/libraries/Amm.sol | 100.00% (31/31) | ... | ... | ... |` */
const ROW = /^\|\s*(\S+\.sol)\s*\|(.+)\|\s*$/;
/**
 * A single `100.00% (31/31)` cell, or `forge`'s `N/A (0/0)` for a column with nothing to cover.
 *
 * The `N/A` form is matched rather than skipped, and that is a fix rather than a tolerance: a row
 * with an unmatched column yields three cells instead of four and was dropped *whole*, so a `src/`
 * file with no branches was invisible to rule 1 rather than perfect on it, and its lines were
 * excluded from rule 2's total. `percent` already intended to treat `0/0` as fully covered; until
 * this pattern matched, that branch was unreachable. Found by probing the tool with a synthetic
 * report rather than by reading it.
 */
const CELL = /([\d.]+%|N\/A)\s*\((\d+)\/(\d+)\)/g;

const COLUMNS = ['lines', 'statements', 'branches', 'functions'] as const;
type Column = (typeof COLUMNS)[number];

/** A covered/total pair. Percentages are always derived, never read: averaging them is wrong. */
interface Metric {
  readonly covered: number;
  readonly total: number;
}

/**
 * One file's coverage, as four metrics.
 *
 * Shared by the two measurements rather than declared twice: `forge`'s summary rows and vitest's
 * summary rows carry the same four columns, and requirement 1 and requirement 5 ask the same
 * question of them — is this file perfect on all four.
 */
interface Coverage {
  readonly path: string;
  readonly counts: Readonly<Record<Column, Metric>>;
}

interface Options {
  readonly solidity: boolean;
  readonly typescript: boolean;
  readonly forgeReport: string | undefined;
  readonly vitestSummary: string | undefined;
  readonly typescriptThreshold: number;
}

/**
 * Unrecoverable: the measurement itself failed, so there is no verdict to give.
 *
 * Distinct from a *violation*, which is a measurement that succeeded and landed below its bar. A
 * tool that reported "1 violation" when it meant "I could not measure anything" would send a reader
 * looking for a coverage problem that does not exist.
 */
function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The last `length` characters of `text`, for quoting a failing subprocess without flooding. */
function tail(text: string, length: number): string {
  return text.slice(-length);
}

// ---------------------------------------------------------------- the contracts

/** The `hit`/`total` of one cell, or `undefined` if the cell did not parse. */
function metricOf(cell: RegExpExecArray | undefined): Metric | undefined {
  if (cell === undefined) return undefined;
  const covered = Number(cell[2]);
  const total = Number(cell[3]);
  // Not a `?? 0`: a group that failed to match must not read as a covered file. `forge` prints
  // `N/A (0/0)` for a file with nothing to cover, and that is a real pair of zeroes, not a parse
  // failure — so the two have to be told apart rather than collapsed.
  if (!Number.isFinite(covered) || !Number.isFinite(total)) return undefined;
  return { covered, total };
}

/** Every source row in a `forge coverage --report summary` table. */
function parse(report: string): Coverage[] {
  const found: Coverage[] = [];
  for (const line of report.split('\n')) {
    const row = ROW.exec(line);
    if (row === null) continue;
    const path = row[1];
    if (!path?.startsWith('src/')) continue;
    const cells = [...(row[2] ?? '').matchAll(CELL)];
    if (cells.length !== COLUMNS.length) continue;
    const lines = metricOf(cells[0]);
    const statements = metricOf(cells[1]);
    const branches = metricOf(cells[2]);
    const functions = metricOf(cells[3]);
    if (
      lines === undefined ||
      statements === undefined ||
      branches === undefined ||
      functions === undefined
    ) {
      continue;
    }
    found.push({ path, counts: { lines, statements, branches, functions } });
  }
  return found;
}

/**
 * `forge coverage`, with the fixture emitters excluded.
 *
 * **The exclusion is a correctness requirement, not a speed-up (F95).** `forge coverage` instruments
 * the contracts it measures, and instrumentation changes `Session`'s creation code. `SessionFactory`
 * deploys a session with CREATE2, so the session's initcode is part of the address preimage: a
 * different creation code is a different address, and every claim token the session deploys inherits
 * the difference. `spec/fixtures/logs.json` records those addresses, so it cannot be byte-stable
 * across two builds, and a coverage run is a second build.
 *
 * Left in, the fixture test failed here and -- worse -- rewrote the fixture with the instrumented
 * addresses before reverting, leaving a corrupted file in a clean tree. The fixture is now asserted
 * by `make check-generated`, in the canonical build, which is the only build that can reproduce it.
 *
 * The exclusion names the one file rather than its directory: a later test placed in `test/indexer/`
 * should have to make this decision deliberately, not inherit it.
 */
function runForge(): string {
  const result = spawnSync(
    'forge',
    ['coverage', '--report', 'summary', '--no-match-path', 'test/indexer/LogFixture.t.sol'],
    {
      cwd: CONTRACTS,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    console.error('forge coverage failed:');
    console.error(tail(result.stdout, 4000));
    console.error(tail(result.stderr, 4000));
    die('  the contract coverage could not be measured; is `forge` on PATH?');
  }
  return result.stdout;
}

function percent(coverage: Coverage, column: Column): number {
  const { covered, total } = coverage.counts[column];
  // A file with nothing to cover is fully covered; `forge` prints `N/A (0/0)` for these.
  return total === 0 ? 100 : (100 * covered) / total;
}

function isPerfect(coverage: Coverage): boolean {
  return COLUMNS.every((column) => percent(coverage, column) === LIBRARY_REQUIRED_PERCENT);
}

/** Requirement 1: every library is perfect on all four metrics. */
function checkLibraries(files: readonly Coverage[], report: string[]): void {
  const libraries = files.filter((file) => file.path.startsWith('src/libraries/'));
  if (libraries.length === 0) {
    report.push('  no files under src/libraries/; the rule was not applied to anything');
    return;
  }
  const sorted = [...libraries].sort((left, right) => left.path.localeCompare(right.path));
  for (const library of sorted) {
    if (isPerfect(library)) continue;
    const misses = COLUMNS.filter(
      (column) => percent(library, column) !== LIBRARY_REQUIRED_PERCENT,
    ).map((column) => {
      const { covered, total } = library.counts[column];
      return `${column} ${percent(library, column).toFixed(2)}% (${String(covered)}/${String(total)})`;
    });
    report.push(`  ${library.path}: ${misses.join(', ')}`);
  }
}

/** Requirement 2: `src/**` as a whole is at least 95% lines. */
function checkSourceTotal(files: readonly Coverage[], report: string[]): number {
  const hit = files.reduce((total, file) => total + file.counts.lines.covered, 0);
  const total = files.reduce((sum, file) => sum + file.counts.lines.total, 0);
  if (total === 0) {
    report.push('  no source lines instrumented');
    return 0;
  }
  const value = (100 * hit) / total;
  if (value < SOURCE_REQUIRED_PERCENT) {
    report.push(
      `  src/** lines ${value.toFixed(2)}% (${String(hit)}/${String(total)}); ` +
        `the brief requires ${String(SOURCE_REQUIRED_PERCENT)}%`,
    );
  }
  return value;
}

// ---------------------------------------------------------------- the typescript tree

interface WorkspaceCoverage {
  readonly workspace: string;
  /** The workspace's four metrics, summed from the per-file counts rather than averaged. */
  readonly counts: Readonly<Record<Column, Metric>>;
  /** Every file under the workspace, kept so requirement 5 can be applied per file. */
  readonly files: readonly Coverage[];
}

function add(left: Metric, right: Metric): Metric {
  return { covered: left.covered + right.covered, total: left.total + right.total };
}

function percentOf(metric: Metric): number {
  return metric.total === 0 ? 100 : (100 * metric.covered) / metric.total;
}

function readMetric(value: unknown, key: string): Metric {
  if (typeof value !== 'object' || value === null) die(`${key}: a metric is not an object`);
  const fields = value as Record<string, unknown>;
  const covered = fields['covered'];
  const total = fields['total'];
  if (typeof covered !== 'number' || typeof total !== 'number') {
    die(`${key}: a metric has no numeric 'covered'/'total'`);
  }
  return { covered, total };
}

/**
 * One file's four metrics.
 *
 * All four, where requirement 3 reads two, because requirement 4 asks for all four and the summary
 * already carries them. Reading only what the first rule needs is how the second rule ends up
 * re-parsing the same object — and how the two rules come to disagree about a file.
 */
function readFileMetrics(value: unknown, key: string): Coverage {
  if (typeof value !== 'object' || value === null) die(`${key}: not an object`);
  const fields = value as Record<string, unknown>;
  return {
    path: key,
    counts: {
      lines: readMetric(fields['lines'], key),
      statements: readMetric(fields['statements'], key),
      branches: readMetric(fields['branches'], key),
      functions: readMetric(fields['functions'], key),
    },
  };
}

/** Parse a JSON file, reporting a malformed or absent one as a measurement failure, not a crash. */
function readJson(path: string, label: string): unknown {
  if (!existsSync(path)) die(`${label}: ${path} does not exist`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return die(`${label}: ${path} is not valid JSON`);
  }
}

/**
 * Sum the vitest summary's per-file rows into one figure per workspace, keeping the rows.
 *
 * Summed from `covered`/`total` rather than averaged from the `pct` fields, which is not a detail:
 * an unweighted mean of per-file percentages lets a nine-line file outvote a four-hundred-line one,
 * and the number it produces answers no question the brief asks.
 *
 * The per-file rows are kept rather than discarded once summed, because requirement 5 is the whole
 * reason the per-workspace rule cannot be the only one: a file at 78% inside a workspace at 96% is
 * exactly what an aggregate hides.
 */
function readSummary(parsed: unknown, label: string): WorkspaceCoverage[] {
  if (typeof parsed !== 'object' || parsed === null) die(`${label}: not a JSON object`);
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([key]) => key !== 'total',
  );

  return TYPESCRIPT_WORKSPACES.map((workspace) => {
    const prefix = `${join(REPO_ROOT, workspace)}/`;
    const files = entries
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => readFileMetrics(value, key));
    if (files.length === 0) {
      die(
        `${workspace}: the summary has no rows under ${prefix}.\n` +
          'The workspace would read as 100% by absence; check `coverage.include` in vitest.config.ts.',
      );
    }
    const sum = (column: Column): Metric =>
      files.reduce((total, file) => add(total, file.counts[column]), { covered: 0, total: 0 });
    return {
      workspace,
      files,
      counts: {
        lines: sum('lines'),
        statements: sum('statements'),
        branches: sum('branches'),
        functions: sum('functions'),
      },
    };
  });
}

/**
 * Run the TypeScript suite under coverage and return the parsed summary.
 *
 * **The report goes to a scratch directory the tool owns, not to `coverage/`.** Vitest deletes its
 * reports directory before every run, and deleting a populated `coverage/` is a bulk delete of some
 * eighty files — which a shimmed or sandboxed filesystem is entitled to refuse. When it does, the
 * refusal surfaces as a non-zero vitest exit, and this tool would report *"the suite did not run to
 * completion"* about a suite that never started: a measurement failure that reads like a test
 * failure. Pointing the report at a directory this process created removes the interaction rather
 * than tolerating it, and it is the same move as `COVERAGE_FILE` above.
 *
 * `make coverage` still writes `coverage/`, for a human to read. This path is not for a human.
 */
function runVitest(): unknown {
  const cli = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(cli)) {
    die(`vitest is not installed at ${cli}; run 'npm install'`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'bell-vitest-'));
  try {
    const result = spawnSync(
      process.execPath,
      [cli, 'run', '--coverage', `--coverage.reportsDirectory=${scratch}`],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      console.error('vitest --coverage failed:');
      console.error(tail(result.stdout, 4000));
      console.error(tail(result.stderr, 4000));
      die('  the TypeScript suite did not run to completion, so there is no coverage to assert');
    }
    return readJson(join(scratch, 'coverage-summary.json'), 'vitest');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Requirement 4: every file under a `domain/` tree is perfect on all four metrics.
 *
 * **The TypeScript analogue of requirement 1, at the same layer rather than a similar one.**
 * `domain/` is the boundary R5.1 draws — no dependency that can reach the world — which is what
 * `contracts/src/libraries/` is, so both are the place where a branch nobody reached is a wrong
 * answer in the instrument rather than an untested convenience. A per-file rule is also the only
 * thing that closes the hole requirement 3 leaves open by construction: `calibrator/src/domain/
 * models.ts` read 78.57% of its branches inside a workspace that read 91.46%, and an aggregate
 * cannot see that.
 *
 * **A file with nothing to instrument is perfect**, the convention requirement 1 already applies to
 * `forge`'s `N/A (0/0)`. Both workspaces ship a `ports.ts` that is declarations only and reports
 * zero of everything; counting that as a violation would be counting a type as a branch.
 *
 * **The five sites this rule would otherwise report carry a `v8 ignore` in the source rather than an
 * exemption here** — three depth guards whose callers' arithmetic proves them, and the two zero
 * guards the continued-fraction algorithm specifies. A hint sits on the line it silences; a name in
 * a list here would be remote from the code it excuses and would fail open the moment the code
 * moved, which is the failure an allow-list exists to avoid.
 */
function checkDomainFiles(rows: readonly WorkspaceCoverage[], report: string[]): number {
  const prefixes = TYPESCRIPT_DOMAIN_ROOTS.map((root) => `${join(REPO_ROOT, root)}/`);
  const files = rows
    .flatMap((row) => row.files)
    .filter((file) => prefixes.some((prefix) => file.path.startsWith(prefix)));
  if (files.length === 0) {
    report.push('  no files under a domain/ tree; the rule was not applied to anything');
    return 0;
  }
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const misses = COLUMNS.filter(
      (column) => percent(file, column) !== TYPESCRIPT_DOMAIN_REQUIRED_PERCENT,
    ).map((column) => {
      const { covered, total } = file.counts[column];
      return `${column} ${percent(file, column).toFixed(2)}% (${String(covered)}/${String(total)})`;
    });
    if (misses.length > 0) {
      report.push(`  ${file.path.slice(REPO_ROOT.length + 1)}: ${misses.join(', ')}`);
    }
  }
  return files.length;
}

/**
 * Requirement 3: each workspace is at least `required` percent on lines **and** branches.
 *
 * Both metrics, because either alone is satisfiable while the other is not: a workspace can reach 95%
 * of its lines with every branch untaken, which is the exact shape the single combined measure the
 * services used to carry would have accepted.
 */
function checkTypeScript(
  report: string[],
  required: number,
  summaryPath: string | undefined,
): string[] {
  const rows =
    summaryPath === undefined
      ? readSummary(runVitest(), 'vitest')
      : readSummary(readJson(summaryPath, 'the saved vitest summary'), summaryPath);

  for (const row of rows) {
    for (const column of ['lines', 'branches'] as const) {
      const value = percentOf(row.counts[column]);
      if (value < required) {
        report.push(
          `  ${row.workspace}: ${column} ${value.toFixed(2)}%; requires ${String(required)}%`,
        );
      }
    }
  }

  const domainFiles = checkDomainFiles(rows, report);
  return [
    ...rows.map(
      (row) =>
        `${row.workspace} ${percentOf(row.counts.lines).toFixed(2)}% lines / ` +
        `${percentOf(row.counts.branches).toFixed(2)}% branches`,
    ),
    `${String(domainFiles)} domain/ files at 100% on all four metrics`,
  ];
}

// ---------------------------------------------------------------- the entry point

function parseArguments(argv: readonly string[]): Options {
  let solidity = false;
  let typescript = false;
  let forgeReport: string | undefined;
  let vitestSummary: string | undefined;
  let typescriptThreshold = TYPESCRIPT_REQUIRED_PERCENT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // The hole is closed *before* the switch rather than as a `case undefined`, which keeps the
    // subject a `string`: a union subject would need an explicit `undefined` clause, and that clause
    // falls through into `default` in the eyes of `no-fallthrough` whatever order they are written
    // in. Unreachable while the loop is bounded by `argv.length`, and written out anyway, because a
    // `default` that absorbed it would report an empty argument name rather than say what went wrong.
    if (argument === undefined) die('a missing argument; see the header for usage');
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) die(`${argument} needs a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case '--solidity':
        solidity = true;
        break;
      case '--typescript':
        typescript = true;
        break;
      case '--from':
        forgeReport = value();
        break;
      case '--typescript-from':
        vitestSummary = value();
        break;
      case '--typescript-threshold':
        typescriptThreshold = Number(value());
        break;
      default:
        die(`unknown argument: ${argument} (see the header for usage)`);
    }
  }

  // No `!== null` guard, because B0 removed the state it guarded: the bar is a number now, and the
  // flag exists to *move* it — for a probe that has to show the assertion firing — rather than to
  // switch it off. `--typescript-threshold 0` still means what it says.
  if (!Number.isFinite(typescriptThreshold)) die('--typescript-threshold must be a number');

  // Neither flag means both; either flag means only the one named. That was the Python tool's rule
  // and it is kept, so a caller reaching for `--solidity` alone still gets what it always got.
  const anySelected = solidity || typescript;
  return {
    solidity: anySelected ? solidity : true,
    typescript: anySelected ? typescript : true,
    forgeReport,
    vitestSummary,
    typescriptThreshold,
  };
}

function main(): number {
  const options = parseArguments(process.argv.slice(2));
  const failures: string[] = [];
  const summary: string[] = [];

  if (options.solidity) {
    const reportText =
      options.forgeReport === undefined ? runForge() : readFileSync(options.forgeReport, 'utf8');
    const files = parse(reportText);
    if (files.length === 0) {
      console.error('check_coverage: no source rows found in the coverage report.');
      console.error('The table format may have changed; the report was:');
      console.error(tail(reportText, 2000));
      return 1;
    }
    checkLibraries(files, failures);
    const sourcePercent = checkSourceTotal(files, failures);
    const libraryCount = files.filter((file) => file.path.startsWith('src/libraries/')).length;
    summary.push(
      `${String(libraryCount)} libraries at 100% on all four metrics, ` +
        `src/** at ${sourcePercent.toFixed(2)}% lines`,
    );
  }

  if (options.typescript) {
    summary.push(...checkTypeScript(failures, options.typescriptThreshold, options.vitestSummary));
  }

  if (failures.length > 0) {
    console.error(`check_coverage: ${String(failures.length)} violation(s)`);
    for (const failure of failures) console.error(failure);
    return 1;
  }

  console.log(`check_coverage: all checks passed (${summary.join('; ')})`);
  return 0;
}

process.exitCode = main();
