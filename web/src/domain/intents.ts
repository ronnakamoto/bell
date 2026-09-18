export type IntentTargetRole = 'collateral' | 'session' | 'longClaim' | 'shortClaim' | 'premium';

export interface IntentStep {
  readonly label: string;
  readonly target: IntentTargetRole;
  readonly method: string;
  readonly args: readonly (bigint | string)[];
}

export interface IntentBatch {
  readonly kind: 'buyLong' | 'buyShort' | 'mintThenSeed' | 'claim' | 'withdrawPool' | 'challenge';
  readonly steps: readonly IntentStep[];
}
