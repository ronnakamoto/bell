#!/usr/bin/env node
/**
 * Assert that every fixture under `spec/` is losslessly readable by a JavaScript consumer.
 *
 * Three JSON fixtures in this repository were written with WAD-scale integers as bare numbers, and
 * each was found independently: `digest.json` (one field, F52), `fixtures/moments.json` (seven fields
 * across all 112 points, F52 extended), and `fixtures/canonical.json` (61 values). Three independent
 * occurrences is not three mistakes — it is a missing guard. This is that guard.
 *
 * **It used to walk `.json` only, which is F92.** `spec/constants.yaml` is the single source for
 * every domain constant, and it was outside the guard that exists because three fixtures carried
 * WAD-scale integers as bare numbers. YAML has the same hazard and a worse one: a parser that uses
 * JavaScript numbers rounds *before* any later check (`wad()`, `assertWadScale`) sees the value, so
 * the rounded figure is exactly representable at WAD scale and the refusal that would have caught it
 * never fires. The value is lost one layer earlier than the layer that checks it, which is the shape
 * every member of the F52 family has had.
 *
 * **The check is exact representability, not a threshold.** A double can hold some integers above
 * 2^53 exactly: anything of the form `k * 10^n` with a small `k` carries enough factors of two, and
 * every one of `canonical.json`'s 61 large values happens to survive. So a rule that failed on
 * "above `MAX_SAFE_INTEGER`" would fail on a file that is currently correct and pass on nothing that
 * matters. The rule that matters is "does this literal survive a round trip".
 *
 * JSON exposes the source text through `JSON.parse`'s reviver. YAML has no such reviver, so the
 * check reads the scalar's range in the concrete syntax tree — the same comparison, against the
 * bytes that were written rather than against the number the parser produced.
 *
 * A value that is merely unsafe-by-form but exactly representable passes, and is reported as a
 * warning: it is not broken today, and it becomes broken the moment somebody edits a digit. The one
 * live instance is `meta.wad`.
 *
 * Usage:
 *     node tools/check_fixtures.ts            # check, exit non-zero on any loss
 *     node tools/check_fixtures.ts --verbose  # also list the at-risk-but-exact literals
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPair, isScalar, parseDocument, visit } from 'yaml';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SPEC = join(REPO_ROOT, 'spec');

/** An integer literal that did not survive a round trip through a double. */
interface Loss {
  readonly key: string;
  readonly source: string;
  readonly parsed: string;
}

/** An integer literal above 2^53 that happens to be exactly representable anyway. */
interface AtRisk {
  readonly key: string;
  readonly source: string;
}

interface Inspection {
  readonly losses: Loss[];
  readonly atRisk: AtRisk[];
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BARE_INTEGER = /^-?\d+$/;
const FIXTURE_NAME = /\.(json|ya?ml)$/;

/** Classify one integer literal against the number a JavaScript reader produced from it. */
function classify(
  key: string,
  source: string,
  parsed: number,
  losses: Loss[],
  atRisk: AtRisk[],
): void {
  const exact = BigInt(source);
  const roundTripped = BigInt(parsed);
  if (exact !== roundTripped) {
    losses.push({ key, source, parsed: roundTripped.toString() });
  } else if (exact > MAX_SAFE || exact < -MAX_SAFE) {
    atRisk.push({ key, source });
  }
}

/** Every `.json` / `.yaml` / `.yml` file under `spec/`, recursively. */
function specFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...specFiles(full));
    } else if (FIXTURE_NAME.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Walk a JSON document and report every integer literal that does not round-trip.
 *
 * The reviver's third argument carries the original source text of the value being revived, which is
 * the only way to see what was written after `JSON.parse` has already rounded it.
 */
function inspectJson(text: string): Inspection {
  const losses: Loss[] = [];
  const atRisk: AtRisk[] = [];

  // The reviver is called bottom-up, so a full JSON pointer would have to be reconstructed from a
  // stack the reviver never unwinds. The immediate key is enough to locate a finding: these files are
  // shallow, and every field name in them is distinct.
  JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && Number.isInteger(value)) {
      const source = context?.source;
      // A literal written with a fraction or an exponent is a float by intent and is not our
      // subject; only a bare integer literal is.
      if (typeof source === 'string' && BARE_INTEGER.test(source)) {
        classify(key, source, value, losses, atRisk);
      }
    }
    return value;
  });

  return { losses, atRisk };
}

/**
 * The nearest mapping key that owns this node, or a fallback when the integer is a sequence item.
 *
 * YAML has no JSON pointer, and several fields are named `value`. The immediate key is still enough
 * to locate a finding in this file: `wad` occurs once, and a loss names the source text beside it.
 */
function yamlKey(path: readonly unknown[]): string {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const parent = path[index];
    if (isPair(parent) && isScalar(parent.key)) {
      return String(parent.key.value);
    }
  }
  return '(yaml)';
}

/**
 * Walk a YAML document the same way, against the bytes the CST still holds.
 *
 * Quoted scalars are strings by intent and are skipped: quoting is the YAML form of the JSON-string
 * encoding the rest of `spec/` already uses. Unquoted floats (`2.0`, `1e18`) are skipped by the same
 * `^-?\d+$` filter the JSON path uses. Map *keys* that happen to be integers are not values a
 * consumer computes with and are skipped.
 */
function inspectYaml(text: string): Inspection {
  const losses: Loss[] = [];
  const atRisk: AtRisk[] = [];
  const document = parseDocument(text);

  visit(document, (_key, node, path) => {
    if (!isScalar(node) || node.type !== 'PLAIN') return undefined;
    if (typeof node.value !== 'number' || !Number.isInteger(node.value)) return undefined;
    const parent = path[path.length - 1];
    if (isPair(parent) && parent.key === node) return undefined;
    const range = node.range;
    if (range === undefined || range === null) return undefined;
    const source = text.slice(range[0], range[1]).trim();
    if (!BARE_INTEGER.test(source)) return undefined;
    classify(yamlKey(path), source, node.value, losses, atRisk);
    return undefined;
  });

  return { losses, atRisk };
}

function inspect(path: string, text: string): Inspection {
  return path.endsWith('.json') ? inspectJson(text) : inspectYaml(text);
}

function main(): number {
  const verbose = process.argv.includes('--verbose');
  const files = specFiles(SPEC).sort();
  let totalLosses = 0;
  let totalAtRisk = 0;

  for (const file of files) {
    const { losses, atRisk } = inspect(file, readFileSync(file, 'utf8'));
    const shown = relative(REPO_ROOT, file);
    totalLosses += losses.length;
    totalAtRisk += atRisk.length;

    for (const loss of losses) {
      console.error(`  ${shown}: ${loss.key} written as ${loss.source}, reads as ${loss.parsed}`);
    }
    if (verbose && atRisk.length > 0) {
      console.log(
        `  ${shown}: ${String(atRisk.length)} integer(s) above 2^53 that are exactly representable`,
      );
      for (const entry of atRisk) {
        console.log(`      ${entry.key} = ${entry.source}`);
      }
    }
  }

  if (totalLosses > 0) {
    console.error(`check_fixtures: ${String(totalLosses)} lossy integer(s)`);
    console.error(
      '  A JSON or YAML number is exact only where a double is. Emit the value as a string ' +
        'instead: BigInt, YAML quoted scalars, and vm.parseJsonUint all accept a string-encoded number.',
    );
    return 1;
  }

  console.log(
    `check_fixtures: all checks passed (${String(files.length)} files, ` +
      `${String(totalAtRisk)} integer(s) above 2^53, all exactly representable)`,
  );
  return 0;
}

process.exitCode = main();
