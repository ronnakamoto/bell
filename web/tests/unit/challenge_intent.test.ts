import { CHALLENGER_BOND } from '@bell/calibrator/domain/constants.js';
import { describe, expect, it } from 'vitest';

import { buildChallenge, buildResolve } from '../../src/domain/challenge_intent.js';
import { WebDomainError } from '../../src/domain/errors.js';

const NAME_ID = '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';

describe('buildChallenge', () => {
  it('orders collateral approve then premium challenge with default CHALLENGER_BOND', () => {
    const batch = buildChallenge({ nameId: NAME_ID, forSession: 7n });
    expect(batch.kind).toBe('challenge');
    expect(batch.steps.map((step) => step.method)).toEqual(['approve', 'challenge']);
    expect(batch.steps.map((step) => step.target)).toEqual(['collateral', 'premium']);
    expect(batch.steps[0]?.args).toEqual([CHALLENGER_BOND]);
    expect(batch.steps[1]?.args).toEqual([NAME_ID, 7n]);
  });

  it('uses an explicit positive challengerBond', () => {
    const batch = buildChallenge({ nameId: NAME_ID, forSession: 1n, challengerBond: 99n });
    expect(batch.steps[0]?.args).toEqual([99n]);
  });

  it('accepts forSession zero', () => {
    const batch = buildChallenge({ nameId: NAME_ID, forSession: 0n });
    expect(batch.steps[1]?.args).toEqual([NAME_ID, 0n]);
  });

  it('accepts mixed-case hex nameId', () => {
    const mixed = '0xE108948b9667048232851f26A1427d3a908b22da622562906ca50ea536c2ecFb';
    const batch = buildChallenge({ nameId: mixed, forSession: 1n });
    expect(batch.steps[1]?.args[0]).toBe(mixed);
  });

  it('refuses empty or invalid nameId', () => {
    const invalid = [
      '',
      '0x',
      `0x${'ab'.repeat(31)}`,
      `0x${'ab'.repeat(33)}`,
      NAME_ID.slice(2),
      `0X${NAME_ID.slice(2)}`,
      `0x${'g'.repeat(64)}`,
      ` ${NAME_ID}`,
    ];
    for (const nameId of invalid) {
      expect(() => buildChallenge({ nameId, forSession: 1n })).toThrow(WebDomainError);
      expect(() => buildChallenge({ nameId, forSession: 1n })).toThrow(/nameId/);
    }
  });

  it('refuses negative forSession', () => {
    expect(() => buildChallenge({ nameId: NAME_ID, forSession: -1n })).toThrow(WebDomainError);
    expect(() => buildChallenge({ nameId: NAME_ID, forSession: -1n })).toThrow(/forSession/);
  });

  it('refuses zero or negative challengerBond', () => {
    expect(() => buildChallenge({ nameId: NAME_ID, forSession: 1n, challengerBond: 0n })).toThrow(
      WebDomainError,
    );
    expect(() => buildChallenge({ nameId: NAME_ID, forSession: 1n, challengerBond: 0n })).toThrow(
      /challengerBond|bond/i,
    );
    expect(() => buildChallenge({ nameId: NAME_ID, forSession: 1n, challengerBond: -1n })).toThrow(
      WebDomainError,
    );
  });
});

describe('buildResolve', () => {
  it('builds a single resolve step targeting the premium registry', () => {
    const batch = buildResolve({ nameId: NAME_ID, forSession: 7n, publisherCorrect: true });
    expect(batch.kind).toBe('resolve');
    expect(batch.steps).toHaveLength(1);
    expect(batch.steps[0]?.method).toBe('resolve');
    expect(batch.steps[0]?.target).toBe('premium');
    expect(batch.steps[0]?.args).toEqual([NAME_ID, 7n, 1n]);
  });

  it('carries a slashed ruling as a false bool', () => {
    const batch = buildResolve({ nameId: NAME_ID, forSession: 7n, publisherCorrect: false });
    expect(batch.steps[0]?.args).toEqual([NAME_ID, 7n, 0n]);
    expect(batch.steps[0]?.label).toBe('Rule publisher slashed');
  });

  it('labels an upheld ruling', () => {
    const batch = buildResolve({ nameId: NAME_ID, forSession: 7n, publisherCorrect: true });
    expect(batch.steps[0]?.label).toBe('Rule publisher correct');
  });

  it('refuses an invalid nameId and a negative forSession', () => {
    expect(() =>
      buildResolve({ nameId: '0x1234', forSession: 1n, publisherCorrect: true }),
    ).toThrow(/nameId/);
    expect(() =>
      buildResolve({ nameId: NAME_ID, forSession: -1n, publisherCorrect: true }),
    ).toThrow(/forSession/);
  });
});
