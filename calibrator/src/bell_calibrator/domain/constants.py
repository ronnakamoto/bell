"""GENERATED FILE - DO NOT EDIT BY HAND.

Produced by tools/gen_constants.py from spec/constants.yaml.
Regenerate with `make build`. `make check` fails if this file is stale.

Integers are exact. Nothing here is a float: `domain/` never sees one (brief §7.3).
"""

from __future__ import annotations

WAD: int = 10**18

# saturation probability. Source: paper §6.1 Eq 14.
ALPHA_WAD: int = 10_000_000_000_000_000
# guard G3, Tier-1 band. Source: paper §12.4.
TIER1_HALT_BAND_WAD: int = 50_000_000_000_000_000
# guard G3, legacy default. Source: paper §9.4.
HALT_BAND_DEFAULT_WAD: int = 250_000_000_000_000_000
# USDG decimals, asserted at construction. Source: paper Table 6.
COLLATERAL_DECIMALS: int = 6
# reference token decimals. Source: paper check D1.
EQUITY_TOKEN_DECIMALS: int = 18
# eta_ann. Source: paper §6.3 Eq 17.
PROTOCOL_FEE_ANNUALISED_WAD: int = 120_000_000_000_000_000
# 365 * 24. Source: paper §6.3 Eq 17.
HOURS_PER_YEAR: int = 8_760
# eta <= 0.05 * pL. Source: paper §6.3 Eq 18.
PROTOCOL_FEE_CAP_OF_PREMIUM_WAD: int = 50_000_000_000_000_000
# blended fee, basis points. Source: paper §11.2.
BLENDED_FEE_TARGET_BP_WAD: int = 4_106_000_000_000_000_000
# trading fee at the close. Source: paper §6.3 Eq 19.
RAMP_PHI_0_WAD: int = 1_000_000_000_000_000
# trading fee at the open. Source: paper §6.3 Eq 19.
RAMP_PHI_1_WAD: int = 10_000_000_000_000_000
# phi_0 + (phi_1 - phi_0)*2/3. Source: paper §6.3.
RAMP_TIME_AVERAGE_CEILING_WAD: int = 7_000_000_000_000_000
# phi_ref, a fee not a volatility. Source: paper §6.3 Eq 20.
TRADING_FEE_REFERENCE_WAD: int = 5_500_000_000_000_000
# cap grid; 0.25% reproduces the published lambdas. Source: paper §6.1, Table 26.
ROUNDING_LATTICE_WAD: int = 2_500_000_000_000_000
# commitment usable horizon, in sessions. Source: paper Table 19.
STALENESS_SESSIONS: int = 12
# rotation period plus challenge window. Source: paper Table 19.
BOND_LOCK_SESSIONS: int = 13
# one compromised key costs one name. Source: paper Table 19.
PUBLISHER_KEYS_PER_NAME: int = 1
# E, selected by forward error. Source: paper §7.9 Table 15.
OVERNIGHT_WINDOW_SESSIONS: int = 504
# E for AAPL. Source: paper §7.9 Table 15.
OVERNIGHT_WINDOW_SESSIONS_AAPL: int = 378
# W; the longest the sample supports. Source: paper §7.9 Table 15.
WEEKEND_WINDOW_SESSIONS: int = 126

# Bonds, in collateral base units (USDG, 6 decimals). Ruling R2 in DESIGN_NOTES.
# 3x the largest one-session mispricing gain. Source: paper Table 19.
MIN_PUBLISHER_BOND: int = 500_000_000_000
# upper bound on a guessing challenger. Source: paper Table 19.
CHALLENGER_BOND: int = 50_000_000_000

# Settlement route costs, in basis points at WAD scale.
# void at 0.50. Source: paper Table 22.
ROUTE_R1_COST_BP_WAD: int = 29_700_000_000_000_000_000
# deferred settlement on the first valid print. Source: paper Table 22.
ROUTE_R2_COST_BP_WAD: int = 21_000_000_000_000_000
# constant refund with a plausibility band. Source: paper Table 22.
ROUTE_R4_COST_BP_WAD: int = 1_370_000_000_000_000_000
# optimistic challenge window. Source: paper Table 22.
ROUTE_R5_COST_BP_WAD: int = 1_370_000_000_000_000_000

# Chain
CHAIN_ID: int = 4663
FORK_BLOCK_L2: int = 61_228_000
