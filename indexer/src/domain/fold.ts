/**
 * The fold: a stream of raw logs into a catalogue.
 *
 * A log arrives attributed only by its emitting address and its topic0. The taxonomy keys events by
 * `(role, topic0)` and never by name — `Resolved` is two events — and session events carry no
 * session identifier at all, so the fold has to learn the session role from `SessionCreated` before
 * it can attribute `PoolSeeded`, `Traded` or `Settled`. An emitter compared without normalisation
 * would fail that attribution on case alone and produce a quietly empty catalogue (see `log.ts`).
 *
 * **A miss is not an error.** The corpus is 29 logs, of which 18 are ERC-20 `Transfer`/`Approval`
 * and 11 are protocol events. Refusing a stream because it contains a token transfer would make the
 * indexer unusable against a real chain. An unknown topic0 from a known role is the same shape: a
 * later protocol event this build has never seen, skipped rather than fatal. The caller that wants
 * to know a topic was skipped reads `IGNORED_TOPICS` itself; the fold does not report noise.
 *
 * **`Deferred` does not settle.** The registry emits `Resolved` on every branch, including the one
 * that skips `settle`. Reading "a `Resolved` was emitted" as "the session resolved" puts a
 * `payoffWad` of zero into the catalogue and reports a settled session that has not settled. The
 * record's `settled` flag is `settlesSession(branch)`, captured here.
 */

import { DomainError } from '@bell/calibrator/domain/models.js';

import { branchFromCode, settlesSession } from './branch.js';
import {
  type Catalogue,
  emptyCatalogue,
  type NameRecord,
  type PrintRecord,
  type SessionRecord,
} from './catalogue.js';
import { decodeEvent, type ProtocolEvent } from './decode.js';
import { type AddressKey, addressKey, emitterKey, type RawLog, topicAt, type Word } from './log.js';
import { type IndexerConfig } from './ports.js';
import { describeEvent, type EmitterRole } from './taxonomy.js';

interface Addresses {
  readonly factory: AddressKey;
  readonly registry: AddressKey;
  readonly premium: AddressKey;
}

function roleOf(
  emitter: AddressKey,
  addresses: Addresses,
  sessions: Set<AddressKey>,
): EmitterRole | undefined {
  if (emitter === addresses.factory) return 'factory';
  if (emitter === addresses.registry) return 'registry';
  if (emitter === addresses.premium) return 'premium';
  if (sessions.has(emitter)) return 'session';
  return undefined;
}

function nameKey(nameId: Word, forSession: bigint): string {
  return `${nameId}:${forSession.toString()}`;
}

