import { describe, expect, it } from 'vitest';

import { type ChallengeReportView, formatChallengeView } from '../../src/domain/challenge.js';

describe('formatChallengeView', () => {
  it('includes kind=upheld with premium delta and digest', () => {
    const view: ChallengeReportView = {
      kind: 'upheld',
      premiumDeltaWad: '0',
      digest: '0xabc',
    };
    const line = formatChallengeView(view);
    expect(line).toContain('kind=upheld');
    expect(line).toContain('premiumDeltaWad=0');
    expect(line).toContain('digest=0xabc');
  });

  it('includes kind=slashed with reason and digest', () => {
    const view: ChallengeReportView = {
      kind: 'slashed',
      reason: 'premium outside tolerance',
      digest: '0xdef',
    };
    const line = formatChallengeView(view);
    expect(line).toContain('kind=slashed');
    expect(line).toContain('premium outside tolerance');
    expect(line).toContain('digest=0xdef');
  });

  it('includes kind=inputs-unavailable with reason and no digest field', () => {
    const view: ChallengeReportView = {
      kind: 'inputs-unavailable',
      reason: 'committed inputs missing',
    };
    const line = formatChallengeView(view);
    expect(line).toContain('kind=inputs-unavailable');
    expect(line).toContain('committed inputs missing');
    expect(line).not.toContain('digest=');
    expect(line).not.toContain('premiumDeltaWad=');
  });

  it('includes kind=digest-mismatch with expected and computed', () => {
    const view: ChallengeReportView = {
      kind: 'digest-mismatch',
      expected: '0x111',
      computed: '0x222',
    };
    const line = formatChallengeView(view);
    expect(line).toContain('kind=digest-mismatch');
    expect(line).toContain('expected=0x111');
    expect(line).toContain('computed=0x222');
  });

  it('covers every report kind', () => {
    const views: ChallengeReportView[] = [
      { kind: 'upheld', premiumDeltaWad: '1', digest: '0xa' },
      { kind: 'slashed', reason: 'leverage mismatch', digest: '0xb' },
      { kind: 'inputs-unavailable', reason: 'store miss' },
      { kind: 'digest-mismatch', expected: '0xc', computed: '0xd' },
    ];
    const kinds = new Set(views.map((view) => view.kind));
    for (const view of views) {
      expect(formatChallengeView(view)).toContain(`kind=${view.kind}`);
    }
    expect(kinds).toEqual(new Set(['upheld', 'slashed', 'inputs-unavailable', 'digest-mismatch']));
  });
});
