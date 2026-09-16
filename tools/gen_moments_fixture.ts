#!/usr/bin/env node
/**
 * Generate `spec/fixtures/moments.json`, the differential fixture for the pricing primitive.
 *
 * Paper §10.4 makes this the critical cross-language test: "For every formula that exists in both
 * Solidity and Python, there must be a test that reads a shared JSON fixture from `spec/` and asserts
 * the two implementations agree to a stated tolerance. The truncated moment is the critical one."
 *
 * The values here are computed by the calibrator's `domain/moments`, which evaluates the error
 * function to 50 significant digits. The Solidity implementation uses Abramowitz & Stegun 7.1.26,
 * whose stated absolute error is 1.5e-7. The *difference* between the two is therefore the on-chain
 * approximation's error and nothing else — which is what makes the tolerance derivable rather than
 * chosen.
 *
 * Tolerance derivation, stated once here and asserted in both consumers:
 *
 *     The moment's tail term is 2c * (1 - Phi(c/sigma)), and Phi = (1 + erf)/2, so Phi inherits half
 *     of erf's absolute error, and the tail inherits 2c * (1.5e-7 / 2) = c * 1.5e-7.
 *     The body term uses the density, which is accurate to WAD rounding (~1e-18 relative) and is
 *     negligible beside it. WAD quantization contributes at most a few wei.
 *     So: absolute_tolerance = c * 1.5e-7 + a small WAD slack.
 *
 * The fixture records `toleranceWei` per point so that neither consumer re-derives it independently —
 * a second derivation is a second source of truth.
 *
 * **It imports the compiled calibrator through its package specifier, not the source tree.** A bare
 * `node tools/gen_moments_fixture.ts` cannot resolve a relative `'./x.js'` specifier to `x.ts` — Node
 * does not rewrite one, measured — and `models.ts` imports `'./constants.js'`, so the source tree is
 * not loadable outside the build tools at all. Reading `dist/` is what the settlement service already
 * does, so the generators exercise the same `exports` map (F69, F73).
 *
 * **The generator's own arithmetic runs at 60 significant digits, mirroring the Python's
 * `localcontext(prec=60)`.** This is not the same question as the module's 50: `lam * moment` for
 * `lam = 1000` carries 53 significant digits, so at 50 the product would round before `toWad` ever
 * sees it. F70 is the same shape of defect one module over.
 *
 * Run with `make build`, which compiles the calibrator first. Deterministic.
 *
 * Usage:
 *     node tools/gen_moments_fixture.ts            # write the fixture
 *     node tools/gen_moments_fixture.ts --check    # the same, but exit non-zero if it was stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { truncatedAbsMoment, truncatedFirstMoment } from '@bell/calibrator/domain/moments.js';
import { Decimal } from 'decimal.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(REPO_ROOT, 'spec/fixtures/moments.json');

const GENERATED_BANNER = 'GENERATED FILE - DO NOT EDIT BY HAND.';

const WAD = 10n ** 18n;
const ERF_ABSOLUTE_BOUND = new Decimal('1.5e-7');
const WAD_SLACK_WEI = 1_000n;

/**
 * The generator's working precision, mirroring the Python's `localcontext(prec=60)`.
 *
 * A clone rather than `moments.ts`'s `D`, because `D` is the *module's* 50 and this is the
 * generator's 60; the two must not be confusable at a call site.
 */
const G = Decimal.clone({ precision: 60 });

// A grid rather than a handful of points. It spans the leverage range the protocol lists (the
// canonical set runs 10 to 32, the event set 4 to 21, and the ladder is open above that) and the
// volatility range the measured cross-section spans (AAPL overnight at 1.09% to COIN at 3.13%, with
// room either side).
const LEVERAGES = [1, 2, 4, 8, 10, 11, 15, 16, 22, 32, 64, 100, 250, 1000];
const SIGMAS = ['0.0050', '0.0109', '0.0145', '0.0188', '0.0218', '0.0257', '0.0313', '0.0500'];

/** One point of the grid, with every integer field carried as a string. */
interface Point {
  readonly lambdaWad: string;
  readonly sigmaWad: string;
  readonly capWad: string;
  readonly momentWad: string;
  readonly premiumWad: string;
  readonly firstMomentWad: string;
  readonly toleranceWei: string;
}

