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
 *   5. §8.4   No `TODO` without an issue reference.
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
 *
 * **`tools/` is out of the 400-line scope, on purpose.** The Python checker's `WORKSPACES` were the two
 * `src/` roots and never included `tools/`; `gen_constants.ts` is a row-table renderer that
 * `prettier --write` expands to 600+ lines, so inheriting the rule there would fail on a file whose
 * length is a formatting artefact (F56).
 *
 * Exit status is non-zero if any check fails, so `make check` fails with it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONTRACTS = join(REPO_ROOT, 'contracts');

/** The roots the 400-line and banned-name rules reach. */
const TYPESCRIPT_ROOTS: readonly string[] = [
  join(REPO_ROOT, 'calibrator/src'),
  join(REPO_ROOT, 'settlement/src'),
];

const MAX_SOURCE_LINES = 400;
const BANNED_MODULE_NAMES = new Set(['utils.ts', 'helpers.ts', 'common.ts']);
const REQUIRE_WITH_STRING = /\brequire\s*\(\s*[^,)]*,\s*["']/;
const TODO_PATTERN = /\bTODO\b(?!\(#\d+\))(?!\s*:?\s*#\d+)/;

/** Collects failures so one run reports every violation rather than the first. */
class Report {
  readonly failures: string[] = [];

  fail(message: string): void {
    this.failures.push(message);
  }

  summarise(): number {
    if (this.failures.length === 0) {
      console.log('check_layout: all checks passed (contracts + typescript)');
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

function typescriptSources(): string[] {
  const found: string[] = [];
  for (const root of TYPESCRIPT_ROOTS) found.push(...sources(root, '.ts'));
  return found;
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

function checkBannedModuleNames(report: Report): void {
  for (const path of [...soliditySources(), ...typescriptSources()]) {
    const name = path.split('/').at(-1) ?? '';
    if (BANNED_MODULE_NAMES.has(name)) {
      report.fail(`${relative(REPO_ROOT, path)}: name the module for what it does`);
    }
  }
}

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

/** Every library under `src/libraries/` must have a unit test of the same name. */
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

function checkTodosAreTracked(report: Report): void {
  for (const path of [...soliditySources(), ...typescriptSources()]) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (TODO_PATTERN.test(line)) {
        report.fail(
          `${relative(REPO_ROOT, path)}:${String(index + 1)}: TODO without an issue reference`,
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
  return report.summarise();
}

process.exitCode = main();
