import { describe, expect, it } from 'vitest';

import { parseEligibility } from '../../src/components/eligibilityStorage.js';

describe('parseEligibility', () => {
  it('returns null for a missing value', () => {
    expect(parseEligibility(null)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseEligibility('{')).toBeNull();
  });

  it('returns null for a non-object JSON value', () => {
    expect(parseEligibility('true')).toBeNull();
    expect(parseEligibility('1')).toBeNull();
    expect(parseEligibility('"x"')).toBeNull();
    expect(parseEligibility('null')).toBeNull();
  });

  it('treats missing flags as false', () => {
    expect(parseEligibility('{}')).toEqual({
      notUsPerson: false,
      tosResetAcknowledged: false,
    });
  });

  it('requires both flags to be strictly true', () => {
    expect(parseEligibility('{"notUsPerson":true,"tosResetAcknowledged":false}')).toEqual({
      notUsPerson: true,
      tosResetAcknowledged: false,
    });
    expect(parseEligibility('{"notUsPerson":true,"tosResetAcknowledged":true}')).toEqual({
      notUsPerson: true,
      tosResetAcknowledged: true,
    });
  });
});
