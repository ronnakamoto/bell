/**
 * The taxonomy, verified against two authorities that cannot both be wrong in the same direction.
 *
 * **The first is `keccak256` of the canonical signature.** Every row carries its signature beside its
 * topic0 precisely so this can be checked; a table of bare hashes would be unverifiable, and the
 * reason the domain stores both is that `domain/` may not compute a hash. This check is what makes the
 * signature column load-bearing rather than decorative — and it caught a truncated topic0 in
 * `PrintSubmitted` while this file was being written, which is the failure it exists for: a
 * hand-transcribed 64-digit string that is 60 digits long looks like every other row.
 *
 * **The second is the log corpus, which is the compiled ABI's evidence.** `spec/fixtures/logs.json` was
 * emitted by the contracts, so if a signature here were spelled wrongly — a `uint256` where the
 * contract declares a `uint64` — the corpus's topic0 for that event would not be in the table and the
 * classification test below would fail. That is a stronger check than reading the signature out of the
 * ABI, because it compares against what the contracts *did* rather than against what they say.
 *
 * The structural claims the taxonomy makes are asserted rather than described: the four roles are four
 * distinct addresses, `Resolved` is two events rather than one, and every protocol log in the corpus
 * classifies under the role its emitter belongs to.
 */

import { readFileSync } from 'node:fs';

import { hexOf } from '@bell/calibrator/domain/bytes.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';

import { type RawLog } from '../../src/domain/log.js';
import {
  describeEvent,
  type EmitterRole,
  EVENTS,
  IGNORED_TOPICS,
  SESSION_EVENTS,
} from '../../src/domain/taxonomy.js';

interface Fixture {
  readonly logs: readonly RawLog[];
}

const CORPUS: Fixture = JSON.parse(
  readFileSync(new URL('../../../spec/fixtures/logs.json', import.meta.url), 'utf8'),
) as Fixture;

const SESSION_CREATED = '0xbfea4ffed12dea0f10d6ed0862b3b921c451b49a70efdd3461d7423842282b00';
const SESSION_REGISTERED = '0x28e487a6111e0cb65c7a6ef4ffc45a36e06b481fb2cf18dbde02b4c88e6aee67';
const COMMITTED = '0x8c8ec3404e0fe9635c7532cb2fabce3bb5e9f7e539e917ac8765bbea6a7696d8';
const SETTLED = '0x0e041c951edff06117fdd303d596231ad03cde5b01f3234cc0503228f50d60d9';

function topic0Of(signature: string): string {
  return `0x${hexOf(keccak_256(new TextEncoder().encode(signature)))}`;
}

/**
 * The four role addresses, each read from an event only that role emits.
 *
 * Derived rather than hard-coded, because a hard-coded address would make the classification test pass
 * for the wrong reason if the corpus were regenerated: the addresses move when the contracts change
 * (they are CREATE2-derived; see `DESIGN_NOTES.md` F95) and a stale literal would classify nothing.
 */
function roleAddresses(): Map<EmitterRole, string> {
  const anchors: readonly (readonly [EmitterRole, string])[] = [
    ['factory', SESSION_CREATED],
    ['registry', SESSION_REGISTERED],
    ['premium', COMMITTED],
    ['session', SETTLED],
  ];
  const roles = new Map<EmitterRole, string>();
  for (const [role, topic0] of anchors) {
    const log = CORPUS.logs.find((candidate) => candidate.topics[0] === topic0);
    if (log === undefined) throw new Error(`the corpus has no ${role} anchor (${topic0})`);
    roles.set(role, log.emitter.toLowerCase());
  }
  return roles;
}

describe('every topic0 is keccak256 of the signature the row declares', () => {
  // One test per row rather than `it.each`, so a failure names the event that is wrong instead of an
  // index into a table.
  for (const event of EVENTS) {
    it(`${event.name} (${event.role})`, () => {
      expect(topic0Of(event.signature)).toBe(event.topic0);
    });
  }

  it('has no duplicate (role, topic0) pair', () => {
    const keys = EVENTS.map((event) => `${event.role}:${event.topic0}`);
    expect(new Set(keys).size).toBe(EVENTS.length);
  });

  it('has a name that is deliberately not unique', () => {
    // `Resolved` twice, and that is the fact the whole key is shaped around. If this ever becomes
    // unique, the reason for keying by (role, topic0) has gone and the comment above should say so.
    const names = EVENTS.map((event) => event.name);
    expect(new Set(names).size).toBe(EVENTS.length - 1);
    expect(names.filter((name) => name === 'Resolved')).toHaveLength(2);
  });
});

