#!/usr/bin/env node
/**
 * Assert that every JSON fixture under `spec/` is losslessly readable by a JavaScript consumer.
 *
 * Three fixtures in this repository were written with WAD-scale integers as bare JSON numbers, and
 * each was found independently: `digest.json` (one field, F52), `fixtures/moments.json` (seven fields
 * across all 112 points, F52 extended), and `fixtures/canonical.json` (61 values). Three independent
 * occurrences is not three mistakes — it is a missing guard. This is that guard.
 *
 * **The check is exact representability, not a threshold.** A double can hold some integers above
 * 2^53 exactly: anything of the form `k * 10^n` with a small `k` carries enough factors of two, and
 * every one of `canonical.json`'s 61 large values happens to survive. So a rule that failed on
 * "above `MAX_SAFE_INTEGER`" would fail on a file that is currently correct and pass on nothing that
 * matters. The rule that matters is "does this literal survive a round trip", and that is what this
 * checks — by comparing each integer literal's *source text* against the value `JSON.parse` produced
 * from it, which Node exposes through the reviver's third argument.
 *
 * A value that is merely unsafe-by-form but exactly representable passes, and is reported as a
 * warning: it is not broken today, and it becomes broken the moment somebody edits a digit.
 *
 * Usage:
 *     node tools/check_fixtures.ts            # check, exit non-zero on any loss
 *     node tools/check_fixtures.ts --verbose  # also list the at-risk-but-exact literals
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Every `.json` file under `spec/`, recursively. */
function jsonFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...jsonFiles(full));
    } else if (entry.endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Walk a JSON document and report every integer literal that does not round-trip.
 *
 * The reviver's third argument carries the original source text of the value being revived, which is
 * the only way to see what was written after `JSON.parse` has already rounded it. Comparing the two
 * is the check: a literal is lossless exactly when `BigInt(source) === BigInt(parsed)`.
 */
function inspect(text: string): { losses: Loss[]; atRisk: AtRisk[] } {
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
      if (typeof source === 'string' && /^-?\d+$/.test(source)) {
        const exact = BigInt(source);
        const roundTripped = BigInt(value);
        if (exact !== roundTripped) {
          losses.push({
            key,
            source,
            parsed: roundTripped.toString(),
          });
        } else if (exact > MAX_SAFE || exact < -MAX_SAFE) {
          atRisk.push({ key, source });
        }
      }
    }
    return value;
  });

  return { losses, atRisk };
}

function main(): number {
  const verbose = process.argv.includes('--verbose');
  const files = jsonFiles(SPEC).sort();
  let totalLosses = 0;
  let totalAtRisk = 0;

  for (const file of files) {
    const { losses, atRisk } = inspect(readFileSync(file, 'utf8'));
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
      '  A JSON number is exact only where a double is. Emit the value as a string instead: ' +
        'BigInt, the Python reader and vm.parseJsonUint all accept a string-encoded number.',
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
