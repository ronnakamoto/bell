/**
 * The ports, and the structural contract they impose.
 *
 * Ported from `settlement/tests/unit/test_ports.py`, which has 4 tests; this file has 9. The four are
 * kept and five runtime-or-shape tests are added, and the reason is the one departure worth stating.
 *
 * **The Python's four tests are compile-time here, not runtime, and that is a property of the
 * language rather than a choice.** They are `isinstance(obj, SomeProtocol)` against
 * `@runtime_checkable` protocols. A TypeScript `interface` is erased at compile time: there is no
 * value to pass to `instanceof`, and `implements` is a declaration the *compiler* checks. So the
 * positive cases are `implements` clauses and the negative cases are `@ts-expect-error` on an
 * assignment — which are enforced by `tsc`, i.e. by `npm run typecheck`, and not by vitest.
 *
 * The `@ts-expect-error` form is a *gate*, not a decoration, and it is worth being explicit about
 * why: an unused `@ts-expect-error` is itself a compile error, so if a port were ever widened to
 * accept an object it should reject, `tsc` fails on the now-unnecessary directive. A comment saying
 * "this should not type-check" would decay silently; this cannot.
 *
 * The runtime tests exist because the type-level check says nothing about the *runtime* contract
 * the ports carry, which is the one a caller actually depends on: `printsFor` resolves a sequence,
 * and both `rowsDigest` and `window` resolve `undefined` rather than rejecting, because an
 * unavailable input is an ordinary outcome. The Python's suite could not see either, since nothing
 * implemented the protocols.
 *
 * The Python's docstring is worth carrying: nothing imported `bell_settlement.domain.ports`, so the
 * module reported 0% coverage and — more to the point — nothing checked that the protocols are
 * *satisfiable*. A protocol that declared a member no adapter could implement would have surfaced
 * when the first adapter was written rather than here.
 */

import { describe, expect, it } from 'vitest';

import {
  type CommittedInputStore,
  type CommittedWindow,
  type ReferencePrintSource,
} from '../../src/domain/ports.js';
import { type ReferencePrint } from '../../src/domain/prints.js';

/** The smallest object that satisfies `ReferencePrintSource`. */
class APrintSource implements ReferencePrintSource {
  printsFor(_referenceToken: string): Promise<readonly ReferencePrint[]> {
    return Promise.resolve([]);
  }
}

/** The smallest object that satisfies `CommittedInputStore`. */
class AnInputStore implements CommittedInputStore {
  rowsDigest(_inputsHash: Uint8Array): Promise<Uint8Array | undefined> {
    return Promise.resolve(undefined);
  }

  window(_inputsHash: Uint8Array): Promise<CommittedWindow | undefined> {
    return Promise.resolve(undefined);
  }
}

/** A store that returns a window for any hash, so the happy path is visible in the suite. */
class AWindowStore implements CommittedInputStore {
  rowsDigest(_inputsHash: Uint8Array): Promise<Uint8Array | undefined> {
    return Promise.resolve(undefined);
  }

  window(_inputsHash: Uint8Array): Promise<CommittedWindow | undefined> {
    return Promise.resolve(aCommittedWindow());
  }
}

/** Digest lookup alone is not the store: `window` is required. */
class DigestOnly {
  rowsDigest(_inputsHash: Uint8Array): Promise<Uint8Array | undefined> {
    return Promise.resolve(undefined);
  }
}

/** An object that satisfies neither port. */
class Neither {
  somethingElse(): void {
    // Not a port method.
  }
}

function aCommittedWindow(): CommittedWindow {
  return {
    symbol: 'NVDA',
    session: 'E',
    windowSessions: 1,
    sourceIds: ['src-a'],
    familyName: 'seed',
    bars: [
      {
        tradingDate: '2024-01-02',
        closeWad: 100n * 10n ** 18n,
        nextOpenWad: 101n * 10n ** 18n,
      },
    ],
  };
}

describe('the ports', () => {
  it('a conforming object satisfies the print source port', () => {
    const source: ReferencePrintSource = new APrintSource();
    expect(source).toBeInstanceOf(APrintSource);
  });

  it('a conforming object satisfies the input store port', () => {
    const store: CommittedInputStore = new AnInputStore();
    expect(store).toBeInstanceOf(AnInputStore);
  });

  it('an object without the member does not satisfy the port', () => {
    // `runtime_checkable` in the Python checked for the *presence* of the declared members, which
    // turned a shape error into something a test could assert rather than something only mypy knew.
    // The compiler does that here, and the assertion below records the other half of the difference:
    // an interface is erased, so at runtime nothing stops the call. The check is real and it is
    // entirely static.
    // @ts-expect-error — `Neither` declares no `printsFor`, so it is not a `ReferencePrintSource`.
    const rejected: ReferencePrintSource = new Neither();
    expect(rejected).toBeInstanceOf(Neither);
  });

  it('the two ports are not interchangeable', () => {
    // The print source still declares one method; the input store now declares two. Worth asserting
    // because the two are structurally similar — methods taking one argument and returning an
    // optional-or-empty value — so a copy-paste that gave both the same method name would make an
    // adapter for one silently satisfy the other.
    // @ts-expect-error — a print source declares no `rowsDigest` (and no `window`).
    const crossed: CommittedInputStore = new APrintSource();
    expect(crossed).toBeInstanceOf(APrintSource);

    // @ts-expect-error — and an input store declares no `printsFor`.
    const reversed: ReferencePrintSource = new AnInputStore();
    expect(reversed).toBeInstanceOf(AnInputStore);
  });

  it('an object with only rowsDigest does not satisfy the input store', () => {
    // `window` is a required member, not an optional extra. A digest-only object is the shape the
    // store had before F2 slice 2, and it must not keep compiling against the widened port.
    // @ts-expect-error — `DigestOnly` declares no `window`, so it is not a `CommittedInputStore`.
    const rejected: CommittedInputStore = new DigestOnly();
    expect(rejected).toBeInstanceOf(DigestOnly);
  });

  it('a print source resolves its prints', async () => {
    await expect(new APrintSource().printsFor('NVDA')).resolves.toEqual([]);
  });

  it('an unavailable input store resolves rather than rejecting', async () => {
    // `undefined` rather than a rejection, because an unavailable input is an ordinary outcome that
    // adjudication reports as `InputsUnavailable`. A port that rejected would force every caller to
    // catch one to say the same thing.
    await expect(new AnInputStore().rowsDigest(new Uint8Array(32))).resolves.toBeUndefined();
  });

  it('an unavailable window resolves rather than rejecting', async () => {
    // Same contract as `rowsDigest`: missing inputs are ordinary, not exceptional.
    await expect(new AnInputStore().window(new Uint8Array(32))).resolves.toBeUndefined();
  });

  it('a store can return the window the committed fit consumed', async () => {
    const store: CommittedInputStore = new AWindowStore();
    await expect(store.window(new Uint8Array(32))).resolves.toEqual(aCommittedWindow());
    await expect(store.rowsDigest(new Uint8Array(32))).resolves.toBeUndefined();
  });
});
