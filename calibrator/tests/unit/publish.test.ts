/**
 * The publish use case.
 *
 * The rule under test is the contract's, restated off-chain: `PremiumRegistry.commit` reverts
 * `SessionAlreadyOpen` when the session has opened, and this refuses the same case so that a
 * publisher finds out before spending a bond rather than after.
 *
 * Ported from `calibrator/tests/unit/test_publish.py`, which has 7 tests in three classes; this file
 * has 9. The departures are both about `async`, which the Python does not have:
 *
 *  - `RecordingPublisher` returns a promise and the tests `await` it, because the port's
 *    `ParameterPublisher` does. An un-awaited call would let "the publisher was not called on a
 *    refusal" pass against a publisher that *was* called and never resolved.
 *  - One added test pins that awaiting, and one added test pins the refusal's *error type* — the
 *    Python raises `ValueError`, which is what every other refusal in that codebase raises, so a
 *    caller cannot branch on it.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { PublishError, PublishRequest, publish } from '../../src/application/publish.js';
import { WAD } from '../../src/domain/constants.js';
import { commitmentDigest, nameId } from '../../src/domain/digest.js';
import { ParameterSet, SessionKind, Symbol, Wad } from '../../src/domain/models.js';
import { type Keccak, type ParameterPublisher } from '../../src/domain/ports.js';

/** A decimal literal at WAD scale, exactly, the way the Python's `int(Decimal(v) * WAD)` does it. */
const wad = (value: string): bigint => BigInt(new Decimal(value).times(WAD.toString()).toFixed(0));

const NVDA = new Symbol('NVDA');

/** `bytes(range(32))`, as the Python builds it. */
const INPUTS_HASH = Uint8Array.from({ length: 32 }, (_, index) => index);

const PARAMETERS = new ParameterSet({
  symbol: NVDA,
  session: SessionKind.OVERNIGHT,
  lam: new Wad(15n * WAD),
  premium: new Wad(wad('0.1740')),
  inputsHash: INPUTS_HASH,
  model: 'empirical',
});

const referenceKeccak: Keccak = (data) => keccak_256(data);

/** A `ParameterPublisher` that records what it was asked to commit. */
class RecordingPublisher implements ParameterPublisher {
  readonly calls: { parameters: ParameterSet; forSession: bigint }[] = [];
  /** Set while the call is in flight and cleared when it returns, so the awaiting is observable. */
  resolved = false;

  async publish(parameters: ParameterSet, forSession: bigint): Promise<string> {
    this.calls.push({ parameters, forSession });
    await Promise.resolve();
    this.resolved = true;
    return `0x${'00'.repeat(32)}`;
  }
}

describe('publishing', () => {
  it('a future session is published', async () => {
    const publisher = new RecordingPublisher();
    const result = await publish(
      new PublishRequest({ parameters: PARAMETERS, forSession: 10n }),
      publisher,
      referenceKeccak,
      { currentSession: 9n },
    );
    expect(result.kind).toBe('published');
    if (result.kind !== 'published') throw new Error('unreachable');
    expect(result.forSession).toBe(10n);
    expect(result.lambdaWad).toBe(15n * WAD);
    expect(result.model).toBe('empirical');
    expect(publisher.calls).toHaveLength(1);
  });

  it('the returned digest is the one a challenger would compute', async () => {
    // The digest is computed locally as well as by the registry, and that duplication is the point: a
    // challenger recomputes it from the committed fields, so a publisher that computed a different one
    // would find out at challenge time rather than before posting the bond.
    const result = await publish(
      new PublishRequest({ parameters: PARAMETERS, forSession: 10n }),
      new RecordingPublisher(),
      referenceKeccak,
      { currentSession: 9n },
    );
    if (result.kind !== 'published') throw new Error('expected a publication');
    expect(result.digest).toEqual(
      commitmentDigest(
        referenceKeccak,
        nameId(referenceKeccak, NVDA),
        10n,
        PARAMETERS.lam.raw,
        PARAMETERS.premium.raw,
        INPUTS_HASH,
      ),
    );
  });

  it('the digest is sensitive to the session', async () => {
    const first = await publish(
      new PublishRequest({ parameters: PARAMETERS, forSession: 10n }),
      new RecordingPublisher(),
      referenceKeccak,
      { currentSession: 9n },
    );
    const second = await publish(
      new PublishRequest({ parameters: PARAMETERS, forSession: 11n }),
      new RecordingPublisher(),
      referenceKeccak,
      { currentSession: 9n },
    );
    if (first.kind !== 'published') throw new Error('expected a publication');
    if (second.kind !== 'published') throw new Error('expected a publication');
    expect(first.digest).not.toEqual(second.digest);
  });

  it('awaits the publisher rather than only calling it', async () => {
    // Added by the port. `publish` is `async` because `ParameterPublisher.publish` is, and a caller
    // that forgot to await would get a promise the next assertion could inspect while the publisher
    // was still in flight. The double reports its own state so the awaiting is asserted.
    const publisher = new RecordingPublisher();
    const pending = publish(
      new PublishRequest({ parameters: PARAMETERS, forSession: 10n }),
      publisher,
      referenceKeccak,
      { currentSession: 9n },
    );
    expect(publisher.resolved).toBe(false);
    await pending;
    expect(publisher.resolved).toBe(true);
  });
});

describe('the no-fit-after-the-outcome rule', () => {
  it('publishing for the current session is refused', async () => {
    // `forSession == currentSession` is already too late: the outcome may be known, so the fit could
    // have seen it.
    const result = await publish(
      new PublishRequest({ parameters: PARAMETERS, forSession: 10n }),
      new RecordingPublisher(),
      referenceKeccak,
      { currentSession: 10n },
    );
    expect(result.kind).toBe('alreadyOpen');
    if (result.kind !== 'alreadyOpen') throw new Error('unreachable');
    expect(result.forSession).toBe(10n);
    expect(result.currentSession).toBe(10n);
  });

  it('publishing for a past session is refused', async () => {
    const result = await publish(
      new PublishRequest({ parameters: PARAMETERS, forSession: 4n }),
      new RecordingPublisher(),
      referenceKeccak,
      { currentSession: 10n },
    );
    expect(result.kind).toBe('alreadyOpen');
  });

  it('the publisher is not called on a refusal', async () => {
    // The refusal has to happen before the port is touched: a publisher that had already committed
    // would have spent a bond on a parameter set the registry would reject.
    const publisher = new RecordingPublisher();
    await publish(
      new PublishRequest({ parameters: PARAMETERS, forSession: 10n }),
      publisher,
      referenceKeccak,
      { currentSession: 10n },
    );
    expect(publisher.calls).toEqual([]);
  });
});

describe('the request', () => {
  it('a negative session is refused', () => {
    expect(() => new PublishRequest({ parameters: PARAMETERS, forSession: -1n })).toThrow(
      /cannot be negative/,
    );
  });

  it('refuses with a named error type', () => {
    // Added by the port. The Python raises `ValueError`, which is what every other refusal in that
    // codebase also raises, so a caller cannot branch on it; the port's name is what the adapter
    // layer branches on.
    expect(() => new PublishRequest({ parameters: PARAMETERS, forSession: -1n })).toThrow(
      PublishError,
    );
  });
});
