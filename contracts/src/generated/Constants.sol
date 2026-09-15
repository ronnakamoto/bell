// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Constants
/// @notice GENERATED FILE - DO NOT EDIT BY HAND.
/// @dev Produced by tools/gen_constants.ts from spec/constants.yaml.
///      Regenerate with `make build`. `make check` fails if this file is stale.
///
///      Every value carries its provenance. A constant that appears in a second source file
///      is a bug waiting to diverge (build brief §6).
library Constants {
    // ---------------------------------------------------------------- protocol
    /// @dev 1e18, the fixed-point scale. Source: paper §2.
    uint256 internal constant WAD = 1_000_000_000_000_000_000;
    /// @dev saturation probability. Source: paper §6.1 Eq 14.
    uint256 internal constant ALPHA_WAD = 10_000_000_000_000_000;
    /// @dev guard G3, Tier-1 band. Source: paper §12.4.
    uint256 internal constant TIER1_HALT_BAND_WAD = 50_000_000_000_000_000;
    /// @dev guard G3, legacy default. Source: paper §9.4.
    uint256 internal constant HALT_BAND_DEFAULT_WAD = 250_000_000_000_000_000;
    /// @dev USDG decimals, asserted at construction. Source: paper Table 6.
    uint256 internal constant COLLATERAL_DECIMALS = 6;
    /// @dev reference token decimals. Source: paper check D1.
    uint256 internal constant EQUITY_TOKEN_DECIMALS = 18;
    /// @dev eta_ann. Source: paper §6.3 Eq 17.
    uint256 internal constant PROTOCOL_FEE_ANNUALISED_WAD = 120_000_000_000_000_000;
    /// @dev 365 * 24. Source: paper §6.3 Eq 17.
    uint256 internal constant HOURS_PER_YEAR = 8_760;
    /// @dev eta <= 0.05 * pL. Source: paper §6.3 Eq 18.
    uint256 internal constant PROTOCOL_FEE_CAP_OF_PREMIUM_WAD = 50_000_000_000_000_000;
    /// @dev blended fee, basis points. Source: paper §11.2.
    uint256 internal constant BLENDED_FEE_TARGET_BP_WAD = 4_106_000_000_000_000_000;
    /// @dev trading fee at the close. Source: paper §6.3 Eq 19.
    uint256 internal constant RAMP_PHI_0_WAD = 1_000_000_000_000_000;
    /// @dev trading fee at the open. Source: paper §6.3 Eq 19.
    uint256 internal constant RAMP_PHI_1_WAD = 10_000_000_000_000_000;
    /// @dev phi_0 + (phi_1 - phi_0)*2/3. Source: paper §6.3.
    uint256 internal constant RAMP_TIME_AVERAGE_CEILING_WAD = 7_000_000_000_000_000;
    /// @dev phi_ref, a fee not a volatility. Source: paper §6.3 Eq 20.
    uint256 internal constant TRADING_FEE_REFERENCE_WAD = 5_500_000_000_000_000;
    /// @dev cap grid; 0.25% reproduces the published lambdas. Source: paper §6.1, Table 26.
    uint256 internal constant ROUNDING_LATTICE_WAD = 2_500_000_000_000_000;
    /// @dev commitment usable horizon, in sessions. Source: paper Table 19.
    uint256 internal constant STALENESS_SESSIONS = 12;
    /// @dev rotation period plus challenge window. Source: paper Table 19.
    uint256 internal constant BOND_LOCK_SESSIONS = 13;
    /// @dev one compromised key costs one name. Source: paper Table 19.
    uint256 internal constant PUBLISHER_KEYS_PER_NAME = 1;
    /// @dev E, selected by forward error. Source: paper §7.9 Table 15.
    uint256 internal constant OVERNIGHT_WINDOW_SESSIONS = 504;
    /// @dev E for AAPL. Source: paper §7.9 Table 15.
    uint256 internal constant OVERNIGHT_WINDOW_SESSIONS_AAPL = 378;
    /// @dev W; the longest the sample supports. Source: paper §7.9 Table 15.
    uint256 internal constant WEEKEND_WINDOW_SESSIONS = 126;

    // ---------------------------------------------------------------- bonds, in collateral base units (USDG, 6 decimals)
    /// @dev 3x the largest one-session mispricing gain. Source: paper Table 19.
    uint256 internal constant MIN_PUBLISHER_BOND = 500_000_000_000;
    /// @dev upper bound on a guessing challenger. Source: paper Table 19.
    uint256 internal constant CHALLENGER_BOND = 50_000_000_000;

    // ---------------------------------------------------------------- settlement route costs, bp
    /// @dev void at 0.50. Source: paper Table 22.
    uint256 internal constant ROUTE_R1_COST_BP_WAD = 29_700_000_000_000_000_000;
    /// @dev deferred settlement on the first valid print. Source: paper Table 22.
    uint256 internal constant ROUTE_R2_COST_BP_WAD = 21_000_000_000_000_000;
    /// @dev constant refund with a plausibility band. Source: paper Table 22.
    uint256 internal constant ROUTE_R4_COST_BP_WAD = 1_370_000_000_000_000_000;
    /// @dev optimistic challenge window. Source: paper Table 22.
    uint256 internal constant ROUTE_R5_COST_BP_WAD = 1_370_000_000_000_000_000;

    // ---------------------------------------------------------------- chain
    /// @dev Robinhood Chain. Source: paper §1, §9.2.
    uint256 internal constant CHAIN_ID = 4_663;
    /// @dev The fork block the end-to-end suite pins. Source: paper §9.2.
    uint256 internal constant FORK_BLOCK_L2 = 61_228_000;

    // ---------------------------------------------------------------- gas budget
    /// @dev Baselines are the paper's measurements; budgets are the brief's §13.3 multiples.
    uint256 internal constant GAS_TRUNCATED_MOMENT_BASELINE = 37_439;
    uint256 internal constant GAS_PREMIUM_STORAGE_BASELINE = 2_640;
    uint256 internal constant GAS_REGISTRY_OPERATION_MAX = 150_000;
}
