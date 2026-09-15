/**
 * The family registry.
 *
 * Two families are implemented and three are named in the paper without an implementation; the gap is
 * recorded rather than hidden:
 *
 * - **empirical** — the seed model, and the reference every other family is scored against.
 * - **gaussian** — implemented so that the brief's rejection of it is re-measurable rather than
 *   asserted.
 * - **student-t, normal-inverse-Gaussian, Merton jump-diffusion** — named in the paper's Table 18,
 *   which reports each one's premium error against the empirical distribution. Not implemented here.
 *   The Student-t and Merton families need only `lgamma` and a Poisson sum; the NIG needs a modified
 *   Bessel function of the second kind, which is a numerical routine that belongs in an adapter rather
 *   than in `domain/`. F10 is closed: the paper is primary, so NIG is the documented fallback for thin
 *   samples, not the production model. The family is still missing — that is tracker G0, a P0 gate, not
 *   an open question.
 *
 * This file is the analogue of the Python package's `__init__.py`, and the port keeps the package a
 * directory for the same reason: the registry is a different thing from the strategy it registers, and
 * a caller that wants one family should not have to import all of them.
 */

import { type DistributionFamily, FamilyError, UnimplementedFamilyError } from './base.js';
import { EmpiricalTruncatedFamily } from './empirical.js';
import { GaussianFamily } from './gaussian.js';

/** Every implemented family, by name. Insertion-ordered, which the seed check relies on. */
export const FAMILIES: ReadonlyMap<string, DistributionFamily> = new Map<
  string,
  DistributionFamily
>([
  ['empirical', new EmpiricalTruncatedFamily()],
  ['gaussian', new GaussianFamily()],
]);

/** The seed model, per paper §5.3 / Table 31 P0. The brief's §4.2.4 agrees on the seed. */
export const SEED_FAMILY = 'empirical';

/**
 * The families the paper compares and this repository does not implement.
 *
 * Named rather than omitted so that a caller asking for one gets a specific refusal instead of a
 * missing key.
 */
export const UNIMPLEMENTED_FAMILIES: ReadonlySet<string> = new Set(['student_t', 'nig', 'merton']);

/** The registered family with this name, or a refusal. */
function requireFamily(name: string): DistributionFamily {
  const family = FAMILIES.get(name);
  if (family === undefined) {
    throw new FamilyError(`unknown family: '${name}'`);
  }
  return family;
}

/**
 * The family with this name.
 *
 * Throws a specific error for a family the paper names but this repository does not implement, rather
 * than a lookup failure. A missing entry reads as a typo; the absence of NIG is F10 (closed) and
 * tracker G0, and the error has to say so.
 */
export function familyFor(name: string): DistributionFamily {
  if (UNIMPLEMENTED_FAMILIES.has(name)) {
    throw new UnimplementedFamilyError(
      `the '${name}' family is named in the paper but not implemented here; see ` +
        'DESIGN_NOTES.md F10 (closed: fallback, not production) and tracker G0',
    );
  }
  return requireFamily(name);
}

/** The family the paper names as the seed: the empirical truncated distribution. */
export function seedFamily(): DistributionFamily {
  return requireFamily(SEED_FAMILY);
}

// `DistributionFamily` is a type and the rest are values, so the re-export is split: under
// `verbatimModuleSyntax` a single statement cannot carry both.
export type { DistributionFamily } from './base.js';
export {
  FamilyError,
  FamilyFit,
  GapSample,
  UnimplementedFamilyError,
  floorDiv,
  premiumFromTruncatedMean,
  truncatedMeanWad,
} from './base.js';
export { EmpiricalTruncatedFamily } from './empirical.js';
export {
  GaussianFamily,
  dimensionless,
  gaussianPremiumWad,
  relativeErrorWad,
  toWad,
} from './gaussian.js';
