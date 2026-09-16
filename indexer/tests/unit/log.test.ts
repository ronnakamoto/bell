/**
 * The log accessors, against the corpus the contracts actually emitted.
 *
 * The refusals are tested with *real* words taken out of `spec/fixtures/logs.json` rather than with
 * invented ones, and that is the point of the file. A synthetic `0xdeadbeef…` proves that a length
 * check fires; the premium store's `nameId` topic proves that the address check catches the mistake it
 * exists for — a `bytes32 indexed` parameter read as `address indexed`, which is a live hazard because
 * the premium store's `Resolved` and the registry's `Resolved` share a name and differ in exactly that
 * position.
 */

import { readFileSync } from 'node:fs';

import { DomainError } from '@bell/calibrator/domain/models.js';
import { describe, expect, it } from 'vitest';

import {
  addressKey,
  addressOfTopic,
  addressOfWord,
  asWord,
  boolOf,
  bytes32OfTopic,
  emitterKey,
  intOf,
  type RawLog,
  topicAt,
  uint64Of,
  uintOf,
  wordAt,
} from '../../src/domain/log.js';

interface Fixture {
  readonly logs: readonly RawLog[];
}

const CORPUS: Fixture = JSON.parse(
  readFileSync(new URL('../../../spec/fixtures/logs.json', import.meta.url), 'utf8'),
) as Fixture;

const COMMITTED = '0x8c8ec3404e0fe9635c7532cb2fabce3bb5e9f7e539e917ac8765bbea6a7696d8';
const SESSION_CREATED = '0xbfea4ffed12dea0f10d6ed0862b3b921c451b49a70efdd3461d7423842282b00';
const REGISTRY_RESOLVED = '0x0c6d8354f459342131b6839d702bdf8ef15df4d9eb0b52f3d3d6f081dfa526fb';
const SETTLED = '0x0e041c951edff06117fdd303d596231ad03cde5b01f3234cc0503228f50d60d9';
const TRADED = '0xe0fb27516feded5e3f21f529eade84ca557938ea6057dbe783ea6668d381b24e';

/** The first log in the corpus with this topic0. The corpus is fixed, so a miss is a broken test. */
function firstWith(topic0: string): RawLog {
  const log = CORPUS.logs.find((candidate) => candidate.topics[0] === topic0);
  if (log === undefined) throw new Error(`the corpus has no log with topic0 ${topic0}`);
  return log;
}

/** A 32-byte word from an integer. Negative values are two's complement at 256 bits, as the ABI is. */
function word(value: bigint): string {
  const bits = value < 0n ? value + (1n << 256n) : value;
  return `0x${bits.toString(16).padStart(64, '0')}`;
}

function log(topics: readonly string[], data = '0x'): RawLog {
  return { topics, data, emitter: '0x0000000000000000000000000000000000000001' };
}

describe('addresses are compared in one form', () => {
  it('lower-cases a checksummed address', () => {
    expect(addressKey('0x3Fc355a5BC036EA3F52849Bba638D3e257A0E6cc')).toBe(
      '0x3fc355a5bc036ea3f52849bba638d3e257a0e6cc',
    );
  });

  it('attributes a session event to the address SessionCreated revealed', () => {
    // The load-bearing link in the whole design. `Settled(uint256,bool)` has no indexed parameter at
    // all, so a session event carries no session identifier and the emitting address is the only thing
    // that ties it to a session -- and the only thing that reveals that address is `SessionCreated`.
    // The corpus renders one checksummed and the other lower-case, so this passes only if the
    // normalisation is right.
    const settled = firstWith(SETTLED);
    expect(settled.emitter).toMatch(/[A-F]/);
    expect(emitterKey(settled)).toBe(addressOfTopic(firstWith(SESSION_CREATED), 1));
    expect(emitterKey(settled)).toBe('0x3fc355a5bc036ea3f52849bba638d3e257a0e6cc');
  });
});

