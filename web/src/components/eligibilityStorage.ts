import { type Attestation } from '../domain/eligibility.js';

export const ELIGIBILITY_STORAGE_KEY = 'bell.eligibility.v1';

/** Parse a sessionStorage value into an attestation, or null if it is missing or not JSON. */
export function parseEligibility(raw: string | null): Attestation | null {
  if (raw === null) {
    return null;
  }

  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const record = value as Record<string, unknown>;
    return {
      notUsPerson: record['notUsPerson'] === true,
      tosResetAcknowledged: record['tosResetAcknowledged'] === true,
    };
  } catch {
    return null;
  }
}

export function readEligibility(): Attestation | null {
  return parseEligibility(sessionStorage.getItem(ELIGIBILITY_STORAGE_KEY));
}

export function writeEligibility(attestation: Attestation): void {
  sessionStorage.setItem(ELIGIBILITY_STORAGE_KEY, JSON.stringify(attestation));
}
