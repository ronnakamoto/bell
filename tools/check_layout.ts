#!/usr/bin/env node
/**
 * Assert the structural rules of the build brief mechanically, for the contracts and the TypeScript
 * tree.
 *
 * The brief's §5.3 says it plainly: *"A stated rule that is not checked is a preference, not an
 * architecture."* Everything below is a rule the brief states and that a reader could otherwise only
 * verify by reading the whole repository.
 *
 * Checks:
 *
 *   1. §6     No `utils.ts`, `helpers.ts`, `common.ts`. These are where unrelated code hides.
 *   2. §8.1   No source file exceeds 400 lines.
 *   3. §6     Tests mirror source: every `src/libraries/X.sol` has `test/unit/X.t.sol`.
 *   4. §7.2   No `require` with a string in Solidity. Custom errors only.
 *   5. §8.4   No untracked task marker; the tracked form is `TODO(#123)`.
 *   6. —      `dist/` mirrors `src/`: every compiled file has a source (F82).
 *   7. —      A `v8 ignore` hint only under a `domain/` tree (F80).
 *
 * **Three scopes, chosen separately, and C0 is why they are written down.** The Python checker this
 * replaced declared one `WORKSPACES` tuple and read every rule through it, which made three different
 * questions look like one question. They are not:
 *
 * - **`src/` only, for §8.1's 400-line rule.** The brief says *source*; the Python's `WORKSPACES` were
 *   the two `src/` roots; and extending it fails on measurement rather than on principle. Of the six
 *   files under `tools/`, two exceed 400 — `check_coverage.ts` at 604 of which 205 are comment, and
 *   `gen_constants.ts` at 590 of which 445 are code that `prettier --write` expands out of a row table
 *   (F56). A rule whose remedy is deleting the reasoning that makes an audit tool auditable, or
 *   splitting a table renderer, is worse than the length it objects to. The test trees are excluded
 *   for the same reason §8.1 gives: `settlement/tests/unit/routes.test.ts` is 523 lines of fixtures,
 *   and a fixture is not source.
 * - **every TypeScript file the repository owns** — both `src/` trees, both `tests/` trees and
 *   `tools/` — for the banned-name rule and the marker rule. Neither is about source: a
 *   `tests/unit/helpers.ts` hides unrelated code exactly as `src/helpers.ts` does, and an untracked
 *   marker is untracked wherever it was left. Both cost nothing today, which is when a widening is
 *   free; this file is itself subject to the marker rule it states, which is why the token below is
 *   written in the accepted form rather than bare.
 * - **`domain/`** for the coverage hint, and nothing else. See rule 7.
 *
 * **Rule 6 is rule 3 one layer down, and it exists because a build product is a resolution target
 * here.** `calibrator/package.json` maps `./domain/*.js` onto `./dist/domain/*.js`, so `dist/` is what
 * `tsc` and node resolve every `@bell/calibrator/domain/*.js` specifier to. `tsc -b` writes the outputs
 * of the files it is handed and never removes the output of a file that has been deleted or renamed,
 * so `dist/` can hold a module `src/` does not — and that module stays importable. Found as four
 * `__probe.*` files in `settlement/dist/domain/` whose source was never committed and which had
 * survived every build since.
 *
 * The rule is **one-directional on purpose**: an orphan is caught by nothing, while a *missing* output
 * is caught by `tsc` at the next build and by every test that imports it. It is a check rather than a
 * prune for two measured reasons: `tsc -b --clean` does not remove an orphan — it removes only what its
 * build info records having emitted — and a bulk `rm -rf dist` in the build discards `tsc -b`'s
 * incrementality while, at 320 targets, being refused outright by a guarded run. A check that names the
 * file is what the other gates do; `make clean` is the remedy.
 *
 * **Rule 7 is the allow-list the coverage hints made necessary, and it is the same shape as §7.4's.**
 * `check_coverage.ts` requires every file under a `domain/` tree to be perfect on lines, statements,
 * branches and functions, and five sites are unreachable by construction — three depth guards whose
 * callers' arithmetic proves them, and the two zero guards the continued-fraction algorithm specifies.
 * Each carries a `v8 ignore` in the source, so a hint is now the one place a coverage shortfall can be
 * silenced by hand, and nothing bounded where a hint may appear. The bound is an allow-list — permitted
 * under `domain/`, refused everywhere else — rather than a list of the files that may carry one,
 * because a deny-list fails open on the spelling nobody thought of, and here the spelling that would
 * have failed open is a hint in `application/` silencing the per-workspace bar instead.
 *
 * The pattern matches the *directive* rather than the words, because prose that names the mechanism is
 * not a hint: `check_coverage.ts`'s header discusses it twice and neither mention is one.
 *
 * **Two things are deliberately not here, and both are stated rather than omitted.**
 *
 * - **Python `domain/` import purity is gone with the Python.** `check_layout.py` walked Python's
 *   `ast` to prove `domain/` imported nothing but the standard library, and TypeScript cannot parse
 *   Python, so it was never ported. B1 deleted the tree it guarded and the check died with it. Nothing
 *   replaces it and nothing needs to: there is no Python left to be impure.
 * - **TypeScript `domain/` import purity is `dependency-cruiser`'s** (`npm run architecture`). It
 *   enforces the allow-list §7.4 narrows to, with an allow-list rather than a deny-list of
 *   categories, which is strictly the stronger check. Reproducing it here would be a second source of
 *   truth for one rule.
 * - **A TypeScript analogue of rule 3 is not here either, and the measurement is why.** Rule 3 demands
 *   `test/unit/X.t.sol` for every `src/libraries/X.sol`, because a library with no test is invisible to
 *   a reader. `check_coverage.ts` already asks the stronger question of the same layer: every file
 *   under `domain/` is perfect on all four metrics, so a `domain/` file with no test cannot exist. The
 *   three TypeScript files a same-stem rule would demand and nothing else — `dates.test.ts`,
 *   `families/base.test.ts`, `routes/base.test.ts` — are each already at 100% through another suite,
 *   so the rule would create files that add no coverage. `application/` and `adapters/` are held by the
 *   per-workspace bar. Recorded in F86 rather than implemented.
 *
 * Exit status is non-zero if any check fails, so `make check` fails with it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONTRACTS = join(REPO_ROOT, 'contracts');

/** The two workspaces' sources: the roots §8.1's length rule and rule 6 both read. */
const WORKSPACE_SOURCE_ROOTS: readonly string[] = [
  join(REPO_ROOT, 'calibrator/src'),
  join(REPO_ROOT, 'settlement/src'),
];