describe('the two Resolved events are distinguished by both halves of the key', () => {
  const premium = EVENTS.find((event) => event.role === 'premium' && event.name === 'Resolved');
  const registry = EVENTS.find((event) => event.role === 'registry' && event.name === 'Resolved');

  it('declares both, from different contracts', () => {
    expect(premium).toBeDefined();
    expect(registry).toBeDefined();
    expect(premium?.signature).toBe('Resolved(bytes32,uint64,bool,uint256)');
    expect(registry?.signature).toBe('Resolved(address,uint8,int256,uint256)');
    expect(premium?.topic0).not.toBe(registry?.topic0);
  });

  it('resolves each under its own role and neither under the other', () => {
    expect(describeEvent('premium', premium?.topic0 ?? '')?.name).toBe('Resolved');
    expect(describeEvent('registry', registry?.topic0 ?? '')?.name).toBe('Resolved');
    expect(describeEvent('registry', premium?.topic0 ?? '')).toBeUndefined();
    expect(describeEvent('premium', registry?.topic0 ?? '')).toBeUndefined();
  });
});

describe('the corpus classifies under the roles its emitters belong to', () => {
  const roles = roleAddresses();

  it('finds four distinct addresses, one per role', () => {
    expect(roles.size).toBe(4);
    expect(new Set(roles.values()).size).toBe(4);
    expect(new Set(CORPUS.logs.map((log) => log.emitter.toLowerCase())).size).toBe(7);
  });

  it('recognises every protocol log, and no protocol log comes from a stranger', () => {
    const addressToRole = new Map([...roles].map(([role, address]) => [address, role]));
    let protocol = 0;
    let ignored = 0;
    for (const log of CORPUS.logs) {
      const topic0 = log.topics[0] ?? '';
      const role = addressToRole.get(log.emitter.toLowerCase());
      if (role === undefined) {
        // Not a contract the indexer tracks: the collateral and the two claim tokens. Their traffic is
        // the noise the fold must skip, and it must be *identifiable* as noise rather than merely
        // unrecognised -- that is what `IGNORED_TOPICS` is for.
        expect(IGNORED_TOPICS.has(topic0)).toBe(true);
        ignored += 1;
        continue;
      }
      expect(describeEvent(role, topic0)).toBeDefined();
      expect(IGNORED_TOPICS.has(topic0)).toBe(false);
      protocol += 1;
    }
    expect(protocol).toBe(11);
    expect(ignored).toBe(18);
  });

  it('carries every event the table declares', () => {
    const present = new Set(CORPUS.logs.map((log) => log.topics[0]));
    const missing = EVENTS.filter((event) => !present.has(event.topic0));
    expect(missing.map((event) => `${event.role}:${event.name}`)).toStrictEqual([]);
  });
});

describe('the session role is the one that cannot be resolved to an address up front', () => {
  it('holds the four events that carry no session identifier', () => {
    // `PoolSeeded(uint256,uint256,uint256,uint256)` and `Settled(uint256,bool)` have no indexed
    // parameter at all, so nothing in the payload names a session -- and the two that do have an
    // indexed parameter (`PoolSharesMinted`, `Traded`) index a provider and a trader, not a session.
    // The role, and not a field, is what carries the attribution.
    expect(SESSION_EVENTS.map((event) => event.name)).toStrictEqual([
      'PoolSeeded',
      'PoolSharesMinted',
      'Traded',
      'Settled',
    ]);
  });

  it('is discovered from the factory\u2019s event and from nothing else', () => {
    // The factory is the only role that emits one event, and its first parameter is the session
    // address -- which is what makes the session role resolvable at all. Every other role is an
    // address the indexer is configured with; this one is learned.
    const factoryEvents = EVENTS.filter((event) => event.role === 'factory');
    expect(factoryEvents.map((event) => event.name)).toStrictEqual(['SessionCreated']);
    expect(factoryEvents[0]?.signature).toBe(
      'SessionCreated(address,address,uint256,uint256,uint256,uint256,bytes32)',
    );
  });
});

describe('the ignored topics are the ERC-20 pair', () => {
  it('names Transfer and Approval and nothing else', () => {
    expect([...IGNORED_TOPICS].sort()).toStrictEqual(
      [
        topic0Of('Transfer(address,address,uint256)'),
        topic0Of('Approval(address,address,uint256)'),
      ].sort(),
    );
  });

  it('is three fifths of the corpus by count', () => {
    const counts = new Map<string, number>();
    for (const log of CORPUS.logs) {
      const topic0 = log.topics[0] ?? '';
      counts.set(topic0, (counts.get(topic0) ?? 0) + 1);
    }
    const noise = [...IGNORED_TOPICS].reduce(
      (total, topic0) => total + (counts.get(topic0) ?? 0),
      0,
    );
    expect(noise).toBe(18);
    expect(CORPUS.logs.length).toBe(29);
  });
});
