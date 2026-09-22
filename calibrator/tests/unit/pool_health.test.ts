/**
 * Pool health computation.
 *
 * Pure arithmetic — no chain reads. Pinned against the paper's maker sheet target: ±3.79% at 1×
 * turnover (Table 30), rounded to a 4% threshold.
 */

import { describe, expect, it } from 'vitest';

import { computePoolHealth, IMBALANCE_THRESHOLD } from '../../src/domain/pool_health.js';

const WAD = 10n ** 18n;

describe('computePoolHealth', () => {
  it('returns zero metrics for an unseeded pool', () => {
    const health = computePoolHealth(0n, 0n);
    expect(health.longPct).toBe(0);
    expect(health.shortPct).toBe(0);
    expect(health.imbalance).toBe(0);
    expect(health.skewed).toBe(false);
  });

  it('reports a perfectly balanced pool', () => {
    const health = computePoolHealth(100n * WAD, 100n * WAD);
    expect(health.longPct).toBe(50);
    expect(health.shortPct).toBe(50);
    expect(health.imbalance).toBe(0);
    expect(health.skewed).toBe(false);
  });

  it('reports the maker imbalance target (3.79% net-Long)', () => {
    // 3.79% imbalance: long = 51.895%, short = 48.105%
    // |51.895 - 48.105| / 100 = 3.79% — just below the 4% threshold
    const long = BigInt(Math.round(51.895 * 1e18));
    const short = BigInt(Math.round(48.105 * 1e18));
    const health = computePoolHealth(long, short);
    expect(health.imbalance).toBeCloseTo(0.0379, 2);
    expect(health.skewed).toBe(false);
  });

  it('flags a pool that exceeds the imbalance threshold', () => {
    // 60/40 split: imbalance = 20%
    const health = computePoolHealth(60n * WAD, 40n * WAD);
    expect(health.longPct).toBe(60);
    expect(health.shortPct).toBe(40);
    expect(health.imbalance).toBeCloseTo(0.2, 4);
    expect(health.skewed).toBe(true);
  });

  it('handles a one-sided pool', () => {
    const health = computePoolHealth(100n * WAD, 0n);
    expect(health.longPct).toBe(100);
    expect(health.shortPct).toBe(0);
    expect(health.imbalance).toBe(1);
    expect(health.skewed).toBe(true);
  });

  it('is symmetric — the order of reserves does not matter', () => {
    const a = computePoolHealth(70n * WAD, 30n * WAD);
    const b = computePoolHealth(30n * WAD, 70n * WAD);
    expect(a.imbalance).toBe(b.imbalance);
    expect(a.skewed).toBe(b.skewed);
  });
});

describe('IMBALANCE_THRESHOLD', () => {
  it('is 0.04 (4%), consistent with Table 30', () => {
    expect(IMBALANCE_THRESHOLD).toBe(0.04);
  });
});
