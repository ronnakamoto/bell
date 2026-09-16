import { describe, expect, it } from 'vitest';

import { isEligible } from '../../src/domain/eligibility.js';

describe('isEligible', () => {
  it('returns true when both attestation flags are true', () => {
    expect(isEligible({ notUsPerson: true, tosResetAcknowledged: true })).toBe(true);
  });

  it('returns false when notUsPerson is false', () => {
    expect(isEligible({ notUsPerson: false, tosResetAcknowledged: true })).toBe(false);
  });

  it('returns false when tosResetAcknowledged is false', () => {
    expect(isEligible({ notUsPerson: true, tosResetAcknowledged: false })).toBe(false);
  });

  it('returns false when both flags are false', () => {
    expect(isEligible({ notUsPerson: false, tosResetAcknowledged: false })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isEligible(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isEligible(undefined)).toBe(false);
  });
});
