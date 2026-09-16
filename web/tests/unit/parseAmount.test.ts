import { describe, expect, it } from 'vitest';

import { describeCaughtError, parseDigitAmount } from '../../src/components/parseAmount.js';

describe('parseDigitAmount', () => {
  it('parses a digit string', () => {
    expect(parseDigitAmount('50')).toBe(50n);
  });

  it('refuses a non-digit string', () => {
    expect(() => parseDigitAmount('1.5')).toThrow(/integer|digits|empty/i);
    expect(() => parseDigitAmount('')).toThrow(/integer|digits|empty/i);
  });
});

describe('describeCaughtError', () => {
  it('returns an Error message', () => {
    expect(describeCaughtError(new Error('minOut must be positive'))).toMatch(/minOut/i);
  });

  it('returns a fallback for a non-Error throw', () => {
    expect(describeCaughtError('boom')).toBe('Could not build intent.');
  });
});
