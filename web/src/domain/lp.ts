import { WebDomainError } from './errors.js';
import { type IntentBatch } from './intents.js';

function requirePositive(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new WebDomainError(`${label} must be positive`);
  }
}

export function buildMintThenSeed(input: {
  readonly mintAmount: bigint;
  readonly longIn: bigint;
  readonly shortIn: bigint;
}): IntentBatch {
  requirePositive(input.mintAmount, 'mintAmount');
  requirePositive(input.longIn, 'longIn');
  requirePositive(input.shortIn, 'shortIn');

  return {
    kind: 'mintThenSeed',
    steps: [
      {
        label: 'Mint long and short claim pair',
        target: 'session',
        method: 'mintPair',
        args: [input.mintAmount],
      },
      {
        label: 'Approve session to spend long claims',
        target: 'longClaim',
        method: 'approve',
        args: [input.longIn],
      },
      {
        label: 'Approve session to spend short claims',
        target: 'shortClaim',
        method: 'approve',
        args: [input.shortIn],
      },
      {
        label: 'Seed liquidity pool',
        target: 'session',
        method: 'seedPool',
        args: [input.longIn, input.shortIn],
      },
    ],
  };
}
