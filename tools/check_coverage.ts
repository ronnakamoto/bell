#!/usr/bin/env node
/**
 * Assert the brief's coverage requirements mechanically.
 *
 * The brief states two for the contracts and one for the services. Until this script existed, `make
 * coverage` printed tables and left every verdict to the reader — and for the contracts the reader
 * would have got it wrong, because `forge coverage`'s own `Total` row sums *every* instrumented
 * contract including the test helpers and mocks, so it reports a number several points below the
 * source tree's own. Both figures are true and only one of them answers the brief.
 *
 * So this script answers the brief instead:
 *
 *   Solidity
 *     1. Every `src/libraries/*.sol` must be 100% on lines, statements, branches and functions. All
 *        four, not just branches: the brief names branches, but a library at 100% branches and 80%
 *        lines has branches nobody reached.
 *     2. The source tree as a whole — `src/**`, and nothing else — must be at least 95% lines.
 *
 *   Python
 *     3. Each service workspace must be at least 95% on `coverage.py`'s own measure, which counts
 *        branches. `bell_settlement.domain.ports` is the reason the two services need the same bar
 *        as the contracts rather than a lower one: a `Protocol` body is a declaration, and a
 *        declaration nothing imports is a boundary nobody has checked.
 *
 *   TypeScript
 *     4. Each workspace must be at least 95% on **lines and branches** — the analogue of
 *        `coverage.py`'s combined measure, and strictly stronger than either metric alone.
 *
 * **Rule 4 is measured but not yet asserted, and that is a schedule rather than a preference.** The
 * bar is 95 and B0 sets it: until A8 has moved the remaining Python tests across, the port is
 * incomplete and 95 would be a number chosen to be red. `--typescript-threshold 95` asserts it right
 * now, which is how the probe harness shows the assertion works rather than declaring that it does.
 *
 * The *measurement* is not conditional on any of that. A vitest run that fails, or a summary that
 * never appears, or a workspace with no rows in the summary, is a hard failure whatever the
 * threshold is — otherwise "not asserted yet" would quietly become "not measured", and a rule that
 * cannot fail is not a rule.
 *
 * Exit status is non-zero if any rule fails, so `make check` fails with it.
 *
 * Usage:
 *     tools/check_coverage.ts                          # runs everything
 *     tools/check_coverage.ts --solidity               # contracts only
 *     tools/check_coverage.ts --python                 # services only
 *     tools/check_coverage.ts --typescript             # the TypeScript tree only
 *     tools/check_coverage.ts --from FILE              # parse a saved forge report
 *     tools/check_coverage.ts --typescript-from FILE   # read a saved vitest summary
 *     tools/check_coverage.ts --interpreter PATH       # which python runs the service suites
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONTRACTS = join(REPO_ROOT, 'contracts');

/** The bar the brief sets for `contracts/src/libraries/`. */
const LIBRARY_REQUIRED_PERCENT = 100;
/** The bar the brief sets overall, applied to `src/**` rather than to `forge`'s Total row. */
const SOURCE_REQUIRED_PERCENT = 95;
/** The bar for each Python workspace, on `coverage.py`'s combined line-and-branch measure. */
const PYTHON_REQUIRED_PERCENT = 95;

/**
 * The bar for each TypeScript workspace, or `null` for "measured, not asserted".
 *
 * **`null` is a schedule, not a preference, and B0 is the one line that changes.** See the header.
 */
const TYPESCRIPT_REQUIRED_PERCENT: number | null = null;

/** Each Python workspace: its directory, and the package to measure. */
const PYTHON_WORKSPACES: readonly (readonly [string, string])[] = [
  ['calibrator', 'bell_calibrator'],
  ['settlement', 'bell_settlement'],
];

/**
 * The roots the TypeScript measurement is split by.
 *
 * Per workspace rather than one number for the tree, because a single figure lets a well-covered
 * workspace carry a badly-covered one — which is the same reason the Python side measures the two
 * services separately, and the reason the contracts' rule is per library.
 */
const TYPESCRIPT_WORKSPACES: readonly string[] = ['calibrator/src', 'settlement/src'];

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

/** One file's coverage, as four metrics. */
interface Coverage {
  readonly path: string;
  readonly counts: Readonly<Record<Column, Metric>>;
}

