/**
 * The fold, verified against the corpus the contracts actually emitted.
 *
 * A decoder verified against logs the indexer's own encoder produced proves nothing, because the
 * two would agree while both being wrong about the wire format. `spec/fixtures/logs.json` is
 * `vm.getRecordedLogsJson()` from a real lifecycle, so the numbers below are the instrument's own
 * pricing primitive — `min(λ·|G|, 1) = min(15 × 0.02, 1)` — visible in the logs, not restated here.
 */

import { readFileSync } from 'node:fs';

import { DomainError } from '@bell/calibrator/domain/models.js';
import { describe, expect, it } from 'vitest';

import { emptyCatalogue, nameOf, sessionOf } from '../../src/domain/catalogue.js';
import { decodeEvent } from '../../src/domain/decode.js';
import { foldLogs } from '../../src/domain/fold.js';
import { addressKey, type RawLog } from '../../src/domain/log.js';
import { type IndexerConfig } from '../../src/domain/ports.js';
import { EVENTS } from '../../src/domain/taxonomy.js';

interface Fixture {
  readonly logs: readonly RawLog[];
}

const CORPUS: Fixture = JSON.parse(
  readFileSync(new URL('../../../spec/fixtures/logs.json', import.meta.url), 'utf8'),
) as Fixture;

const SESSION_CREATED = '0xbfea4ffed12dea0f10d6ed0862b3b921c451b49a70efdd3461d7423842282b00';
const SESSION_REGISTERED = '0x28e487a6111e0cb65c7a6ef4ffc45a36e06b481fb2cf18dbde02b4c88e6aee67';
const COMMITTED = '0x8c8ec3404e0fe9635c7532cb2fabce3bb5e9f7e539e917ac8765bbea6a7696d8';
const CHALLENGED = '0xc99902c2119795819e8b34976cebd598b20d8f830b5fc11747981c2291b4709c';
const PREMIUM_RESOLVED = '0xccb43d232ecfb3b83994d0f1802b813e25ff21e10e43fe5db91badffbc8562ee';
const PRINT_SUBMITTED = '0xf0ac8e5d645b0d54c6e4b31d0d9f68717549d4abe63668ec57fd7ae52e5842a2';
const REGISTRY_RESOLVED = '0x0c6d8354f459342131b6839d702bdf8ef15df4d9eb0b52f3d3d6f081dfa526fb';
const UNKNOWN_TOPIC = `0x${'11'.repeat(32)}`;

function firstWith(topic0: string): RawLog {
  const log = CORPUS.logs.find((candidate) => candidate.topics[0] === topic0);
  if (log === undefined) throw new Error(`the corpus has no log with topic0 ${topic0}`);
  return log;
}

function configOf(logs: readonly RawLog[] = CORPUS.logs): IndexerConfig {
  const created = logs.find((log) => log.topics[0] === SESSION_CREATED);
  const registered = logs.find((log) => log.topics[0] === SESSION_REGISTERED);
  const committed = logs.find((log) => log.topics[0] === COMMITTED);
  if (created === undefined || registered === undefined || committed === undefined) {
    throw new Error('the stream is missing a singleton anchor');
  }
  return {
    factory: created.emitter,
    registry: registered.emitter,
    premium: committed.emitter,
  };
}

function word(value: bigint): string {
  const bits = value < 0n ? value + (1n << 256n) : value;
  return `0x${bits.toString(16).padStart(64, '0')}`;
}

function addressWord(address: string): string {
  return `0x${'0'.repeat(24)}${addressKey(address).slice(2)}`;
}

function withTopic0(log: RawLog, topic0: string): RawLog {
  const rest = log.topics.slice(1);
  return { ...log, topics: [topic0, ...rest] };
}

