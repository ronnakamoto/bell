import { describe, expect, it } from 'vitest';

import { buildClaim, buildWithdrawPool } from '../../src/domain/settlement.js';

describe('buildClaim', () => {
  it('buildClaim is a single session.claim step with empty args', () => {
    const b = buildClaim();
    expect(b.kind).toBe('claim');
    expect(b.steps).toHaveLength(1);
    expect(b.steps[0]).toMatchObject({
      target: 'session',
      method: 'claim',
      args: [],
    });
  });
});

describe('buildWithdrawPool', () => {
  it('buildWithdrawPool is a single session.withdrawPool step', () => {
    const b = buildWithdrawPool();
    expect(b.kind).toBe('withdrawPool');
    expect(b.steps.map((s) => s.method)).toEqual(['withdrawPool']);
    expect(b.steps[0]?.target).toBe('session');
    expect(b.steps[0]?.args).toEqual([]);
  });
});
