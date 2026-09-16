import { describe, expect, it } from 'vitest';

import { WebDomainError } from '../../src/domain/errors.js';
import { buildMintThenSeed } from '../../src/domain/lp.js';

describe('buildMintThenSeed', () => {
  it('refuses zero mintAmount', () => {
    expect(() => buildMintThenSeed({ mintAmount: 0n, longIn: 1n, shortIn: 1n })).toThrow();
    expect(() => buildMintThenSeed({ mintAmount: 0n, longIn: 1n, shortIn: 1n })).toThrow(
      WebDomainError,
    );
  });

  it('refuses zero longIn', () => {
    expect(() => buildMintThenSeed({ mintAmount: 1n, longIn: 0n, shortIn: 1n })).toThrow();
    expect(() => buildMintThenSeed({ mintAmount: 1n, longIn: 0n, shortIn: 1n })).toThrow(
      WebDomainError,
    );
  });

  it('refuses zero shortIn', () => {
    expect(() => buildMintThenSeed({ mintAmount: 1n, longIn: 1n, shortIn: 0n })).toThrow();
    expect(() => buildMintThenSeed({ mintAmount: 1n, longIn: 1n, shortIn: 0n })).toThrow(
      WebDomainError,
    );
  });

  it('orders mintPair then approve long then approve short then seedPool', () => {
    const b = buildMintThenSeed({ mintAmount: 100n, longIn: 60n, shortIn: 40n });
    expect(b.kind).toBe('mintThenSeed');
    expect(b.steps.map((s) => s.method)).toEqual(['mintPair', 'approve', 'approve', 'seedPool']);
    expect(b.steps.map((s) => s.target)).toEqual([
      'session',
      'longClaim',
      'shortClaim',
      'session',
    ]);
    expect(b.steps[0]?.args).toEqual([100n]);
    expect(b.steps[1]?.args).toEqual([60n]);
    expect(b.steps[2]?.args).toEqual([40n]);
    expect(b.steps[3]?.args).toEqual([60n, 40n]);
  });
});
