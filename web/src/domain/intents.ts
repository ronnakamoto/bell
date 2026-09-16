export type IntentTargetRole = 'collateral' | 'session' | 'longClaim' | 'shortClaim';

export interface IntentStep {
  readonly label: string;
  readonly target: IntentTargetRole;
  readonly method: string;
  readonly args: readonly bigint[];
}

export interface IntentBatch {
  readonly kind: 'buyLong' | 'buyShort' | 'mintThenSeed' | 'claim' | 'withdrawPool';
  readonly steps: readonly IntentStep[];
}
