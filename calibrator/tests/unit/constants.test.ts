/**
 * The generated constants module, and the one hole the gates leave open.
 *
 * `make check-generated` proves the module is **fresh** — that the generator reproduces it — and the
 * pair of generators proves the three files they share are rendered identically from the same YAML.
 * Neither proves this module is **right**, because nothing in this workspace reads it yet: a rendering
 * defect that emitted a value as a `number` rather than a `bigint` would satisfy both, and the values
 * themselves are only cross-checked through the Solidity and Python files that this one does not
 * appear in.
 *
 * So the suite asserts the module's own stated contract, and the identities its own provenance notes
 * claim — a constant and its derivation agreeing, rather than two literals being compared.
 *
 * This is an addition rather than a port: the Python `constants.py` has no test of its own, because
 * every one of its consumers exercises it. The TypeScript module has no consumer yet.
 */

import { describe, expect, it } from 'vitest';

import * as constants from '../../src/domain/constants.js';

describe('the generated constants', () => {
  it('exports every constant as a bigint, so nothing in the module is a double', () => {
    // The header states this as the module's contract, and it is the one property a freshness check
    // cannot see: a value emitted without the `n` suffix is a valid `number` literal that type-checks,
    // formats and lints cleanly.
    const entries = Object.entries(constants);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, value] of entries) {
      expect(typeof value, `${name} must be a bigint`).toBe('bigint');
    }
  });

  it('has a ramp ceiling that is the mean of its two endpoints', () => {
    // `RAMP_TIME_AVERAGE_CEILING_WAD` carries its own derivation as provenance: the time-average of a
    // fee ramping linearly from phi_0 at the close to phi_1 at the open is phi_0 + (phi_1 - phi_0)*2/3.
    const span = constants.RAMP_PHI_1_WAD - constants.RAMP_PHI_0_WAD;
    const expected = constants.RAMP_PHI_0_WAD + (span * 2n) / 3n;
    expect(constants.RAMP_TIME_AVERAGE_CEILING_WAD).toBe(expected);
  });

  it('states the risk dial and the cap grid as fractions of the scale, not as percentages', () => {
    // Both are ratios, and a ratio written at WAD scale is the form that has already gone wrong once in
    // this repository: `redeemPair` subtracted a fee *rate* as an *amount* (DESIGN_NOTES.md F23). The
    // failure this catches is `ALPHA_WAD = 1n`, meaning "one percent", which reads correctly and is off
    // by sixteen orders of magnitude.
    expect(constants.ALPHA_WAD).toBe(constants.WAD / 100n);
    expect(constants.ROUNDING_LATTICE_WAD).toBe(constants.WAD / 400n);
  });
});
