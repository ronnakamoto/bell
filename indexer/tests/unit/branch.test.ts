/**
 * The `Branch` mirror.
 *
 * The correspondence with the Solidity enum is an ordinal correspondence, so the only thing that can
 * be tested here is the *order* — and the order is the whole content of the type. The corpus supplies
 * one real ordinal (`LivePrint`, from the lifecycle the fixture runs), which pins the zero end; the
 * other four are pinned by the declaration order in `ReferenceRegistry.sol`, which this file restates
 * so that a reordering has to be deliberate in two places rather than silent in one.
 */

import { readFileSync } from 'node:fs';

import { DomainError } from '@bell/calibrator/domain/models.js';
import { describe, expect, it } from 'vitest';

import { BRANCHES, branchFromCode, settlesSession } from '../../src/domain/branch.js';
import { type RawLog, uintOf, wordAt } from '../../src/domain/log.js';

interface Fixture {
  readonly logs: readonly RawLog[];
}

const CORPUS: Fixture = JSON.parse(
  readFileSync(new URL('../../../spec/fixtures/logs.json', import.meta.url), 'utf8'),
) as Fixture;

const REGISTRY_RESOLVED = '0x0c6d8354f459342131b6839d702bdf8ef15df4d9eb0b52f3d3d6f081dfa526fb';

describe('the members are the Solidity enum in its declaration order', () => {
  it('lists all five', () => {
    expect(BRANCHES).toStrictEqual([
      'LivePrint',
      'StalePrint',
      'VoidAtHalf',
      'Deferred',
      'CorporateActionTerminal',
    ]);
  });

  it('is frozen, because the order is a fact about a deployed contract', () => {
    expect(Object.isFrozen(BRANCHES)).toBe(true);
  });
});

describe('branchFromCode', () => {
  it('maps each ordinal to its member', () => {
    expect(BRANCHES.map((_branch, index) => branchFromCode(BigInt(index)))).toStrictEqual([
      ...BRANCHES,
    ]);
  });

  it('refuses an ordinal past the end, rather than defaulting', () => {
    // A sixth member added to the Solidity enum arrives as 5. A lookup that fell back to a default
    // would file it as whichever branch the default was.
    expect(() => branchFromCode(5n)).toThrow(DomainError);
    expect(() => branchFromCode(5n)).toThrow('the enum has 5 members');
  });

  it('refuses a negative ordinal and a value far outside the width', () => {
    expect(() => branchFromCode(-1n)).toThrow(DomainError);
    expect(() => branchFromCode(1n << 200n)).toThrow(DomainError);
  });
});

describe('settlesSession', () => {
  it('is false for Deferred and true for the other four', () => {
    expect(BRANCHES.filter((branch) => !settlesSession(branch))).toStrictEqual(['Deferred']);
  });
});

describe('the corpus carries a real ordinal', () => {
  it('decodes the registry\u2019s resolution as a live print', () => {
    const resolved = CORPUS.logs.find((log) => log.topics[0] === REGISTRY_RESOLVED);
    if (resolved === undefined) throw new Error('the corpus has no registry resolution');
    // `Resolved(address indexed session, Branch branch, int256 gapWad, uint256 payoffWad)`: the branch
    // is the first word of the data section, and it is `uint8` on the wire.
    expect(branchFromCode(uintOf(wordAt(resolved, 0)))).toBe('LivePrint');
    expect(settlesSession('LivePrint')).toBe(true);
  });
});
