/**
 * ChallengeSource file adapter and application.
 *
 * The adapter must re-fit from the committed store the way the CLI does. A stub table that
 * maps `upheld-store` → `kind=upheld` would pass a single-label assertion and fail the four
 * fixture kinds below.
 */

import { describe, expect, it } from 'vitest';

import { FileChallengeSource } from '../../src/adapters/challenge_verify.js';
import { listChallengeLabels, verifyChallengeCase } from '../../src/application/challenge.js';
import { type ChallengeReportView } from '../../src/domain/challenge.js';
import { type ChallengeSource } from '../../src/domain/ports.js';

const fixtureSource = new FileChallengeSource();

const FIXTURE_LABELS = [
  'upheld-store',
  'digest-mismatch',
  'inputs-unavailable',
  'slashed-premium',
] as const;

const HEX_64 = /^0x[0-9a-f]{64}$/;

class MemoryChallengeSource implements ChallengeSource {
  readonly heldLabels: readonly string[];
  readonly reports: ReadonlyMap<string, ChallengeReportView>;

  constructor(heldLabels: readonly string[], reports: ReadonlyMap<string, ChallengeReportView>) {
    this.heldLabels = heldLabels;
    this.reports = reports;
  }

  labels(): Promise<readonly string[]> {
    return Promise.resolve(this.heldLabels);
  }

  verify(label: string): Promise<ChallengeReportView> {
    const report = this.reports.get(label);
    if (report === undefined) {
      return Promise.reject(new Error(`no case labelled ${label}`));
    }
    return Promise.resolve(report);
  }
}

describe('listChallengeLabels', () => {
  it('returns the source labels without inventing any', async () => {
    const source = new MemoryChallengeSource(['only-this'], new Map());
    await expect(listChallengeLabels(source)).resolves.toEqual(['only-this']);
  });
});

describe('verifyChallengeCase', () => {
  it('returns the source report rather than inventing upheld', async () => {
    const slashed: ChallengeReportView = {
      kind: 'slashed',
      reason: 'injected',
      digest: '0xab',
    };
    const source = new MemoryChallengeSource(
      ['upheld-store'],
      new Map([['upheld-store', slashed]]),
    );
    await expect(verifyChallengeCase(source, 'upheld-store')).resolves.toEqual(slashed);
  });
});

describe('FileChallengeSource', () => {
  it('lists the four committed fixture labels in document order', async () => {
    await expect(listChallengeLabels(fixtureSource)).resolves.toEqual([...FIXTURE_LABELS]);
  });

  it('upheld-store is upheld from a real store re-fit', async () => {
    const report = await verifyChallengeCase(fixtureSource, 'upheld-store');
    expect(report.kind).toBe('upheld');
    if (report.kind !== 'upheld') return;
    expect(report.premiumDeltaWad).toBe('0');
    expect(report.digest).toMatch(HEX_64);
    expect(report.digest.startsWith('0x')).toBe(true);
  });

  it('digest-mismatch is a digest-mismatch with 0x hex', async () => {
    const report = await verifyChallengeCase(fixtureSource, 'digest-mismatch');
    expect(report.kind).toBe('digest-mismatch');
    if (report.kind !== 'digest-mismatch') return;
    expect(report.expected).toMatch(HEX_64);
    expect(report.computed).toMatch(HEX_64);
  });

  it('inputs-unavailable is inputs-unavailable with a reason', async () => {
    const report = await verifyChallengeCase(fixtureSource, 'inputs-unavailable');
    expect(report.kind).toBe('inputs-unavailable');
    if (report.kind !== 'inputs-unavailable') return;
    expect(report.reason.length).toBeGreaterThan(0);
    expect(report).not.toHaveProperty('digest');
  });

  it('slashed-premium is slashed with a reason and 0x digest', async () => {
    const report = await verifyChallengeCase(fixtureSource, 'slashed-premium');
    expect(report.kind).toBe('slashed');
    if (report.kind !== 'slashed') return;
    expect(report.reason.length).toBeGreaterThan(0);
    expect(report.digest).toMatch(HEX_64);
  });
});