function applyEvent(
  event: ProtocolEvent,
  sessions: Map<AddressKey, SessionRecord>,
  names: Map<string, NameRecord>,
  prints: PrintRecord[],
): void {
  switch (event.kind) {
    case 'SessionCreated': {
      const current = sessions.get(event.session);
      sessions.set(event.session, {
        address: event.session,
        referenceToken: event.referenceToken,
        lamWad: event.lamWad,
        expiryTimestamp: event.expiryTimestamp,
        capWad: event.capWad,
        notionalCapWad: event.notionalCapWad,
        salt: event.salt,
        registered: current?.registered ?? false,
        multiplier: current?.multiplier,
        pool: current?.pool,
        shares: current?.shares,
        lastTrade: current?.lastTrade,
        settlement: current?.settlement,
        resolution: current?.resolution,
      });
      return;
    }
    case 'SessionRegistered': {
      const current = sessions.get(event.session);
      if (current === undefined) return;
      sessions.set(event.session, {
        ...current,
        registered: true,
        multiplier: event.multiplier,
      });
      return;
    }
    case 'PoolSeeded': {
      const current = sessions.get(event.emitter);
      // Role `session` is assigned only to emitters already in this map, so the miss is
      // unreachable by construction. Hinted rather than tested, for the reason the depth
      // guards in `domain/` are: the only test that could reach it would classify a
      // stranger as a session.
      /* v8 ignore next 2 */
      if (current === undefined) return;
      sessions.set(event.emitter, {
        ...current,
        pool: {
          longIn: event.longIn,
          shortIn: event.shortIn,
          longReserve: event.longReserve,
          shortReserve: event.shortReserve,
        },
      });
      return;
    }
    case 'PoolSharesMinted': {
      const current = sessions.get(event.emitter);
      /* v8 ignore next 2 */
      if (current === undefined) return;
      sessions.set(event.emitter, {
        ...current,
        shares: {
          provider: event.provider,
          shares: event.shares,
          longIn: event.longIn,
          shortIn: event.shortIn,
        },
      });
      return;
    }
    case 'Traded': {
      const current = sessions.get(event.emitter);
      /* v8 ignore next 2 */
      if (current === undefined) return;
      sessions.set(event.emitter, {
        ...current,
        lastTrade: {
          trader: event.trader,
          boughtLong: event.boughtLong,
          collateralIn: event.collateralIn,
          claimOut: event.claimOut,
        },
      });
      return;
    }
    case 'Settled': {
      const current = sessions.get(event.emitter);
      /* v8 ignore next 2 */
      if (current === undefined) return;
      sessions.set(event.emitter, {
        ...current,
        settlement: {
          payoffLongWad: event.payoffLongWad,
          staleReference: event.staleReference,
        },
      });
      return;
    }
    case 'PrintSubmitted': {
      prints.push({
        source: event.source,
        priority: event.priority,
        timestamp: event.timestamp,
        gapWad: event.gapWad,
        index: event.index,
      });
      return;
    }
    case 'RegistryResolved': {
      const current = sessions.get(event.session);
      if (current === undefined) return;
      const branch = branchFromCode(event.branchCode);
      sessions.set(event.session, {
        ...current,
        resolution: {
          branch,
          gapWad: event.gapWad,
          payoffWad: event.payoffWad,
          settled: settlesSession(branch),
        },
      });
      return;
    }
    case 'Committed': {
      names.set(nameKey(event.nameId, event.forSession), {
        nameId: event.nameId,
        forSession: event.forSession,
        lambdaWad: event.lambdaWad,
        premiumWad: event.premiumWad,
        inputsHash: event.inputsHash,
        digest: event.digest,
        bond: event.bond,
        challenger: undefined,
        publisherCorrect: undefined,
        transferred: undefined,
      });
      return;
    }
    case 'Challenged': {
      const key = nameKey(event.nameId, event.forSession);
      const current = names.get(key);
      if (current === undefined) return;
      names.set(key, { ...current, challenger: event.challenger });
      return;
    }
    case 'PremiumResolved': {
      const key = nameKey(event.nameId, event.forSession);
      const current = names.get(key);
      if (current === undefined) return;
      names.set(key, {
        ...current,
        publisherCorrect: event.publisherCorrect,
        transferred: event.transferred,
      });
    }
  }
}

/**
 * Fold `logs` into a catalogue, under the three singleton addresses in `config`.
 *
 * The three addresses must be distinct. If the factory and the registry were the same address,
 * `SessionCreated` and `SessionRegistered` would both classify under one role and the other half
 * of the taxonomy would never match — a silently thinner catalogue, which is the failure this
 * refusal exists to make loud.
 */
export function foldLogs(logs: readonly RawLog[], config: IndexerConfig): Catalogue {
  const addresses: Addresses = {
    factory: addressKey(config.factory),
    registry: addressKey(config.registry),
    premium: addressKey(config.premium),
  };
  if (new Set([addresses.factory, addresses.registry, addresses.premium]).size !== 3) {
    throw new DomainError('factory, registry and premium must be three distinct addresses');
  }

  const sessions = new Map<AddressKey, SessionRecord>();
  const names = new Map<string, NameRecord>();
  const prints: PrintRecord[] = [];

  for (const log of logs) {
    const emitter = emitterKey(log);
    const role = roleOf(emitter, addresses, new Set(sessions.keys()));
    if (role === undefined) continue;
    if (log.topics[0] === undefined) continue;
    const descriptor = describeEvent(role, topicAt(log, 0));
    if (descriptor === undefined) continue;
    applyEvent(decodeEvent(descriptor, log), sessions, names, prints);
  }

  if (sessions.size === 0 && names.size === 0 && prints.length === 0) {
    return emptyCatalogue();
  }
  return {
    sessions: [...sessions.values()],
    names: [...names.values()],
    prints,
  };
}