describe('the corpus folds into one settled session', () => {
  const config = configOf();
  const catalogue = foldLogs(CORPUS.logs, config);
  const session = catalogue.sessions[0];
  const created = firstWith(SESSION_CREATED);

  it('recovers exactly one session, one name and one print', () => {
    expect(catalogue.sessions).toHaveLength(1);
    expect(catalogue.names).toHaveLength(1);
    expect(catalogue.prints).toHaveLength(1);
  });

  it('attributes the session by the address SessionCreated revealed', () => {
    // The load-bearing link: `Settled` has no indexed parameter, so the emitting address is the
    // only attribution, and the factory's event is the only thing that reveals it. The corpus
    // renders one checksummed and the other lower-case.
    expect(created.emitter).toMatch(/[A-F]/);
    expect(session?.address).toBe('0xebaa350fe46c7b07170af86dd750752f1e0e5202');
    expect(sessionOf(catalogue, '0xEbaa350Fe46C7b07170af86dD750752F1e0E5202')?.address).toBe(
      session?.address,
    );
  });

  it('reads the listing parameters the factory recorded', () => {
    expect(session?.lamWad).toBe(15_000_000_000_000_000_000n);
    expect(session?.expiryTimestamp).toBe(1_800_063_000n);
    expect(session?.notionalCapWad).toBe(5_000_000_000_000n);
    expect(session?.salt).toHaveLength(66);
  });

  it('shows the session registered as part of listing (F93)', () => {
    expect(session?.registered).toBe(true);
    expect(session?.multiplier).toBe(1_000_000_000_000_000_000n);
  });

  it('reads the seed and the one trade', () => {
    expect(session?.pool).toEqual({
      longIn: 1_000_000_000_000n,
      shortIn: 200_000_000_000n,
      longReserve: 1_000_000_000_000n,
      shortReserve: 200_000_000_000n,
    });
    expect(session?.lastTrade?.boughtLong).toBe(true);
    expect(session?.lastTrade?.collateralIn).toBe(50_000_000_000n);
    expect(session?.shares?.longIn).toBe(1_000_000_000_000n);
    expect(session?.shares?.shortIn).toBe(200_000_000_000n);
  });

  it('settles on LivePrint at the instrument\u2019s own pricing primitive', () => {
    // gapWad = 2e16, payoffWad = 3e17 = min(λ·|G|, 1) = min(15 × 0.02, 1).
    expect(session?.resolution).toEqual({
      branch: 'LivePrint',
      gapWad: 20_000_000_000_000_000n,
      payoffWad: 300_000_000_000_000_000n,
      settled: true,
    });
    expect(session?.settlement).toEqual({
      payoffLongWad: 300_000_000_000_000_000n,
      staleReference: false,
    });
  });

  it('reads the print the registry accepted after the close', () => {
    expect(catalogue.prints[0]).toEqual({
      source: '0x0000000000000000000000000000000000005eed',
      priority: 1n,
      timestamp: 1_800_063_001n,
      gapWad: 20_000_000_000_000_000n,
      index: 0n,
    });
  });

  it('reads the premium commitment, the challenge and the ruling', () => {
    const name = catalogue.names[0];
    expect(name?.forSession).toBe(1n);
    expect(name?.lambdaWad).toBe(15_000_000_000_000_000_000n);
    expect(name?.premiumWad).toBe(174_000_000_000_000_000n);
    expect(name?.challenger).toBe('0x0000000000000000000000000000000000000c4a');
    expect(name?.publisherCorrect).toBe(true);
    expect(nameOf(catalogue, name?.nameId ?? '0x', 1n)).toBe(name);
  });
});

describe('the fold skips what it does not recognise', () => {
  const config = configOf();

  it('returns the empty catalogue for an empty stream', () => {
    expect(foldLogs([], config)).toBe(emptyCatalogue());
  });

  it('skips the ERC-20 traffic and still recovers the session', () => {
    expect(foldLogs(CORPUS.logs, config).sessions).toHaveLength(1);
  });

  it('skips a stranger whose topic0 is not even noise', () => {
    const stranger: RawLog = {
      topics: [UNKNOWN_TOPIC],
      data: '0x',
      emitter: '0x000000000000000000000000000000000000dEaD',
    };
    expect(foldLogs([stranger], config)).toBe(emptyCatalogue());
  });

  it('skips an unknown topic0 from a known role', () => {
    const factoryNoise = withTopic0(firstWith(SESSION_CREATED), UNKNOWN_TOPIC);
    expect(foldLogs([factoryNoise], config)).toBe(emptyCatalogue());
  });

  it('skips a known topic0 emitted by the wrong role', () => {
    // The factory's SessionCreated arriving from the registry classifies as registry, and the
    // taxonomy has no such row — which is the other half of keying by (role, topic0).
    const misplaced = { ...firstWith(SESSION_CREATED), emitter: config.registry };
    expect(foldLogs([misplaced], config)).toBe(emptyCatalogue());
  });

  it('skips a known-role log that has no topic0 at all', () => {
    const emptyTopics: RawLog = { topics: [], data: '0x', emitter: config.factory };
    expect(foldLogs([emptyTopics], config)).toBe(emptyCatalogue());
  });
});

describe('attribution is case-insensitive', () => {
  it('matches a lower-case config against the corpus\u2019s checksummed emitters', () => {
    const config = configOf();
    const folded = foldLogs(CORPUS.logs, {
      factory: config.factory.toLowerCase(),
      registry: config.registry.toLowerCase(),
      premium: config.premium.toLowerCase(),
    });
    expect(folded.sessions).toHaveLength(1);
  });
});

describe('the three singleton addresses must be distinct', () => {
  it('refuses a config that collapses two roles', () => {
    const config = configOf();
    expect(() => foldLogs([], { ...config, registry: config.factory })).toThrow(DomainError);
    expect(() => foldLogs([], { ...config, registry: config.factory })).toThrow(
      'must be three distinct addresses',
    );
  });
});

