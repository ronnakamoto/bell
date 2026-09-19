import { describe, expect, it } from 'vitest';

import { buildCommit } from '../../src/domain/commit_intent.js';
import { MIN_PUBLISHER_BOND } from '../../src/domain/constants.js';
import { DomainError } from '../../src/domain/models.js';

const NAME_ID = '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';
const INPUTS_HASH = '0xba1940ba1e74225e3f3b13b7579e0920e64c04e6ff859f9649d95dec39ab0903';

describe('buildCommit', () => {
  it('orders collateral approve then premium commit with default MIN_PUBLISHER_BOND', () => {
    const batch = buildCommit({
      nameId: NAME_ID,
      forSession: 12_345n,
      lambdaWad: 15n * 10n ** 18n,
      premiumWad: 174n * 10n ** 15n,
      inputsHash: INPUTS_HASH,
    });
    expect(batch.kind).toBe('commit');
    expect(batch.steps.map((step) => step.method)).toEqual(['approve', 'commit']);
    expect(batch.steps.map((step) => step.target)).toEqual(['collateral', 'premium']);
    expect(batch.steps[0]?.args).toEqual([MIN_PUBLISHER_BOND]);
    expect(batch.steps[1]?.args).toEqual([
      NAME_ID,
      12_345n,
      15n * 10n ** 18n,
      174n * 10n ** 15n,
      INPUTS_HASH,
    ]);
  });

  it('uses an explicit positive publisherBond', () => {
    const batch = buildCommit({
      nameId: NAME_ID,
      forSession: 1n,
      lambdaWad: 1n,
      premiumWad: 1n,
      inputsHash: INPUTS_HASH,
      publisherBond: 99n,
    });
    expect(batch.steps[0]?.args).toEqual([99n]);
  });

  it('accepts forSession zero', () => {
    const batch = buildCommit({
      nameId: NAME_ID,
      forSession: 0n,
      lambdaWad: 1n,
      premiumWad: 1n,
      inputsHash: INPUTS_HASH,
    });
    expect(batch.steps[1]?.args[1]).toBe(0n);
  });

  it('refuses empty or invalid nameId', () => {
    for (const nameId of ['', '0x', NAME_ID.slice(2), `0x${'g'.repeat(64)}`]) {
      expect(() =>
        buildCommit({
          nameId,
          forSession: 1n,
          lambdaWad: 1n,
          premiumWad: 1n,
          inputsHash: INPUTS_HASH,
        }),
      ).toThrow(DomainError);
      expect(() =>
        buildCommit({
          nameId,
          forSession: 1n,
          lambdaWad: 1n,
          premiumWad: 1n,
          inputsHash: INPUTS_HASH,
        }),
      ).toThrow(/nameId/);
    }
  });

  it('refuses empty or invalid inputsHash', () => {
    expect(() =>
      buildCommit({
        nameId: NAME_ID,
        forSession: 1n,
        lambdaWad: 1n,
        premiumWad: 1n,
        inputsHash: '0x',
      }),
    ).toThrow(/inputsHash/);
  });

  it('refuses negative forSession', () => {
    expect(() =>
      buildCommit({
        nameId: NAME_ID,
        forSession: -1n,
        lambdaWad: 1n,
        premiumWad: 1n,
        inputsHash: INPUTS_HASH,
      }),
    ).toThrow(/forSession/);
  });

  it('refuses non-positive lambda, premium, or bond', () => {
    expect(() =>
      buildCommit({
        nameId: NAME_ID,
        forSession: 1n,
        lambdaWad: 0n,
        premiumWad: 1n,
        inputsHash: INPUTS_HASH,
      }),
    ).toThrow(/lambdaWad/);
    expect(() =>
      buildCommit({
        nameId: NAME_ID,
        forSession: 1n,
        lambdaWad: 1n,
        premiumWad: 0n,
        inputsHash: INPUTS_HASH,
      }),
    ).toThrow(/premiumWad/);
    expect(() =>
      buildCommit({
        nameId: NAME_ID,
        forSession: 1n,
        lambdaWad: 1n,
        premiumWad: 1n,
        inputsHash: INPUTS_HASH,
        publisherBond: 0n,
      }),
    ).toThrow(/publisherBond/);
  });
});