/** `10n ** 18n` as a `G`-precision decimal, so the multiply below runs in the generator's context. */
const G_WAD = new G(10).pow(18);

/**
 * Quantise to the WAD grid, half-even.
 *
 * The reference is computed at 50 significant digits and the WAD grid has 18 decimal places, so a
 * quantisation is unavoidable. It costs at most half a wei, which is eleven orders of magnitude
 * below the 1.5e-7 tolerance the fixture is used to assert, so it cannot contribute to a failure.
 */
function toWad(value: Decimal): bigint {
  return BigInt(new G(value).times(G_WAD).toFixed(0, G.ROUND_HALF_EVEN));
}

function render(): string {
  const points: Point[] = [];
  for (const lamUnits of LEVERAGES) {
    const lam = new G(lamUnits);
    const cap = new G(1).dividedBy(lam);
    for (const sigmaText of SIGMAS) {
      const sigma = new G(sigmaText);
      const moment = truncatedAbsMoment(lam, new G(0), sigma);
      const premium = lam.times(moment);
      const firstMoment = truncatedFirstMoment(lam, sigma);
      const toleranceWei =
        BigInt(new G(cap).times(ERF_ABSOLUTE_BOUND).times(G_WAD).toFixed(0)) + WAD_SLACK_WEI;
      points.push({
        // **Every integer field is a string, and the rule is uniform on purpose.**
        //
        // A JSON number is exact only up to 2^53 - 1. These are WAD-scale values, so most of them
        // exceed that: `lambdaWad` at 1e21 for the widest leverage, `premiumWad` at ~9.9e17, and 109
        // of the 112 points have at least one field over the line. A JavaScript reader does not fail
        // on them -- `JSON.parse` silently rounds, so the port would compare a wrong number against a
        // tolerance and either pass by luck or fail confusingly.
        //
        // `toleranceWei` cannot exceed 2^53 today (its maximum is about 1.5e11), and it is still
        // emitted as a string. A uniform rule -- "every integer in this fixture is a string" -- is
        // checkable by reading one line; a per-field rule requires re-deriving the bound every time a
        // field is added. See DESIGN_NOTES.md F52.
        lambdaWad: String(BigInt(lamUnits) * WAD),
        sigmaWad: String(toWad(sigma)),
        capWad: String(toWad(cap)),
        momentWad: String(toWad(moment)),
        premiumWad: String(toWad(premium)),
        firstMomentWad: String(toWad(firstMoment)),
        toleranceWei: String(toleranceWei),
      });
    }
  }

  const payload = {
    _generated: GENERATED_BANNER,
    // Names the derivation, not the generator file. The two generators that can write this fixture
    // are interchangeable by design -- `make check-generated` runs both and requires them to agree --
    // so a banner naming one of them is false whenever the other ran. See F72.
    _source: 'domain/moments, evaluated at 50 significant digits (paper Eq (12))',
    _identity:
      'paper Eq (12): E[min(|G|, c)] = 2*sigma*(phi(0) - phi(c/sigma)) ' +
      '+ 2*c*(1 - Phi(c/sigma)), with c = 1/lambda and pL = lambda * E[min(|G|, c)]',
    _tolerance:
      'absoluteTolerance = capWad * 1.5e-7 + 1000 wei. Derived from the on-chain error ' +
      "function's stated bound of 1.5e-7, not chosen. Recorded per point.",
    pointCount: points.length,
    points,
  };
  // ensure_ascii=False on the Python side: the fixtures are read by humans as well as by two test
  // suites, and the provenance strings carry section marks. `JSON.stringify` emits them raw too.
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function main(): number {
  const content = render();
  mkdirSync(dirname(OUT), { recursive: true });

  const stale = !existsSync(OUT) || readFileSync(OUT, 'utf8') !== content;
  if (stale) writeFileSync(OUT, content);

  if (process.argv.includes('--check') && stale) {
    console.error('generated files are stale:');
    console.error(`  ${relative(REPO_ROOT, OUT)}`);
    console.error('run `make build`');
    return 1;
  }
  const points = (JSON.parse(content) as { pointCount: number }).pointCount;
  const state = stale ? 'stale, rewritten' : 'up to date';
  console.log(`  ${relative(REPO_ROOT, OUT)}: ${state}, ${String(points)} points`);
  return 0;
}

process.exitCode = main();
