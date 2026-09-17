/**
 * The file-backed challenge-case adapter.
 *
 * Everything that can go wrong with a fixture lives here: JSON shape, hex width, and bigint strings.
 * Missing files are unavailable; a present file that cannot yield the requested case is malformed.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hexOf } from '@bell/calibrator/domain/bytes.js';
import { describe, expect, it } from 'vitest';

import {
  ChallengeCaseMalformed,
  ChallengeCaseUnavailable,
  loadChallengeCase,
  parseChallengeDocument,
  refitFromCase,
} from '../../src/adapters/challenge_case_file.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/challenge.json', import.meta.url),
);

const OVERNIGHT_NAME_ID = 'e108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';
const OVERNIGHT_INPUTS = 'ba1940ba1e74225e3f3b13b7579e0920e64c04e6ff859f9649d95dec39ab0903';
const OVERNIGHT_DIGEST = '429155bab47a9b07adc772d9618086c40250666a95248c97024d64782ff7b939';

const VALID_CASE = {
  label: 'sample',
  nameId: `0x${OVERNIGHT_NAME_ID}`,
  forSession: '12345',
  lambdaWad: '15000000000000000000',
  premiumWad: '174000000000000000',
  inputsHash: `0x${OVERNIGHT_INPUTS}`,
  expectedDigest: `0x${OVERNIGHT_DIGEST}`,
  refit: {
    lambdaWad: '15000000000000000000',
    premiumWad: '174000000000000000',
  },
};

function documentOf(cases: unknown): string {
  return JSON.stringify({ cases });
}

function writeTemp(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bell-challenge-'));
  const path = join(root, 'challenge.json');
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('parseChallengeDocument', () => {
  it('parses the committed overnight fixture cases', () => {
    const cases = parseChallengeDocument(
      FIXTURE_PATH,
      JSON.stringify({
        _note: 'ignored',
        cases: [VALID_CASE, { ...VALID_CASE, label: 'inputs-unavailable', refit: null }],
      }),
    );
    expect(cases).toHaveLength(2);
    expect(hexOf(cases[0]?.nameId ?? new Uint8Array())).toBe(OVERNIGHT_NAME_ID);
    expect(cases[0]?.nameId).toHaveLength(32);
    expect(cases[0]?.inputsHash).toHaveLength(32);
    expect(cases[0]?.expectedDigest).toHaveLength(32);
    expect(cases[0]?.forSession).toBe(12345n);
    expect(cases[0]?.lambdaWad).toBe(15_000_000_000_000_000_000n);
    expect(cases[0]?.premiumWad).toBe(174_000_000_000_000_000n);
    expect(cases[0]?.refit).toEqual({
      lambdaWad: 15_000_000_000_000_000_000n,
      premiumWad: 174_000_000_000_000_000n,
    });
    expect(cases[1]?.refit).toBeNull();
  });

  it('refuses invalid JSON', () => {
    expect(() => parseChallengeDocument('/c.json', '{')).toThrow(ChallengeCaseMalformed);
  });

  it('refuses a document without a cases array', () => {
    expect(() => parseChallengeDocument('/c.json', '{}')).toThrow(ChallengeCaseMalformed);
    expect(() => parseChallengeDocument('/c.json', '{"cases":"x"}')).toThrow(
      ChallengeCaseMalformed,
    );
    expect(() => parseChallengeDocument('/c.json', '[]')).toThrow(ChallengeCaseMalformed);
    expect(() => parseChallengeDocument('/c.json', 'null')).toThrow(ChallengeCaseMalformed);
  });

  it('refuses a case that is not an object', () => {
    expect(() => parseChallengeDocument('/c.json', documentOf([null]))).toThrow(
      ChallengeCaseMalformed,
    );
    expect(() => parseChallengeDocument('/c.json', documentOf([1]))).toThrow(
      ChallengeCaseMalformed,
    );
  });

  it('refuses bigint fields that are not strings', () => {
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, forSession: 12345 }])),
    ).toThrow(/forSession must be a string-encoded integer/);
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, lambdaWad: 1 }])),
    ).toThrow(ChallengeCaseMalformed);
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, premiumWad: 1 }])),
    ).toThrow(ChallengeCaseMalformed);
  });

  it('refuses hex that is not 32 bytes', () => {
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, nameId: '0x01' }])),
    ).toThrow(/nameId must be 32 bytes/);
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, inputsHash: '0x01' }])),
    ).toThrow(ChallengeCaseMalformed);
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, expectedDigest: '0x01' }])),
    ).toThrow(ChallengeCaseMalformed);
  });

  it('refuses hex that is not 0x-prefixed', () => {
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, nameId: OVERNIGHT_NAME_ID }])),
    ).toThrow(ChallengeCaseMalformed);
  });

  it('refuses hex that is not hex', () => {
    expect(() =>
      parseChallengeDocument(
        '/c.json',
        documentOf([
          {
            ...VALID_CASE,
            nameId: '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
          },
        ]),
      ),
    ).toThrow(ChallengeCaseMalformed);
  });

  it('refuses a malformed refit', () => {
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, refit: 'x' }])),
    ).toThrow(ChallengeCaseMalformed);
    expect(() =>
      parseChallengeDocument(
        '/c.json',
        documentOf([{ ...VALID_CASE, refit: { lambdaWad: 1, premiumWad: '1' } }]),
      ),
    ).toThrow(ChallengeCaseMalformed);
  });
});

describe('loadChallengeCase', () => {
  it('loads a labelled case from the committed fixture', async () => {
    const loaded = await loadChallengeCase(FIXTURE_PATH, 'upheld-overnight');
    expect(loaded.label).toBe('upheld-overnight');
    expect(hexOf(loaded.expectedDigest)).toBe(OVERNIGHT_DIGEST);
    expect(loaded.refit?.premiumWad).toBe(174_000_000_000_000_000n);
  });

  it('a missing label is malformed rather than unavailable', async () => {
    await expect(loadChallengeCase(FIXTURE_PATH, 'no-such-case')).rejects.toThrow(
      ChallengeCaseMalformed,
    );
    await expect(loadChallengeCase(FIXTURE_PATH, 'no-such-case')).rejects.toThrow(
      /no case labelled no-such-case/,
    );
  });

  it('a missing file is unavailable rather than malformed', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bell-challenge-')), 'absent.json');
    await expect(loadChallengeCase(path, 'upheld-overnight')).rejects.toThrow(
      ChallengeCaseUnavailable,
    );
    await expect(loadChallengeCase(path, 'upheld-overnight')).rejects.toThrow(/no challenge case/);
  });

  it('an unreadable path is unavailable rather than malformed', async () => {
    const path = mkdtempSync(join(tmpdir(), 'bell-challenge-'));
    await expect(loadChallengeCase(path, 'upheld-overnight')).rejects.toThrow(
      ChallengeCaseUnavailable,
    );
    await expect(loadChallengeCase(path, 'upheld-overnight')).rejects.toThrow(/could not read/);
  });

  it('loads a case written to a temp file', async () => {
    const path = writeTemp(documentOf([VALID_CASE]));
    const loaded = await loadChallengeCase(path, 'sample');
    expect(loaded.label).toBe('sample');
    expect(loaded.forSession).toBe(12345n);
  });
});

describe('refitFromCase', () => {
  it('a null refit always resolves undefined', async () => {
    const loaded = await loadChallengeCase(FIXTURE_PATH, 'inputs-unavailable');
    const runner = refitFromCase(loaded);
    expect(await runner(loaded.inputsHash)).toBeUndefined();
  });

  it('a present refit returns the fixture parameters', async () => {
    const loaded = await loadChallengeCase(FIXTURE_PATH, 'slashed-premium');
    const runner = refitFromCase(loaded);
    expect(await runner(loaded.inputsHash)).toEqual({
      lambdaWad: 15_000_000_000_000_000_000n,
      premiumWad: 274_000_000_000_000_000n,
    });
  });
});
