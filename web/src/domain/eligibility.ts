export interface Attestation {
  readonly notUsPerson: boolean;
  readonly tosResetAcknowledged: boolean;
}

export function isEligible(attestation: Attestation | null | undefined): boolean {
  if (attestation === null || attestation === undefined) {
    return false;
  }

  return attestation.notUsPerson === true && attestation.tosResetAcknowledged === true;
}
