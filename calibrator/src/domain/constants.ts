/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Produced by tools/gen_constants.ts from spec/constants.yaml.
 * Regenerate with `make build`. `make check` fails if this file is stale.
 *
 * Every value is a `bigint`. The Python counterpart of this module declares `int`, which is
 * arbitrary precision; `bigint` is the only TypeScript type that is the same thing. A `number`
 * here would be an IEEE-754 double, and "a monetary value silently became one" is the failure the
 * `Wad` type exists to prevent. A caller that needs a count — a loop bound, a slice length —
 * converts explicitly at that one point, where the conversion is visible.
 */

/** 1e18, the fixed-point scale. Source: paper §2. */
export const WAD = 1_000_000_000_000_000_000n;

/** saturation probability. Source: paper §6.1 Eq 14. */
export const ALPHA_WAD = 10_000_000_000_000_000n;

/** guard G3, Tier-1 band. Source: paper §12.4. */
export const TIER1_HALT_BAND_WAD = 50_000_000_000_000_000n;

/** guard G3, legacy default. Source: paper §9.4. */
export const HALT_BAND_DEFAULT_WAD = 250_000_000_000_000_000n;

/** USDG decimals, asserted at construction. Source: paper Table 6. */
export const COLLATERAL_DECIMALS = 6n;

/** reference token decimals. Source: paper check D1. */
export const EQUITY_TOKEN_DECIMALS = 18n;

/** eta_ann. Source: paper §6.3 Eq 17. */
export const PROTOCOL_FEE_ANNUALISED_WAD = 120_000_000_000_000_000n;

/** 365 * 24. Source: paper §6.3 Eq 17. */
export const HOURS_PER_YEAR = 8_760n;

/** eta <= 0.05 * pL. Source: paper §6.3 Eq 18. */
export const PROTOCOL_FEE_CAP_OF_PREMIUM_WAD = 50_000_000_000_000_000n;

/** blended fee, basis points. Source: paper §11.2. */
export const BLENDED_FEE_TARGET_BP_WAD = 4_106_000_000_000_000_000n;

/** trading fee at the close. Source: paper §6.3 Eq 19. */
export const RAMP_PHI_0_WAD = 1_000_000_000_000_000n;

/** trading fee at the open. Source: paper §6.3 Eq 19. */
export const RAMP_PHI_1_WAD = 10_000_000_000_000_000n;

/** phi_0 + (phi_1 - phi_0)*2/3. Source: paper §6.3. */
export const RAMP_TIME_AVERAGE_CEILING_WAD = 7_000_000_000_000_000n;

/** phi_ref, a fee not a volatility. Source: paper §6.3 Eq 20. */
export const TRADING_FEE_REFERENCE_WAD = 5_500_000_000_000_000n;

/** cap grid; 0.25% reproduces the published lambdas. Source: paper §6.1, Table 26. */
export const ROUNDING_LATTICE_WAD = 2_500_000_000_000_000n;

/** commitment usable horizon, in sessions. Source: paper Table 19. */
export const STALENESS_SESSIONS = 12n;

/** rotation period plus challenge window. Source: paper Table 19. */
export const BOND_LOCK_SESSIONS = 13n;

/** one compromised key costs one name. Source: paper Table 19. */
export const PUBLISHER_KEYS_PER_NAME = 1n;

/** E, selected by forward error. Source: paper §7.9 Table 15. */
export const OVERNIGHT_WINDOW_SESSIONS = 504n;

/** E for AAPL. Source: paper §7.9 Table 15. */
export const OVERNIGHT_WINDOW_SESSIONS_AAPL = 378n;

/** W; the longest the sample supports. Source: paper §7.9 Table 15. */
export const WEEKEND_WINDOW_SESSIONS = 126n;

// Bonds, in collateral base units (USDG, 6 decimals). Ruling R2 in DESIGN_NOTES.

/** 3x the largest one-session mispricing gain. Source: paper Table 19. */
export const MIN_PUBLISHER_BOND = 500_000_000_000n;

/** upper bound on a guessing challenger. Source: paper Table 19. */
export const CHALLENGER_BOND = 50_000_000_000n;

// Settlement route costs, in basis points at WAD scale.

/** void at 0.50. Source: paper Table 22. */
export const ROUTE_R1_COST_BP_WAD = 29_700_000_000_000_000_000n;

/** deferred settlement on the first valid print. Source: paper Table 22. */
export const ROUTE_R2_COST_BP_WAD = 21_000_000_000_000_000n;

/** constant refund with a plausibility band. Source: paper Table 22. */
export const ROUTE_R4_COST_BP_WAD = 1_370_000_000_000_000_000n;

/** optimistic challenge window. Source: paper Table 22. */
export const ROUTE_R5_COST_BP_WAD = 1_370_000_000_000_000_000n;

// Chain

/** Robinhood Chain. Source: paper §1, §9.2. */
export const CHAIN_ID = 4_663n;

/** The fork block the end-to-end suite pins. Source: paper §9.2. */
export const FORK_BLOCK_L2 = 61_228_000n;
