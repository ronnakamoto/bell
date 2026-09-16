import { WebDomainError } from './errors.js';
import { type IntentBatch } from './intents.js';

function requirePositiveCollateral(collateralIn: bigint): void {
  if (collateralIn <= 0n) {
    throw new WebDomainError('collateralIn must be positive');
  }
}

function requirePositiveMinOut(minOut: bigint, label: string): void {
  if (minOut <= 0n) {
    throw new WebDomainError(`${label} must be a positive slippage floor (minOut > 0)`);
  }
}

export function buildBuyLong(input: {
  readonly collateralIn: bigint;
  readonly minLongOut: bigint;
}): IntentBatch {
  requirePositiveCollateral(input.collateralIn);
  requirePositiveMinOut(input.minLongOut, 'minLongOut');

  return {
    kind: 'buyLong',
    steps: [
      {
        label: 'Approve session to spend collateral',
        target: 'collateral',
        method: 'approve',
        args: [input.collateralIn],
      },
      {
        label: 'Buy long claims',
        target: 'session',
        method: 'buyLong',
        args: [input.collateralIn, input.minLongOut],
      },
    ],
  };
}

export function buildBuyShort(input: {
  readonly collateralIn: bigint;
  readonly minShortOut: bigint;
}): IntentBatch {
  requirePositiveCollateral(input.collateralIn);
  requirePositiveMinOut(input.minShortOut, 'minShortOut');

  return {
    kind: 'buyShort',
    steps: [
      {
        label: 'Approve session to spend collateral',
        target: 'collateral',
        method: 'approve',
        args: [input.collateralIn],
      },
      {
        label: 'Buy short claims',
        target: 'session',
        method: 'buyShort',
        args: [input.collateralIn, input.minShortOut],
      },
    ],
  };
}
