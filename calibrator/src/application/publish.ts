/**
 * The publish use case: commit a parameter set before the session it describes opens.
 *
 * The rule this exists to enforce is the contract's, restated on the off-chain side so a publisher
 * finds out before spending a bond rather than after. `PremiumRegistry.commit` reverts
 * `SessionAlreadyOpen(forSession, current)` when `forSession <= currentSession`, and this refuses the
 * same case for the same reason: the whole point of the commitment is that it was made before the
 * outcome was known, and a publisher that could wait to see the open would not need to fit anything.
 *
 * The commitment is delegated to a port. `ParameterPublisher` is declared in the domain, so this layer
 * sequences the call without knowing whether it lands on a chain, on a file, or nowhere.
 *
 * **Three departures from the Python, all of them forced and all of them stated.**
 *
 * 1. **`publish` is `async`.** The Python's `ParameterPublisher.publish` returns `str` synchronously,
 *    which is honest for its only implementation — a recording double in a test — and wrong for the
 *    real one, which posts a transaction. The port's other outward-facing ports already return
 *    promises (`GapSource.dailyBars`, `CommittedInputStore.rowsDigest`), so the port matches them
 *    rather than the Python. The refusal path still returns without awaiting anything, which is what
 *    the "the publisher is not called on a refusal" test is about.
 * 2. **`current_session` is an options object rather than a keyword-only argument.** TypeScript has no
 *    keyword-only parameters; `publish(request, publisher, keccak, { currentSession })` keeps the call
 *    site readable at the one position where a bare `10n` would be ambiguous against `forSession`.
 * 3. **The session counter is a `bigint`.** It is a `uint64` on chain — `PremiumRegistry` compares it
 *    against a `uint64` current session — and it is passed straight to `commitmentDigest`, which
 *    already takes a `bigint`. A `number` here would be a value that is exact in the tests and
 *    silently rounded at the boundary the tests do not reach.
 */

import { commitmentDigest, nameId } from '../domain/digest.js';
import { type ParameterSet } from '../domain/models.js';
import { type Keccak, type ParameterPublisher } from '../domain/ports.js';

/** Thrown by the publish use case when it refuses its input. */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

/** What to publish, and for which session. */
export class PublishRequest {
  readonly parameters: ParameterSet;
  readonly forSession: bigint;

  constructor(fields: { parameters: ParameterSet; forSession: bigint }) {
    if (fields.forSession < 0n) {
      throw new PublishError('a session counter cannot be negative');
    }
    this.parameters = fields.parameters;
    this.forSession = fields.forSession;
  }
}

/** The commitment was made, and this is the digest the publisher will be judged against. */
export interface Published {
  readonly kind: 'published';
  readonly digest: Uint8Array;
  readonly forSession: bigint;
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
  readonly model: string;
}

/** The session has opened, so the fit could have seen the outcome. Nothing was published. */
export interface SessionAlreadyOpen {
  readonly kind: 'alreadyOpen';
  readonly forSession: bigint;
  readonly currentSession: bigint;
}

/**
 * A publish either committed or refused, and the refusal is a domain result rather than a failure:
 * publishing too late is an ordinary thing for a caller to attempt.
 */
export type PublishResult = Published | SessionAlreadyOpen;

/**
 * Commit a parameter set, or refuse because the session has opened.
 *
 * The digest is computed here as well as by the registry, and that duplication is the point: a
 * challenger recomputes it from the committed fields, and a publisher computing a different one would
 * find out at challenge time. Computing it locally means the two are compared before the bond is
 * posted.
 *
 * The refusal happens **before** the port is touched. That ordering is load-bearing rather than
 * stylistic: a publisher that had already committed would have spent a bond on a parameter set the
 * registry would reject, and the whole reason this use case exists is to make that impossible.
 */
export async function publish(
  request: PublishRequest,
  publisher: ParameterPublisher,
  keccak: Keccak,
  options: { currentSession: bigint },
): Promise<PublishResult> {
  if (request.forSession <= options.currentSession) {
    return {
      kind: 'alreadyOpen',
      forSession: request.forSession,
      currentSession: options.currentSession,
    };
  }

  const digest = commitmentDigest(
    keccak,
    nameId(keccak, request.parameters.symbol),
    request.forSession,
    request.parameters.lam.raw,
    request.parameters.premium.raw,
    request.parameters.inputsHash,
  );
  await publisher.publish(request.parameters, request.forSession);
  return {
    kind: 'published',
    digest,
    forSession: request.forSession,
    lambdaWad: request.parameters.lam.raw,
    premiumWad: request.parameters.premium.raw,
    model: request.parameters.model,
  };
}