/** The two workspaces' test trees. Subject to the naming and marker rules, and to nothing else. */
const WORKSPACE_TEST_ROOTS: readonly string[] = [
  join(REPO_ROOT, 'calibrator/tests'),
  join(REPO_ROOT, 'settlement/tests'),
];

/** The build scripts: type-checked by `tools/tsconfig.json` and linted, but not `src/`. */
const TOOLS_ROOT = join(REPO_ROOT, 'tools');

/** Every root the banned-name and marker rules read. */
const TYPESCRIPT_MODULE_ROOTS: readonly string[] = [
  ...WORKSPACE_SOURCE_ROOTS,
  ...WORKSPACE_TEST_ROOTS,
  TOOLS_ROOT,
];

/**
 * The trees a coverage hint is permitted in.
 *
 * These are the trees `check_coverage.ts` applies its per-file 100% rule to, and that rule is the only
 * thing that makes a hint necessary: it leaves no room for a site that is unreachable by construction,
 * where the per-workspace bar leaves five percent of slack for exactly one.
 */
const DOMAIN_ROOTS: readonly string[] = [
  join(REPO_ROOT, 'calibrator/src/domain'),
  join(REPO_ROOT, 'settlement/src/domain'),
];

const MAX_SOURCE_LINES = 400;
const BANNED_MODULE_NAMES = new Set(['utils.ts', 'helpers.ts', 'common.ts']);
const REQUIRE_WITH_STRING = /\brequire\s*\(\s*[^,)]*,\s*["']/;
const TODO_PATTERN = /\bTODO\b(?!\(#\d+\))(?!\s*:?\s*#\d+)/;
/**
 * A coverage directive, in the syntax `v8` understands rather than in the words.
 *
 * `next`, `start` and `stop` are the three forms; prose that names the mechanism without one of them
 * is a sentence about hints rather than a hint, and reporting it would make this rule a spelling
 * checker for its own documentation.
 */
const COVERAGE_HINT = /v8 ignore\s+(?:next|start|stop)/;

/** Collects failures so one run reports every violation rather than the first. */
class Report {
  readonly failures: string[] = [];

  fail(message: string): void {
    this.failures.push(message);
  }

  summarise(): number {
    if (this.failures.length === 0) {
      console.log('check_layout: all checks passed (contracts + typescript + dist + hints)');
      return 0;
    }
    console.error(`check_layout: ${String(this.failures.length)} violation(s)`);
    for (const failure of this.failures) console.error(`  ${failure}`);
    return 1;
  }
}

/** Every file under `directory` whose name ends with `suffix`, sorted, recursively. */
function sources(directory: string, suffix: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries.sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sources(full, suffix));
    } else if (entry.endsWith(suffix)) {
      found.push(full);
    }
  }
  return found;
}