describe('a created session is visible before it is registered', () => {
  it('keeps the row and leaves registered false when SessionRegistered is absent', () => {
    const created = firstWith(SESSION_CREATED);
    const folded = foldLogs([created], configOf());
    expect(folded.sessions).toHaveLength(1);
    expect(folded.sessions[0]?.registered).toBe(false);
    expect(folded.sessions[0]?.multiplier).toBeUndefined();
    expect(folded.sessions[0]?.settlement).toBeUndefined();
  });
});

describe('events for a session the fold has not created are dropped', () => {
  const config = configOf();

  it('drops a registration whose session address is unknown', () => {
    expect(foldLogs([firstWith(SESSION_REGISTERED)], config)).toBe(emptyCatalogue());
  });

  it('drops a registry resolution whose session address is unknown', () => {
    expect(foldLogs([firstWith(REGISTRY_RESOLVED)], config)).toBe(emptyCatalogue());
  });
});

describe('name events for a commitment the fold has not seen are dropped', () => {
  const config = configOf();

  it('drops a challenge with no matching commit', () => {
    expect(foldLogs([firstWith(CHALLENGED)], config)).toBe(emptyCatalogue());
  });

  it('drops a premium resolution with no matching commit', () => {
    expect(foldLogs([firstWith(PREMIUM_RESOLVED)], config)).toBe(emptyCatalogue());
  });
});

describe('Deferred does not settle', () => {
  it('records the branch and leaves settlement absent', () => {
    const created = firstWith(SESSION_CREATED);
    const resolved = firstWith(REGISTRY_RESOLVED);
    const deferred: RawLog = {
      ...resolved,
      data: `${word(3n)}${word(0n).slice(2)}${word(0n).slice(2)}`,
    };
    const session = foldLogs([created, deferred], configOf()).sessions[0];
    expect(session?.resolution).toEqual({
      branch: 'Deferred',
      gapWad: 0n,
      payoffWad: 0n,
      settled: false,
    });
    expect(session?.settlement).toBeUndefined();
  });
});

describe('a second SessionCreated for the same address keeps later state', () => {
  it('does not wipe the registration the first pass recorded', () => {
    const created = firstWith(SESSION_CREATED);
    const folded = foldLogs([...CORPUS.logs, created], configOf());
    expect(folded.sessions[0]?.registered).toBe(true);
    expect(folded.sessions[0]?.resolution?.branch).toBe('LivePrint');
    expect(folded.sessions[0]?.pool?.longIn).toBe(1_000_000_000_000n);
  });
});

describe('two SessionCreated events are two rows', () => {
  it('keeps them in first-seen order', () => {
    const created = firstWith(SESSION_CREATED);
    const otherSession = '0x00000000000000000000000000000000000000aa';
    const second: RawLog = {
      ...created,
      topics: [SESSION_CREATED, addressWord(otherSession), created.topics[2] ?? word(0n)],
    };
    const folded = foldLogs([created, second], configOf());
    expect(folded.sessions.map((session) => session.address)).toEqual([
      '0xebaa350fe46c7b07170af86dd750752f1e0e5202',
      otherSession,
    ]);
  });
});

describe('decodeEvent refuses a descriptor it has no layout for', () => {
  it('names the role and the event', () => {
    const row = EVENTS[0];
    if (row === undefined) throw new Error('EVENTS is empty');
    const fake = { ...row, name: 'Nope' };
    expect(() => decodeEvent(fake, firstWith(SESSION_CREATED))).toThrow(DomainError);
    expect(() => decodeEvent(fake, firstWith(SESSION_CREATED))).toThrow(
      'no decoder for factory Nope',
    );
  });
});

describe('lookups miss cleanly', () => {
  it('returns undefined for a session or name the catalogue does not hold', () => {
    const empty = emptyCatalogue();
    expect(sessionOf(empty, '0x0000000000000000000000000000000000000001')).toBeUndefined();
    expect(nameOf(empty, `0x${'ab'.repeat(32)}`, 1n)).toBeUndefined();
  });

  it('cannot be populated by mutation', () => {
    expect(Object.isFrozen(emptyCatalogue())).toBe(true);
    expect(Object.isFrozen(emptyCatalogue().sessions)).toBe(true);
  });
});

describe('a print-only stream is still a catalogue', () => {
  it('holds the print and no session', () => {
    const folded = foldLogs([firstWith(PRINT_SUBMITTED)], configOf());
    expect(folded.sessions).toHaveLength(0);
    expect(folded.prints).toHaveLength(1);
    expect(folded).not.toBe(emptyCatalogue());
  });
});
