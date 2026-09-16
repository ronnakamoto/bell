/**
 * The layouts the fold applies, one per recognised event.
 *
 * The taxonomy says *which* event a `(role, topic0)` pair is; this module says *how to read it*.
 * Splitting them is load-bearing rather than tidy: a table of hashes cannot also be a table of
 * accessors without making every new event a two-site edit that looks like one, and the two
 * `Resolved`s would share a name in that table for the exact reason they must not share a decoder.
 *
 * **A descriptor this module has no layout for is a refusal.** A row added to `EVENTS` without a
 * decoder here must not file itself as whichever event the default happened to be — the same
 * fail-open shape `branchFromCode` refuses with an out-of-range ordinal.
 */

import { DomainError } from '@bell/calibrator/domain/models.js';

import {
  addressOfTopic,
  addressOfWord,
  boolOf,
  bytes32OfTopic,
  emitterKey,
  intOf,
  topicAt,
  uint64Of,
  uintOf,
  wordAt,
  type AddressKey,
  type RawLog,
  type Word,
} from './log.js';
import { type EventDescriptor } from './taxonomy.js';

/** One decoded protocol event. The two `Resolved`s are distinct members, never one name. */
export type ProtocolEvent =
  | {
      readonly kind: 'SessionCreated';
      readonly session: AddressKey;
      readonly referenceToken: AddressKey;
      readonly lamWad: bigint;
      readonly expiryTimestamp: bigint;
      readonly capWad: bigint;
      readonly notionalCapWad: bigint;
      readonly salt: Word;
    }
  | {
      readonly kind: 'SessionRegistered';
      readonly session: AddressKey;
      readonly referenceToken: AddressKey;
      readonly lamWad: bigint;
      readonly multiplier: bigint;
    }
  | {
      readonly kind: 'PoolSeeded';
      readonly emitter: AddressKey;
      readonly longIn: bigint;
      readonly shortIn: bigint;
      readonly longReserve: bigint;
      readonly shortReserve: bigint;
    }
  | {
      readonly kind: 'PoolSharesMinted';
      readonly emitter: AddressKey;
      readonly provider: AddressKey;
      readonly shares: bigint;
      readonly longIn: bigint;
      readonly shortIn: bigint;
    }
  | {
      readonly kind: 'Traded';
      readonly emitter: AddressKey;
      readonly trader: AddressKey;
      readonly boughtLong: boolean;
      readonly collateralIn: bigint;
      readonly claimOut: bigint;
    }
  | {
      readonly kind: 'Settled';
      readonly emitter: AddressKey;
      readonly payoffLongWad: bigint;
      readonly staleReference: boolean;
    }
  | {
      readonly kind: 'PrintSubmitted';
      readonly source: AddressKey;
      readonly priority: bigint;
      readonly timestamp: bigint;
      readonly gapWad: bigint;
      readonly index: bigint;
    }
  | {
      readonly kind: 'RegistryResolved';
      readonly session: AddressKey;
      readonly branchCode: bigint;
      readonly gapWad: bigint;
      readonly payoffWad: bigint;
    }
  | {
      readonly kind: 'Committed';
      readonly nameId: Word;
      readonly forSession: bigint;
      readonly lambdaWad: bigint;
      readonly premiumWad: bigint;
      readonly inputsHash: Word;
      readonly digest: Word;
      readonly bond: bigint;
    }
  | {
      readonly kind: 'Challenged';
      readonly nameId: Word;
      readonly forSession: bigint;
      readonly challenger: AddressKey;
    }
  | {
      readonly kind: 'PremiumResolved';
      readonly nameId: Word;
      readonly forSession: bigint;
      readonly publisherCorrect: boolean;
      readonly transferred: bigint;
    };

