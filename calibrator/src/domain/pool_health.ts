/**
 * Pool health metrics derived from the reserves.
 *
 * The imbalance is the absolute difference between the long and short reserves divided by the
 * total — zero when perfectly balanced, one when entirely one-sided. The paper's maker sheet
 * targets ±3.79% net-Long imbalance at 1× turnover (Table 30), so a threshold of 0.04 (4%) is
 * the practical bound a maker cares about. The function is pure — the reserves come from the
 * chain, and this module does not read them.
 */

import { WAD } from './constants.js';

export interface PoolHealth {
  /** Long reserve as a percentage of total (0–100). */
  readonly longPct: number;
  /** Short reserve as a percentage of total (0–100). */
  readonly shortPct: number;
  /** Absolute imbalance: |long − short| / total (0–1). */
  readonly imbalance: number;
  /** True when the imbalance exceeds the maker's 4% target. */
  readonly skewed: boolean;
}

/** The maker's imbalance target from Table 30 (±3.79%, rounded to 4%). */
export const IMBALANCE_THRESHOLD = 0.04;

/**
 * Compute pool health from the reserves. Both are WAD-scaled bigints as stored by the fold.
 * Returns zero percentages and zero imbalance when both reserves are zero (an unseeded pool).
 */
export function computePoolHealth(longReserve: bigint, shortReserve: bigint): PoolHealth {
  const total = longReserve + shortReserve;
  if (total === 0n) {
    return { longPct: 0, shortPct: 0, imbalance: 0, skewed: false };
  }
  const longPct = Number((longReserve * 10_000n) / total) / 100;
  const shortPct = 100 - longPct;
  const diff = longReserve > shortReserve ? longReserve - shortReserve : shortReserve - longReserve;
  const imbalance = Number((diff * 10n ** 18n) / total) / Number(WAD);
  return { longPct, shortPct, imbalance, skewed: imbalance > IMBALANCE_THRESHOLD };
}