function soliditySources(): string[] {
  return sources(join(CONTRACTS, 'src'), '.sol');
}

/** The workspaces' sources: what §8.1 and rule 6 read. */
function typescriptSources(): string[] {
  const found: string[] = [];
  for (const root of WORKSPACE_SOURCE_ROOTS) found.push(...sources(root, '.ts'));
  return found;
}

/** Every TypeScript file the repository owns: what the naming and marker rules read. */
function typescriptModules(): string[] {
  const found: string[] = [];
  for (const root of TYPESCRIPT_MODULE_ROOTS) found.push(...sources(root, '.ts'));
  return found;
}

/** Whether `path` is under a tree rule 7 permits a hint in. */
function inDomainTree(path: string): boolean {
  return DOMAIN_ROOTS.some((root) => path.startsWith(`${root}/`));
}

/**
 * Logical line count, matching `wc -l`.
 *
 * `split('\n')` on a file that ends with a newline yields a trailing empty element that is not a
 * line; dropping it is what makes this agree with `wc -l` rather than reporting every file as one
 * line longer. `wc -l` is the definition rather than "lines of code" because it is the count a reader
 * can reproduce, and it is the count the Python checker this replaced used.
 */
function lineCount(text: string): number {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

/** Rule 1: no module is named for the drawer everything falls into. */
function checkBannedModuleNames(report: Report): void {
  for (const path of [...soliditySources(), ...typescriptModules()]) {
    const name = path.split('/').at(-1) ?? '';
    if (BANNED_MODULE_NAMES.has(name)) {
      report.fail(`${relative(REPO_ROOT, path)}: name the module for what it does`);
    }
  }
}

/** Rule 2: §8.1's 400-line limit, over the contracts' and the workspaces' sources. */
function checkFileLengths(report: Report): void {
  for (const path of [...soliditySources(), ...typescriptSources()]) {
    const lines = lineCount(readFileSync(path, 'utf8'));
    if (lines > MAX_SOURCE_LINES) {
      report.fail(
        `${relative(REPO_ROOT, path)}: ${String(lines)} lines exceeds the ` +
          `${String(MAX_SOURCE_LINES)} limit`,
      );
    }
  }
}

/** Rule 3: every library under `src/libraries/` must have a unit test of the same name. */
function checkTestsMirrorSource(report: Report): void {
  for (const library of sources(join(CONTRACTS, 'src', 'libraries'), '.sol')) {
    const stem = (library.split('/').at(-1) ?? '').replace(/\.sol$/, '');
    const expected = join(CONTRACTS, 'test', 'unit', `${stem}.t.sol`);
    let exists = true;
    try {
      statSync(expected);
    } catch {
      exists = false;
    }
    if (!exists) {
      report.fail(
        `${relative(REPO_ROOT, library)} has no test at ${relative(REPO_ROOT, expected)}; ` +
          'a reader must be able to find a test from a filename',
      );
    }
  }
}

/** Rule 4: no `require` with a string, in Solidity. Custom errors only. */
function checkNoRequireStrings(report: Report): void {
  for (const path of soliditySources()) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (REQUIRE_WITH_STRING.test(line)) {
        report.fail(
          `${relative(REPO_ROOT, path)}:${String(index + 1)}: require with a string; ` +
            'custom errors only',
        );
      }
    });
  }
}