describe('asWord', () => {
  it('lower-cases and keeps the prefix', () => {
    expect(asWord(`0x${'AB'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('refuses a word that is not 32 bytes, naming its length', () => {
    expect(() => asWord('0x1234')).toThrow(DomainError);
    expect(() => asWord('0x1234')).toThrow('a word is 32 bytes, got 2');
  });

  it('refuses a word with no 0x prefix', () => {
    // The prefix was optional while this was being written, which made the accessor lenient in the
    // direction that matters: a record that had lost its prefix is a record that has been truncated
    // or read from the wrong field, and decoding it would produce a plausible value from bad input.
    expect(() => asWord('ab'.repeat(32))).toThrow(DomainError);
    expect(() => asWord('ab'.repeat(32))).toThrow('a word is 0x-prefixed hex');
  });
});

describe('topicAt and wordAt refuse by naming the index', () => {
  it('reports how many topics the log has', () => {
    expect(() => topicAt(firstWith(SETTLED), 1)).toThrow('has 1 topics, no topic 1');
  });

  it('reports how long the data section is', () => {
    expect(() => wordAt(firstWith(SETTLED), 2)).toThrow('data is 64 bytes, so it has no word 2');
  });
});

describe('addresses are read out of a word, and only out of a word that holds one', () => {
  it('takes the low twenty bytes of a topic', () => {
    expect(addressOfTopic(firstWith(SESSION_CREATED), 1)).toBe(
      '0x3fc355a5bc036ea3f52849bba638d3e257a0e6cc',
    );
  });

  it('takes the low twenty bytes of a data word', () => {
    const withAddressWord = log([], `0x${'0'.repeat(24)}${'ab'.repeat(20)}`);
    expect(addressOfWord(withAddressWord, 0)).toBe(`0x${'ab'.repeat(20)}`);
  });

  it('refuses a bytes32 topic, which is the premium store nameId read as a session', () => {
    // The real mistake this check exists for: `Committed`'s `bytes32 indexed nameId` sits in the same
    // position as `Resolved`'s `address indexed session`, and both events are named for a value.
    const committed = firstWith(COMMITTED);
    expect(() => addressOfTopic(committed, 1)).toThrow(DomainError);
    expect(() => addressOfTopic(committed, 1)).toThrow('has a non-zero prefix');
  });

  it('still reads that same topic as a bytes32', () => {
    expect(bytes32OfTopic(firstWith(COMMITTED), 1)).toHaveLength(66);
  });
});

describe('integers are exact above 2^53', () => {
  it('reads the settlement gap, which is 2e16 and not representable as a double', () => {
    // `2e16 > 2^53`, so a reader that went through a double would return 20000000000000000 exactly
    // *by luck of the value* and would round a neighbouring one. The assertion is on the type as much
    // as the value: `bigint` cannot hold a rounded integer.
    const gap = intOf(wordAt(firstWith(REGISTRY_RESOLVED), 1));
    expect(gap).toBe(20_000_000_000_000_000n);
    expect(gap > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('reads a uint64 above 2^53', () => {
    expect(uint64Of(word(18_446_744_073_709_551_615n))).toBe(18_446_744_073_709_551_615n);
  });

  it('refuses a word wider than uint64', () => {
    expect(() => uint64Of(word(1n << 64n))).toThrow('not an ABI-encoded uint64');
  });
});

describe('intOf is two\u2019s complement', () => {
  it('reads a negative gap back as negative', () => {
    expect(intOf(word(-20_000_000_000_000_000n))).toBe(-20_000_000_000_000_000n);
  });

  it('reads the boundary in both directions', () => {
    expect(intOf(word(-1n))).toBe(-1n);
    expect(intOf(word(0n))).toBe(0n);
    expect(uintOf(word(-1n))).toBe((1n << 256n) - 1n);
  });
});

describe('boolOf', () => {
  it('reads the settled-stale flag the corpus carries', () => {
    expect(boolOf(wordAt(firstWith(SETTLED), 1))).toBe(false);
  });

  it('reads a true, which is the common case and the one a false-only suite misses', () => {
    // `Traded(address indexed trader, bool boughtLong, uint256 collateralIn, uint256 claimOut)`: the
    // corpus's single trade is a long buy, so `boughtLong` is true. Asserting only the false case is
    // how a `boolOf` that returned `false` unconditionally would pass.
    expect(boolOf(wordAt(firstWith(TRADED), 0))).toBe(true);
  });

  it('refuses a word that is neither zero nor one', () => {
    expect(() => boolOf(word(2n))).toThrow('not an ABI-encoded bool');
  });
});
