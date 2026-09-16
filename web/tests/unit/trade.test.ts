import { describe, expect, it } from 'vitest';

import { WebDomainError } from '../../src/domain/errors.js';
import { buildBuyLong, buildBuyShort } from '../../src/domain/trade.js';

describe('buildBuyLong', () => {
  it('refuses zero or missing-style zero minLongOut', () => {
    expect(() => buildBuyLong({ collateralIn: 1n, minLongOut: 0n })).toThrow(
      /minOut|minLongOut|slippage/i,
    );
    expect(() => buildBuyLong({ collateralIn: 1n, minLongOut: 0n })).toThrow(WebDomainError);
  });

  it('refuses zero collateralIn', () => {
    expect(() => buildBuyLong({ collateralIn: 0n, minLongOut: 1n })).toThrow();
    expect(() => buildBuyLong({ collateralIn: 0n, minLongOut: 1n })).toThrow(WebDomainError);
  });

  it('orders approve then buyLong', () => {
    const b = buildBuyLong({ collateralIn: 50n, minLongOut: 1n });
    expect(b.kind).toBe('buyLong');
    expect(b.steps.map((s) => s.method)).toEqual(['approve', 'buyLong']);
    expect(b.steps[0]?.target).toBe('collateral');
    expect(b.steps[0]?.args).toEqual([50n]);
    expect(b.steps[1]?.target).toBe('session');
    expect(b.steps[1]?.args).toEqual([50n, 1n]);
  });
});

describe('buildBuyShort', () => {
  it('refuses zero or missing-style zero minShortOut', () => {
    expect(() => buildBuyShort({ collateralIn: 1n, minShortOut: 0n })).toThrow(
      /minOut|minShortOut|slippage/i,
    );
    expect(() => buildBuyShort({ collateralIn: 1n, minShortOut: 0n })).toThrow(WebDomainError);
  });

  it('refuses zero collateralIn', () => {
    expect(() => buildBuyShort({ collateralIn: 0n, minShortOut: 1n })).toThrow();
    expect(() => buildBuyShort({ collateralIn: 0n, minShortOut: 1n })).toThrow(WebDomainError);
  });

  it('orders approve then buyShort', () => {
    const b = buildBuyShort({ collateralIn: 50n, minShortOut: 1n });
    expect(b.kind).toBe('buyShort');
    expect(b.steps.map((s) => s.method)).toEqual(['approve', 'buyShort']);
    expect(b.steps[0]?.target).toBe('collateral');
    expect(b.steps[0]?.args).toEqual([50n]);
    expect(b.steps[1]?.target).toBe('session');
    expect(b.steps[1]?.args).toEqual([50n, 1n]);
  });
});