interface Options {
  readonly solidity: boolean;
  readonly python: boolean;
  readonly typescript: boolean;
  readonly forgeReport: string | undefined;
  readonly vitestSummary: string | undefined;
  readonly interpreter: string;
  readonly pythonThreshold: number;
  readonly typescriptThreshold: number | null;
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

function runForge(): string {
  const result = spawnSync('forge', ['coverage', '--report', 'summary'], {
    cwd: CONTRACTS,
    encoding: 'utf8',
  });
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

// ---------------------------------------------------------------- the services

interface PythonTotals {
  readonly percent: number;
  readonly covered: number;
  readonly total: number;
}

/**
 * An interpreter path resolved against the **repository root**, not the caller's directory.
 *
 * **This is not a nicety, and the failure it prevents is silent.** Each service suite runs with its
 * own workspace as the working directory, so a relative interpreter path is resolved by the *child*
 * against `calibrator/` rather than against the repository root — and `make` passes exactly
 * `.venv/bin/python`, which would become `calibrator/.venv/bin/python`. The child then fails to
 * start, which this script would report as "the suite failed" rather than as a missing interpreter.
 *
 * A bare name with no separator is left alone: that is a `PATH` lookup, and resolving it would turn
 * `python3` into a path that does not exist.
 */
function interpreterFor(name: string): string {
  if (isAbsolute(name) || !name.includes('/')) return name;
  return resolve(REPO_ROOT, name);
}

/** The interpreter the service suites run under: `PYTHON`, then a project-local `.venv`, then PATH. */
function defaultInterpreter(): string {
  const fromEnvironment = process.env['PYTHON'];
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return interpreterFor(fromEnvironment);
  }
  const local = join(REPO_ROOT, '.venv', 'bin', 'python');
  return existsSync(local) ? local : 'python3';
}

/**
 * Run one workspace's tests under `coverage.py` and return `(percent, covered, total)`.
 *
 * `coverage.py` is invoked through `pytest-cov` so the measurement is the one the project already
 * produces, rather than a second opinion that could disagree with `make coverage`.
 */
function measurePython(workspace: string, packageName: string, interpreter: string): PythonTotals {
  const scratch = mkdtempSync(join(tmpdir(), 'bell-coverage-'));
  try {
    const destination = join(scratch, 'coverage.json');
    const result = spawnSync(
      interpreter,
      [
        '-m',
        'pytest',
        'tests',
        '-q',
        `--cov=${packageName}`,
        `--cov-report=json:${destination}`,
        '--cov-report=', // no terminal table; this script is the report
      ],
      {
        cwd: join(REPO_ROOT, workspace),
        encoding: 'utf8',
        // `coverage.py` writes a data file into the working directory unless it is told otherwise,
        // which would leave a `calibrator/.coverage` behind on every `make check`. Pointing it at the
        // scratch directory keeps the run self-contained, and the `finally` above removes it with
        // everything else.
        env: { ...process.env, COVERAGE_FILE: join(scratch, '.coverage') },
      },
    );
    if (result.status !== 0) {
      console.error(`${workspace}: pytest failed`);
      console.error(tail(result.stdout, 3000));
      console.error(tail(result.stderr, 3000));
      die(
        `  the interpreter '${interpreter}' could not run ${workspace}'s suite. ` +
          "Run 'make venv', or name one that can: --interpreter /path/to/venv/bin/python",
      );
    }
    if (!existsSync(destination)) {
      die(
        `${workspace}: no coverage JSON was written. Is \`pytest-cov\` installed?\n` +
          "It is declared in the workspace's `dev` extra; run `make venv`.",
      );
    }
    return readTotals(JSON.parse(readFileSync(destination, 'utf8')), workspace);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `coverage.py`'s `totals` block, narrowed from `unknown` rather than trusted. */
function readTotals(report: unknown, workspace: string): PythonTotals {
  if (typeof report !== 'object' || report === null) {
    die(`${workspace}: the coverage JSON is not an object`);
  }
  const totals = (report as Record<string, unknown>)['totals'];
  if (typeof totals !== 'object' || totals === null) {
    die(`${workspace}: the coverage JSON has no 'totals' block`);
  }
  const fields = totals as Record<string, unknown>;
  const percentCovered = fields['percent_covered'];
  const covered = fields['covered_lines'];
  const total = fields['num_statements'];
  if (
    typeof percentCovered !== 'number' ||
    typeof covered !== 'number' ||
    typeof total !== 'number'
  ) {
    die(`${workspace}: the coverage JSON's totals are not the shape this script reads`);
  }
  return { percent: percentCovered, covered, total };
}

/** Requirement 3: each service workspace is at least `required` percent, branches included. */
function checkPython(report: string[], required: number, interpreter: string): string[] {
  const summaries: string[] = [];
  for (const [workspace, packageName] of PYTHON_WORKSPACES) {
    const totals = measurePython(workspace, packageName, interpreter);
    summaries.push(`${workspace} ${totals.percent.toFixed(2)}%`);
    if (totals.percent < required) {
      report.push(
        `  ${workspace}: ${totals.percent.toFixed(2)}% ` +
          `(${String(totals.covered)}/${String(totals.total)} statements); ` +
          // `String`, not `toFixed(0)`: a fractional override would round to a different number than
          // the one being applied, and a message that misstates its own rule is worse than none.
          `requires ${String(required)}%`,
      );
    }
  }
  return summaries;
}

// ---------------------------------------------------------------- the typescript tree

interface WorkspaceCoverage {
  readonly workspace: string;
  readonly lines: Metric;
  readonly branches: Metric;
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

function readFileMetrics(value: unknown, key: string): { lines: Metric; branches: Metric } {
  if (typeof value !== 'object' || value === null) die(`${key}: not an object`);
  const fields = value as Record<string, unknown>;
  return { lines: readMetric(fields['lines'], key), branches: readMetric(fields['branches'], key) };
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
 * Sum the vitest summary's per-file rows into one figure per workspace.
 *
 * Summed from `covered`/`total` rather than averaged from the `pct` fields, which is not a detail:
 * an unweighted mean of per-file percentages lets a nine-line file outvote a four-hundred-line one,
 * and the number it produces answers no question the brief asks.
 */
function readSummary(parsed: unknown, label: string): WorkspaceCoverage[] {
  if (typeof parsed !== 'object' || parsed === null) die(`${label}: not a JSON object`);
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([key]) => key !== 'total',
  );

  return TYPESCRIPT_WORKSPACES.map((workspace) => {
    const prefix = `${join(REPO_ROOT, workspace)}/`;
    let lines: Metric = { covered: 0, total: 0 };
    let branches: Metric = { covered: 0, total: 0 };
    let files = 0;
    for (const [key, value] of entries) {
      if (!key.startsWith(prefix)) continue;
      const metrics = readFileMetrics(value, key);
      lines = add(lines, metrics.lines);
      branches = add(branches, metrics.branches);
      files += 1;
    }
    if (files === 0) {
      die(
        `${workspace}: the summary has no rows under ${prefix}.\n` +
          'The workspace would read as 100% by absence; check `coverage.include` in vitest.config.ts.',
      );
    }
    return { workspace, lines, branches };
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
 * Requirement 4: each workspace is at least `required` percent on lines **and** branches.
 *
 * Both metrics, because either alone is satisfiable while the other is not: a workspace can reach 95%
 * of its lines with every branch untaken, which is the exact shape `coverage.py`'s combined measure
 * refuses to accept on the Python side.
 */
function checkTypeScript(
  report: string[],
  required: number | null,
  summaryPath: string | undefined,
): string[] {
  const rows =
    summaryPath === undefined
      ? readSummary(runVitest(), 'vitest')
      : readSummary(readJson(summaryPath, 'the saved vitest summary'), summaryPath);
  return rows.map((row) => {
    const lines = percentOf(row.lines);
    const branches = percentOf(row.branches);
    const summary = `${row.workspace} ${lines.toFixed(2)}% lines / ${branches.toFixed(2)}% branches`;
    if (required === null) return `${summary} (not asserted; B0 sets the bar)`;
    for (const [metric, value] of [
      ['lines', lines],
      ['branches', branches],
    ] as const) {
      if (value < required) {
        report.push(
          `  ${row.workspace}: ${metric} ${value.toFixed(2)}%; requires ${String(required)}%`,
        );
      }
    }
    return summary;
  });
}

// ---------------------------------------------------------------- the entry point

function parseArguments(argv: readonly string[]): Options {
  let solidity = false;
  let python = false;
  let typescript = false;
  let forgeReport: string | undefined;
  let vitestSummary: string | undefined;
  let interpreter: string | undefined;
  let pythonThreshold = PYTHON_REQUIRED_PERCENT;
  let typescriptThreshold: number | null = TYPESCRIPT_REQUIRED_PERCENT;

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
      case '--python':
        python = true;
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
      case '--interpreter':
        interpreter = value();
        break;
      case '--python-threshold':
        pythonThreshold = Number(value());
        break;
      case '--typescript-threshold':
        typescriptThreshold = Number(value());
        break;
      default:
        die(`unknown argument: ${argument} (see the header for usage)`);
    }
  }

  if (!Number.isFinite(pythonThreshold)) die('--python-threshold must be a number');
  if (typescriptThreshold !== null && !Number.isFinite(typescriptThreshold)) {
    die('--typescript-threshold must be a number');
  }

  // Neither flag means all three; any flag means only those named. That is the Python tool's rule,
  // kept, so a caller reaching for `--python` alone gets what it always got.
  const anySelected = solidity || python || typescript;
  return {
    solidity: anySelected ? solidity : true,
    python: anySelected ? python : true,
    typescript: anySelected ? typescript : true,
    forgeReport,
    vitestSummary,
    interpreter: interpreter === undefined ? defaultInterpreter() : interpreterFor(interpreter),
    pythonThreshold,
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

  if (options.python) {
    summary.push(...checkPython(failures, options.pythonThreshold, options.interpreter));
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
