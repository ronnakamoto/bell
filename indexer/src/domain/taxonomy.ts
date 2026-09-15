/**
 * The events the indexer recognises, and the two facts that decide how they are keyed.
 *
 * **Keyed by (emitting role, `topic0`), never by name.** `Resolved` is emitted by two contracts with
 * different signatures — `PremiumStore.Resolved(bytes32,uint64,bool,uint256)` and
 * `ReferenceRegistry.Resolved(address,uint8,int256,uint256)` — so a table keyed by name would have to
 * choose one and would silently decode the other's payload against the wrong layout. The two topic0
 * values are unrelated (`0xccb43d23…` and `0x0c6d8354…`), and the two emitters are different
 * contracts, so either half of the key alone would separate them. Both are used because each half
 * catches a different mistake: the topic catches a payload read against the wrong signature, and the
 * role catches a topic that is correct but arrives from a contract that should not have emitted it.
 *
 * **`role` is not the same thing as an address.** The factory, the registry and the premium store are
 * three addresses the indexer is configured with, so a role resolves to an address directly. `session`
 * is not: a session's address is discovered, and it is discovered *from* `SessionCreated`. The four
 * events in that role carry no session identifier in their payload — `PoolSeeded` and `Settled` have no
 * indexed parameters at all — so they can only be attributed to a session by the address that emitted
 * them, and only once that address is known. A decoder that tried to read a session out of a `Traded`
 * payload would find nothing to read.
 *
 * **The signature is stored so that the hash can be checked, and the hash is stored because the domain
 * may not compute it.** `domain/` may not depend on a hashing library (§7.4/R5.1), so a table of bare
 * topic0 values would be unverifiable — three hand-typed copies of the same fact, agreeing with each
 * other and with nothing else. Carrying the canonical signature beside the hash is what makes the
 * verification possible at all, and the test that performs it does so against the *compiled* ABI
 * rather than against the string here, so the compiler is the authority and this file is a claim.
 */

import { type Word } from './log.js';

/**
 * Which contract emitted a log.
 *
 * Three roles are singletons the indexer is configured with; `session` is a family of addresses it
 * learns. See the module comment.
 */
export type EmitterRole = 'factory' | 'registry' | 'premium' | 'session';

/** One recognised event. */
export interface EventDescriptor {
  /** The Solidity event name. Not unique across the table — see the module comment. */
  readonly name: string;
  /** The canonical signature, as Solidity declares it. */
  readonly signature: string;
  /** `keccak256(signature)`, as `0x`-prefixed lower-case hex. */
  readonly topic0: Word;
  /** The contract that emits it. */
  readonly role: EmitterRole;
}

/**
 * Every event the indexer recognises, in the order a session's life produces them.
 *
 * The order is not load-bearing — the fold reads the stream it is given — but it is the order the log
 * corpus emits, so a reader can put the two side by side.
 */
export const EVENTS: readonly EventDescriptor[] = [
  {
    name: 'SessionCreated',
    signature: 'SessionCreated(address,address,uint256,uint256,uint256,uint256,bytes32)',
    topic0: '0xbfea4ffed12dea0f10d6ed0862b3b921c451b49a70efdd3461d7423842282b00',
    role: 'factory',
  },
  {
    name: 'SessionRegistered',
    signature: 'SessionRegistered(address,address,uint256,uint256)',
    topic0: '0x28e487a6111e0cb65c7a6ef4ffc45a36e06b481fb2cf18dbde02b4c88e6aee67',
    role: 'registry',
  },
  {
    name: 'PoolSeeded',
    signature: 'PoolSeeded(uint256,uint256,uint256,uint256)',
    topic0: '0x5d429557f34c498cc29db4d2e2663bee1f80a8df8a3aace3a0166eccfcda58f4',
    role: 'session',
  },
  {
    name: 'PoolSharesMinted',
    signature: 'PoolSharesMinted(address,uint256,uint256,uint256)',
    topic0: '0x95e4a35c0df72af0238f12e367c496662dd91ddfc1f9b47c8d790fea45db451d',
    role: 'session',
  },
  {
    name: 'Traded',
    signature: 'Traded(address,bool,uint256,uint256)',
    topic0: '0xe0fb27516feded5e3f21f529eade84ca557938ea6057dbe783ea6668d381b24e',
    role: 'session',
  },
  {
    name: 'Committed',
    signature: 'Committed(bytes32,uint64,uint256,uint256,bytes32,bytes32,uint256)',
    topic0: '0x8c8ec3404e0fe9635c7532cb2fabce3bb5e9f7e539e917ac8765bbea6a7696d8',
    role: 'premium',
  },
  {
    name: 'Challenged',
    signature: 'Challenged(bytes32,uint64,address)',
    topic0: '0xc99902c2119795819e8b34976cebd598b20d8f830b5fc11747981c2291b4709c',
    role: 'premium',
  },
  {
    name: 'Resolved',
    signature: 'Resolved(bytes32,uint64,bool,uint256)',
    topic0: '0xccb43d232ecfb3b83994d0f1802b813e25ff21e10e43fe5db91badffbc8562ee',
    role: 'premium',
  },
  {
    name: 'PrintSubmitted',
    signature: 'PrintSubmitted(address,uint64,uint64,int256,uint256)',
    topic0: '0xf0ac8e5d645b0d54c6e4b31d0d9f68717549d4abe63668ec57fd7ae52e5842a2',
    role: 'registry',
  },
  {
    name: 'Settled',
    signature: 'Settled(uint256,bool)',
    topic0: '0x0e041c951edff06117fdd303d596231ad03cde5b01f3234cc0503228f50d60d9',
    role: 'session',
  },
  {
    name: 'Resolved',
    signature: 'Resolved(address,uint8,int256,uint256)',
    topic0: '0x0c6d8354f459342131b6839d702bdf8ef15df4d9eb0b52f3d3d6f081dfa526fb',
    role: 'registry',
  },
];

/**
 * The ERC-20 events a session's neighbourhood produces and the indexer must ignore.
 *
 * Named rather than left to the unknown-topic path, because the two are different situations and a
 * diagnostic should say which: a `Transfer` from the collateral or a claim token is traffic the
 * indexer deliberately does not follow, while a topic0 in neither table is a protocol event this
 * build has never seen — which is the one worth reporting.
 *
 * They are three quarters of the log corpus by count: 15 of its 29 records are `Transfer` and 3 are
 * `Approval`. A fold that mistook them for protocol events would be dominated by them.
 */
export const IGNORED_TOPICS: ReadonlySet<string> = new Set([
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
]);

/**
 * The descriptor for a log emitted by `role`, or `undefined` if this build does not recognise it.
 *
 * A miss is not an error. A log stream is a superset of the protocol's events — the corpus is
 * evidence, not an assumption — and refusing to fold a stream because it contains a token transfer
 * would make the indexer unusable against a real chain. The caller decides whether a miss is noise or
 * a gap; `IGNORED_TOPICS` is what lets it tell the two apart.
 */
export function describeEvent(role: EmitterRole, topic0: Word): EventDescriptor | undefined {
  return EVENTS.find((event) => event.role === role && event.topic0 === topic0);
}

/** Every event a session's own contract emits, which is the set `role === 'session'` names. */
export const SESSION_EVENTS: readonly EventDescriptor[] = EVENTS.filter(
  (event) => event.role === 'session',
);