/** Decode a recognised event, refusing a descriptor this module has no layout for. */
export function decodeEvent(descriptor: EventDescriptor, log: RawLog): ProtocolEvent {
  const { role, name } = descriptor;
  if (role === 'factory' && name === 'SessionCreated') {
    return {
      kind: 'SessionCreated',
      session: addressOfTopic(log, 1),
      referenceToken: addressOfTopic(log, 2),
      lamWad: uintOf(wordAt(log, 0)),
      expiryTimestamp: uintOf(wordAt(log, 1)),
      capWad: uintOf(wordAt(log, 2)),
      notionalCapWad: uintOf(wordAt(log, 3)),
      salt: wordAt(log, 4),
    };
  }
  if (role === 'registry' && name === 'SessionRegistered') {
    return {
      kind: 'SessionRegistered',
      session: addressOfTopic(log, 1),
      referenceToken: addressOfTopic(log, 2),
      lamWad: uintOf(wordAt(log, 0)),
      multiplier: uintOf(wordAt(log, 1)),
    };
  }
  if (role === 'registry' && name === 'PrintSubmitted') {
    return {
      kind: 'PrintSubmitted',
      source: addressOfTopic(log, 1),
      priority: uint64Of(wordAt(log, 0)),
      timestamp: uint64Of(wordAt(log, 1)),
      gapWad: intOf(wordAt(log, 2)),
      index: uintOf(wordAt(log, 3)),
    };
  }
  if (role === 'registry' && name === 'Resolved') {
    return {
      kind: 'RegistryResolved',
      session: addressOfTopic(log, 1),
      branchCode: uintOf(wordAt(log, 0)),
      gapWad: intOf(wordAt(log, 1)),
      payoffWad: uintOf(wordAt(log, 2)),
    };
  }
  if (role === 'session' && name === 'PoolSeeded') {
    return {
      kind: 'PoolSeeded',
      emitter: emitterKey(log),
      longIn: uintOf(wordAt(log, 0)),
      shortIn: uintOf(wordAt(log, 1)),
      longReserve: uintOf(wordAt(log, 2)),
      shortReserve: uintOf(wordAt(log, 3)),
    };
  }
  if (role === 'session' && name === 'PoolSharesMinted') {
    return {
      kind: 'PoolSharesMinted',
      emitter: emitterKey(log),
      provider: addressOfTopic(log, 1),
      shares: uintOf(wordAt(log, 0)),
      longIn: uintOf(wordAt(log, 1)),
      shortIn: uintOf(wordAt(log, 2)),
    };
  }
  if (role === 'session' && name === 'Traded') {
    return {
      kind: 'Traded',
      emitter: emitterKey(log),
      trader: addressOfTopic(log, 1),
      boughtLong: boolOf(wordAt(log, 0)),
      collateralIn: uintOf(wordAt(log, 1)),
      claimOut: uintOf(wordAt(log, 2)),
    };
  }
  if (role === 'session' && name === 'Settled') {
    return {
      kind: 'Settled',
      emitter: emitterKey(log),
      payoffLongWad: uintOf(wordAt(log, 0)),
      staleReference: boolOf(wordAt(log, 1)),
    };
  }
  if (role === 'premium' && name === 'Committed') {
    return {
      kind: 'Committed',
      nameId: bytes32OfTopic(log, 1),
      forSession: uint64Of(topicAt(log, 2)),
      lambdaWad: uintOf(wordAt(log, 0)),
      premiumWad: uintOf(wordAt(log, 1)),
      inputsHash: wordAt(log, 2),
      digest: wordAt(log, 3),
      bond: uintOf(wordAt(log, 4)),
    };
  }
  if (role === 'premium' && name === 'Challenged') {
    return {
      kind: 'Challenged',
      nameId: bytes32OfTopic(log, 1),
      forSession: uint64Of(topicAt(log, 2)),
      challenger: addressOfWord(log, 0),
    };
  }
  if (role === 'premium' && name === 'Resolved') {
    return {
      kind: 'PremiumResolved',
      nameId: bytes32OfTopic(log, 1),
      forSession: uint64Of(topicAt(log, 2)),
      publisherCorrect: boolOf(wordAt(log, 0)),
      transferred: uintOf(wordAt(log, 1)),
    };
  }
  throw new DomainError(`no decoder for ${role} ${name}`);
}
