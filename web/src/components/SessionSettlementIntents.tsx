import type { ReactNode } from 'react';

import { ClaimForm } from './ClaimForm.js';
import { WithdrawPoolForm } from './WithdrawPoolForm.js';

export interface SessionSettlementIntentsProps {
  readonly settled: boolean;
  /** The session the claim/withdraw batches act on. */
  readonly sessionAddress: string;
}

/** Gate claim/withdrawPool intent forms on a settled session. */
export function SessionSettlementIntents({
  settled,
  sessionAddress,
}: SessionSettlementIntentsProps): ReactNode {
  if (!settled) {
    return (
      <p data-testid="claim-disabled-not-settled">
        Claim and withdrawPool intents are disabled because the session is not settled.
      </p>
    );
  }

  return (
    <>
      <ClaimForm sessionAddress={sessionAddress} />
      <WithdrawPoolForm sessionAddress={sessionAddress} />
    </>
  );
}
