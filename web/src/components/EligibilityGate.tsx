'use client';

import { type ReactNode, useEffect, useState } from 'react';

import { isEligible } from '../domain/eligibility.js';
import { readEligibility, writeEligibility } from './eligibilityStorage.js';

export interface EligibilityGateProps {
  readonly children: ReactNode;
}

/**
 * Gate intent previews behind a US-exclusion and chain ToS-reset self-attestation.
 * First paint assumes not eligible so SSR HTML cannot disagree with sessionStorage.
 */
export function EligibilityGate({ children }: EligibilityGateProps): ReactNode {
  const [eligible, setEligible] = useState(false);
  const [notUsPerson, setNotUsPerson] = useState(false);
  const [tosResetAcknowledged, setTosResetAcknowledged] = useState(false);

  useEffect(() => {
    if (isEligible(readEligibility())) {
      setEligible(true);
    }
  }, []);

  if (eligible) {
    return children;
  }

  const canAccept = notUsPerson && tosResetAcknowledged;

  function onAccept(): void {
    writeEligibility({ notUsPerson: true, tosResetAcknowledged: true });
    setEligible(true);
  }

  return (
    <section aria-label="Eligibility" data-testid="eligibility-required">
      <h3>Eligibility</h3>
      <p>
        BELL is not offered to US persons. Intent previews are shown only after you confirm you are
        not a US person and acknowledge that on-chain terms of service have been reset.
      </p>
      <label>
        <input
          type="checkbox"
          data-testid="eligibility-not-us"
          checked={notUsPerson}
          onChange={(event) => {
            setNotUsPerson(event.target.checked);
          }}
        />
        I am not a US person
      </label>
      <label>
        <input
          type="checkbox"
          data-testid="eligibility-tos-reset"
          checked={tosResetAcknowledged}
          onChange={(event) => {
            setTosResetAcknowledged(event.target.checked);
          }}
        />
        I acknowledge the chain ToS reset
      </label>
      <button
        type="button"
        data-testid="eligibility-accept"
        disabled={!canAccept}
        onClick={onAccept}
      >
        Accept
      </button>
    </section>
  );
}
