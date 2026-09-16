import { describe, expect, it } from 'vitest';

import { formatQuote, type Quote } from '../../src/domain/quote.js';

describe('formatQuote', () => {
  it('returns a price display for Usable', () => {
    const q: Quote = {
      verdict: 'Usable',
      lambdaWad: 15_000_000_000_000_000_000n,
      premiumWad: 174_000_000_000_000_000n,
    };
    const d = formatQuote(q);
    expect(d.kind).toBe('price');
    if (d.kind !== 'price') return;
    expect(d.isFallback).toBe(false);
    expect(d.premium).toMatch(/^\d/);
  });

  it('marks Fallback as fallback and still shows a premium', () => {
    const d = formatQuote({
      verdict: 'Fallback',
      lambdaWad: 10n ** 18n,
      premiumWad: 10n ** 17n,
    });
    expect(d.kind).toBe('price');
    if (d.kind !== 'price') return;
    expect(d.isFallback).toBe(true);
  });

  it('returns refuse without a premium field (F50)', () => {
    const d = formatQuote({ verdict: 'Refuse' });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d).not.toHaveProperty('premium');
    expect(d.message.toLowerCase()).toMatch(/not|do not|cannot|refuse|unprice/);
    expect(d.message).not.toMatch(/^\d/);
  });

  it('formats whole and fractional WAD values, including negatives', () => {
    const whole = formatQuote({
      verdict: 'Usable',
      lambdaWad: 10n ** 18n,
      premiumWad: 5n * 10n ** 17n,
    });
    expect(whole.kind).toBe('price');
    if (whole.kind !== 'price') return;
    expect(whole.lambda).toBe('1');
    expect(whole.premium).toBe('0.5');

    const fractional = formatQuote({
      verdict: 'Usable',
      lambdaWad: 123_456_789_000_000_000n,
      premiumWad: -1_500_000_000_000_000_000n,
    });
    if (fractional.kind !== 'price') return;
    expect(fractional.lambda).toBe('0.123456789');
    expect(fractional.premium).toBe('-1.5');

    const negativeWhole = formatQuote({
      verdict: 'Usable',
      lambdaWad: -(10n ** 18n),
      premiumWad: 1n,
    });
    if (negativeWhole.kind !== 'price') return;
    expect(negativeWhole.lambda).toBe('-1');
  });
});
