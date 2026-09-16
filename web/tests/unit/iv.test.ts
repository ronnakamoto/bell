import { describe, expect, it } from 'vitest';

import { formatOmittedIv, formatPublishedIv, type IvDisplay } from '../../src/domain/iv.js';

describe('formatPublishedIv', () => {
  it('returns a show display with formatted sigma text', () => {
    const display = formatPublishedIv({
      sigmaWad: 200_000_000_000_000_000n,
      provenance: 'pool',
      ageSessions: 3n,
    });
    expect(display.kind).toBe('show');
    if (display.kind !== 'show') return;
    expect(display.sigma).toMatch(/^\d/);
    expect(display.sigma).toBe('0.2');
    expect(display.provenance).toBe('pool');
    expect(display.ageSessions).toBe('3');
  });

  it('formats whole and fractional WAD sigma values, including negatives', () => {
    const whole = formatPublishedIv({
      sigmaWad: 10n ** 18n,
      provenance: 'pool',
      ageSessions: 0n,
    });
    if (whole.kind !== 'show') return;
    expect(whole.sigma).toBe('1');

    const fractional = formatPublishedIv({
      sigmaWad: 123_456_789_000_000_000n,
      provenance: 'trailing-realised',
      ageSessions: 13n,
    });
    if (fractional.kind !== 'show') return;
    expect(fractional.sigma).toBe('0.123456789');
    expect(fractional.provenance).toBe('trailing-realised');
    expect(fractional.ageSessions).toBe('13');

    const negativeFractional = formatPublishedIv({
      sigmaWad: -1_500_000_000_000_000_000n,
      provenance: 'pool',
      ageSessions: 1n,
    });
    if (negativeFractional.kind !== 'show') return;
    expect(negativeFractional.sigma).toBe('-1.5');

    const negativeWhole = formatPublishedIv({
      sigmaWad: -(10n ** 18n),
      provenance: 'pool',
      ageSessions: 0n,
    });
    if (negativeWhole.kind !== 'show') return;
    expect(negativeWhole.sigma).toBe('-1');
  });
});

describe('formatOmittedIv', () => {
  it('returns omit without decimal price-like text in the default message', () => {
    const display = formatOmittedIv();
    expect(display.kind).toBe('omit');
    if (display.kind !== 'omit') return;
    expect(display.message).not.toMatch(/\d+\.\d+/);
    expect(display.message.toLowerCase()).toMatch(/not|omit|unavailable|withheld|refuse/);
  });

  it('uses a custom message when provided', () => {
    const display = formatOmittedIv('Pool refused to publish implied volatility.');
    expect(display.kind).toBe('omit');
    if (display.kind !== 'omit') return;
    expect(display.message).toBe('Pool refused to publish implied volatility.');
  });

  it('never exposes sigma on omit displays', () => {
    const display: IvDisplay = formatOmittedIv();
    expect(display).not.toHaveProperty('sigma');
    expect(display).not.toHaveProperty('provenance');
  });
});