/** Rule 5: §8.4's marker rule. The message shows the accepted form, which is also its own fix. */
function checkTodosAreTracked(report: Report): void {
  for (const path of [...soliditySources(), ...typescriptModules()]) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (TODO_PATTERN.test(line)) {
        report.fail(
          `${relative(REPO_ROOT, path)}:${String(index + 1)}: an untracked task marker; ` +
            'the tracked form is TODO(#123)',
        );
      }
    });
  }
}

/**
 * Rule 6: every file under `dist/` must be the output of a file under `src/`.
 *
 * The suffix is stripped rather than matched exactly, because one source produces four outputs —
 * `moments.ts` yields `moments.js`, `moments.js.map`, `moments.d.ts` and `moments.d.ts.map` — and all
 * four are orphans together when the source goes. Dotfiles are skipped, which is `dist/.tsbuildinfo`,
 * and `tsc`'s own bookkeeping rather than an output.
 */
function checkDistMirrorsSource(report: Report): void {
  for (const sourceRoot of WORKSPACE_SOURCE_ROOTS) {
    const distRoot = join(dirname(sourceRoot), 'dist');
    for (const output of sources(distRoot, '')) {
      const name = output.split('/').at(-1) ?? '';
      const stem = name.split('.')[0] ?? '';
      if (name.startsWith('.') || stem === '') continue;
      const directory = dirname(relative(distRoot, output));
      const expected = join(sourceRoot, directory === '.' ? '' : directory, `${stem}.ts`);
      let exists = true;
      try {
        statSync(expected);
      } catch {
        exists = false;
      }
      if (!exists) {
        report.fail(
          `${relative(REPO_ROOT, output)} has no source; \`tsc -b\` does not remove the output of ` +
            "a deleted file, so it survives every build and stays reachable through the package's " +
            '`exports` map. Run `make clean`.',
        );
      }
    }
  }
}

/**
 * Rule 7: a coverage hint is permitted under `domain/`, and refused everywhere else.
 *
 * Every file the repository owns is read rather than only the instrumented ones, because a hint in a
 * file that is not instrumented is the same defect with a quieter symptom: it silences nothing while
 * reading as an exemption somebody took.
 */
function checkCoverageHintsAreBounded(report: Report): void {
  for (const path of typescriptModules()) {
    if (inDomainTree(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (COVERAGE_HINT.test(line)) {
        report.fail(
          `${relative(REPO_ROOT, path)}:${String(index + 1)}: a coverage hint outside \`domain/\`; ` +
            'a hint is how a shortfall is silenced by hand, and only the per-file rule under ' +
            '`domain/` needs one. Remove it, or write the test that reaches the site.',
        );
      }
    });
  }
}

function main(): number {
  const report = new Report();
  checkBannedModuleNames(report);
  checkFileLengths(report);
  checkTestsMirrorSource(report);
  checkNoRequireStrings(report);
  checkTodosAreTracked(report);
  checkDistMirrorsSource(report);
  checkCoverageHintsAreBounded(report);
  return report.summarise();
}

process.exitCode = main();
