/**
 * The family registry.
 *
 * Three families are implemented and two are named in the paper without an implementation; the gap is
 * recorded rather than hidden:
 *
 * - **empirical** — the seed model, and the reference every other family is scored against.
 * - **gaussian** — implemented so that the brief's rejection of it is re-measurable rather than
 *   asserted.
 * - **normal-inverse-Gaussian** — the thin-sample fallback, per paper §5.3 / Table 31 P0. F10 is
 *   closed: NIG is the documented fallback and not the production model. It was tracker G0, and it is
 *   here rather than in an adapter because the marginal density is never formed — the moment is a
 *   quadrature against the elementary mixing density, so no modified Bessel function is needed at all.
 *   `DESIGN_NOTES.md` F39's placement rule for `K_1` is therefore not exercised; see `nig.ts`.
 * - **student-t, Merton jump-diffusion** — named in the paper's Table 18, which reports each one's
 *   premium error against the empirical distribution. Not implemented here. The Student-t needs only
 *   `lgamma` and the Merton family a Poisson sum; neither is on any tracker gate, because the paper's
 *   ranking puts the NIG first among the fallbacks.
 *
 * This file is the analogue of the Python package's `__init__.py`, and the port keeps the package a
 * directory for the same reason: the registry is a different thing from the strategy it registers, and
 * a caller that wants one family should not have to import all of them.
 */

import { type DistributionFamily, FamilyError, UnimplementedFamilyError } from './base.js';
import { EmpiricalTruncatedFamily } from './empirical.js';
import { GaussianFamily } from './gaussian.js';
import { NigFamily } from './nig.js';

/** Every implemented family, by name. Insertion-ordered, which the seed check relies on. */
export const FAMILIES: ReadonlyMap<string, DistributionFamily> = new Map<
  string,
  DistributionFamily
>([
  ['empirical', new EmpiricalTruncatedFamily()],
  ['gaussian', new GaussianFamily()],
  ['nig', new NigFamily()],
]);

/** The seed model, per paper §5.3 / Table 31 P0. The brief's §4.2.4 agrees on the seed. */
export const SEED_FAMILY = 'empirical';

/**
 * The families the paper compares and this repository does not implement.
 *
 * Named rather than omitted so that a caller asking for one gets a specific refusal instead of a
 * missing key.
 */
export const UNIMPLEMENTED_FAMILIES: ReadonlySet<string> = new Set(['student_t', 'merton']);

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
 * than a lookup failure. A missing entry reads as a typo; an unimplemented family is a recorded gap
 * and the error has to say so. The NIG used to be on this path — it was F10 (closed) and tracker G0 —
 * and it is not any more, which is why the message names the tracker rather than a finding.
 */
export function familyFor(name: string): DistributionFamily {
  if (UNIMPLEMENTED_FAMILIES.has(name)) {
    throw new UnimplementedFamilyError(
      `the '${name}' family is named in the paper but not implemented here; see tracker G0 ` +
        '(the NIG fallback landed, these two did not)',
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
  floorDiv,
  GapSample,
  premiumFromTruncatedMean,
  truncatedMeanWad,
  UnimplementedFamilyError,
} from './base.js';
export { EmpiricalTruncatedFamily } from './empirical.js';
export {
  dimensionless,
  GaussianFamily,
  gaussianPremiumWad,
  relativeErrorWad,
  toWad,
} from './gaussian.js';
export {
  NigFamily,
  NigParameters,
  nigParameters,
  nigQuadraturePlan,
  nigTruncatedAbsMomentAtCap,
  truncatedAbsMomentForNormal,
} from './nig.js';
