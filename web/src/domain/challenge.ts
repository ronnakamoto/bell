/**
 * Participant-facing challenge report. Serialisable strings only — the adapter maps settlement
 * adjudication onto this union. Domain must not import settlement.
 */

export type ChallengeReportView =
  | { readonly kind: 'upheld'; readonly premiumDeltaWad: string; readonly digest: string }
  | { readonly kind: 'slashed'; readonly reason: string; readonly digest: string }
  | { readonly kind: 'inputs-unavailable'; readonly reason: string }
  | { readonly kind: 'digest-mismatch'; readonly expected: string; readonly computed: string };

/** Format a report view the way the CLI prints `kind=` tokens. */
export function formatChallengeView(view: ChallengeReportView): string {
  switch (view.kind) {
    case 'upheld':
      return `kind=upheld ` + `premiumDeltaWad=${view.premiumDeltaWad} ` + `digest=${view.digest}`;
    case 'slashed':
      return `kind=slashed reason=${view.reason} digest=${view.digest}`;
    case 'inputs-unavailable':
      return `kind=inputs-unavailable reason=${view.reason}`;
    case 'digest-mismatch':
      return `kind=digest-mismatch ` + `expected=${view.expected} ` + `computed=${view.computed}`;
  }
}
