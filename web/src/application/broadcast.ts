/**
 * The broadcast use case.
 *
 * One function, three steps: connect the wallet, resolve the batch's targets, then send each step
 * in intent order. The intent order is load-bearing — `approve` precedes `buyLong`, `mintPair`
 * precedes `seedPool` — so the use case never reorders; it sends exactly the steps the domain
 * built, and a step that reverts on chain stops the batch where it is.
 *
 * **Target resolution is a read, not a guess.** The steps name roles (`collateral`, `session`,
 * `longClaim`, `shortClaim`, `premium`); the addresses are read from the chain — the session's
 * `collateral()`, `longClaim()` and `shortClaim()` getters, and the premium registry's `bondToken()`
 * for the challenge flow, whose bond is the registry's token rather than any session's. Only the
 * targets a batch actually references are read, once each. The use case never assumes an address it
 * could read, and it never reads an address it does not use.
 */

import {
  decodeAddressWord,
  encodeCalldata,
  fragmentOf,
  selectorOf,
} from '@bell/calibrator/domain/abi.js';
import { type Keccak } from '@bell/calibrator/domain/ports.js';

import { WebDomainError } from '../domain/errors.js';
import { type IntentBatch, type IntentTargetRole } from '../domain/intents.js';
import { type WalletProvider } from '../domain/ports.js';

/** The two addresses the use case is given; everything else it reads. Both are optional because a
 * batch references only what it needs — the challenge flow never touches a session — and a batch
 * that references a target whose address was not given is refused by name. */
export interface BroadcastTargets {
  /** The session the batch acts on, for every kind except `challenge`. */
  readonly session?: string;
  /** The premium registry, whose `bondToken()` is the challenge flow's collateral. */
  readonly premium?: string;
}

/** What a broadcast produced: the signing account and one hash per step, in step order. */
export interface BroadcastOutcome {
  readonly account: string;
  readonly hashes: readonly string[];
}

/** Broadcast every step of `batch`, returning the account and one hash per step. */
export async function broadcastIntents(
  batch: IntentBatch,
  targets: BroadcastTargets,
  wallet: WalletProvider,
  keccak: Keccak,
): Promise<BroadcastOutcome> {
  const account = await wallet.connect();
  const resolved = await resolveTargets(batch, targets, wallet, keccak);

  const hashes: string[] = [];
  for (const step of batch.steps) {
    const to = resolved[step.target];
    if (to === undefined) {
      throw new Error(`intent step targets ${step.target}, which the batch does not resolve`);
    }
    // An `approve` step names only the amount; the spender is the contract the batch acts on —
    // the session for trade/LP/claim/withdraw, the premium registry for the challenge bond.
    const args = step.method === 'approve' ? [actorOf(batch, resolved), ...step.args] : step.args;
    hashes.push(await wallet.send({ to, data: encodeCalldata(step.method, args, keccak) }));
  }
  return { account, hashes };
}

/** The contract that pulls tokens in an `approve` step: the batch's actor. */
function actorOf(
  batch: IntentBatch,
  resolved: Readonly<Record<IntentTargetRole, string | undefined>>,
): string {
  const actor = batch.kind === 'challenge' ? resolved.premium : resolved.session;
  if (actor === undefined) {
    throw new WebDomainError('approve step needs the batch actor, which is not resolved');
  }
  return actor;
}

/** The address of every target role the batch references, read once each. */
async function resolveTargets(
  batch: IntentBatch,
  targets: BroadcastTargets,
  wallet: WalletProvider,
  keccak: Keccak,
): Promise<Readonly<Record<IntentTargetRole, string | undefined>>> {
  const used = new Set<IntentTargetRole>(batch.steps.map((step) => step.target));
  const resolved: Record<IntentTargetRole, string | undefined> = {
    collateral: undefined,
    session: undefined,
    longClaim: undefined,
    shortClaim: undefined,
    premium: undefined,
  };

  if (used.has('session')) {
    if (targets.session === undefined) {
      throw new WebDomainError('session target used but no session address was given');
    }
    resolved.session = targets.session;
  }
  if (used.has('premium')) {
    if (targets.premium === undefined) {
      throw new WebDomainError('premium target used but no premium address was given');
    }
    resolved.premium = targets.premium;
  }
  if (used.has('collateral')) {
    // The challenge bond is the registry's token, not any session's collateral.
    if (batch.kind === 'challenge') {
      if (targets.premium === undefined) {
        throw new WebDomainError('collateral target used but no premium address was given');
      }
      resolved.collateral = await readAddress(wallet, targets.premium, 'bondToken', keccak);
    } else {
      if (targets.session === undefined) {
        throw new WebDomainError('collateral target used but no session address was given');
      }
      resolved.collateral = await readAddress(wallet, targets.session, 'collateral', keccak);
    }
  }
  if (used.has('longClaim')) {
    if (targets.session === undefined) {
      throw new WebDomainError('longClaim target used but no session address was given');
    }
    resolved.longClaim = await readAddress(wallet, targets.session, 'longClaim', keccak);
  }
  if (used.has('shortClaim')) {
    if (targets.session === undefined) {
      throw new WebDomainError('shortClaim target used but no session address was given');
    }
    resolved.shortClaim = await readAddress(wallet, targets.session, 'shortClaim', keccak);
  }
  return resolved;
}

/** Read one zero-argument `address` getter and decode its result word. */
async function readAddress(
  wallet: WalletProvider,
  at: string,
  method: string,
  keccak: Keccak,
): Promise<string> {
  const word = await wallet.read(at, selectorOf(fragmentOf(method), keccak));
  return decodeAddressWord(word);
}
