import { type IntentBatch } from './intents.js';

export function buildClaim(): IntentBatch {
  return {
    kind: 'claim',
    steps: [
      {
        label: 'Claim settlement payout',
        target: 'session',
        method: 'claim',
        args: [],
      },
    ],
  };
}

export function buildWithdrawPool(): IntentBatch {
  return {
    kind: 'withdrawPool',
    steps: [
      {
        label: 'Withdraw liquidity from pool',
        target: 'session',
        method: 'withdrawPool',
        args: [],
      },
    ],
  };
}
