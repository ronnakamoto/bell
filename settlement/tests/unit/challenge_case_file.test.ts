/**
 * The file-backed challenge-case adapter.
 *
 * Everything that can go wrong with a fixture lives here: JSON shape, hex width, and bigint strings.
 * Missing files are unavailable; a present file that cannot yield the requested case is malformed.
 * Stub `refit` objects are refused — re-fit comes from the committed-input store, not the case file.
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
} from '../../src/adapters/challenge_case_file.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/challenge.json', import.meta.url),
);

const STORE_NAME_ID = 'e108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';
const STORE_INPUTS = '33738d126531a0bb1907cdae71fff72e53f7944f3f8aef08f5c4cb09062d39db';
const STORE_DIGEST = 'e0050eab106e3de25dce869508a8b6f65147fcb25bb64875c9aa96e6e15e4cdb';

const VALID_CASE = {
  label: 'sample',
  nameId: `0x${STORE_NAME_ID}`,
  forSession: '12345',
  lambdaWad: '100000000000000000000',
  premiumWad: '1000000000000000000',
  inputsHash: `0x${STORE_INPUTS}`,
  expectedDigest: `0x${STORE_DIGEST}`,
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
  it('parses challenge cases without a stub refit', () => {
    const cases = parseChallengeDocument(
      FIXTURE_PATH,
      JSON.stringify({
        _note: 'ignored',
        cases: [VALID_CASE, { ...VALID_CASE, label: 'inputs-unavailable' }],
      }),
    );
    expect(cases).toHaveLength(2);
    expect(hexOf(cases[0]?.nameId ?? new Uint8Array())).toBe(STORE_NAME_ID);
    expect(cases[0]?.nameId).toHaveLength(32);
    expect(cases[0]?.inputsHash).toHaveLength(32);
    expect(cases[0]?.expectedDigest).toHaveLength(32);
    expect(cases[0]?.forSession).toBe(12345n);
    expect(cases[0]?.lambdaWad).toBe(100_000_000_000_000_000_000n);
    expect(cases[0]?.premiumWad).toBe(1_000_000_000_000_000_000n);
    expect(cases[0]).not.toHaveProperty('refit');
    expect(cases[1]?.label).toBe('inputs-unavailable');
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
    expect(() => parseChallengeDocument('/c.json', '1')).toThrow(ChallengeCaseMalformed);
  });

  it('refuses a case that is not an object', () => {
    expect(() => parseChallengeDocument('/c.json', documentOf([null]))).toThrow(
      ChallengeCaseMalformed,
    );
    expect(() => parseChallengeDocument('/c.json', documentOf([1]))).toThrow(
      ChallengeCaseMalformed,
    );
    expect(() => parseChallengeDocument('/c.json', documentOf([[]]))).toThrow(
      ChallengeCaseMalformed,
    );
  });

  it('refuses a label that is not a string', () => {
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, label: 1 }])),
    ).toThrow(/label must be a string/);
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
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, nameId: STORE_NAME_ID }])),
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

  it('refuses a case that still has a stub refit field', () => {
    expect(() =>
      parseChallengeDocument('/c.json', documentOf([{ ...VALID_CASE, refit: null }])),
    ).toThrow(/refit is not a challenge-case field/);
    expect(() =>
      parseChallengeDocument(
        '/c.json',
        documentOf([
          {
            ...VALID_CASE,
            refit: { lambdaWad: '1', premiumWad: '1' },
          },
        ]),
      ),
    ).toThrow(ChallengeCaseMalformed);
  });
});

describe('loadChallengeCase', () => {
  it('loads a labelled case from the committed fixture', async () => {
    const loaded = await loadChallengeCase(FIXTURE_PATH, 'upheld-store');
    expect(loaded.label).toBe('upheld-store');
    expect(hexOf(loaded.expectedDigest)).toBe(STORE_DIGEST);
    expect(loaded.lambdaWad).toBe(100_000_000_000_000_000_000n);
    expect(loaded.premiumWad).toBe(1_000_000_000_000_000_000n);
    expect(loaded).not.toHaveProperty('refit');
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
    await expect(loadChallengeCase(path, 'upheld-store')).rejects.toThrow(ChallengeCaseUnavailable);
    await expect(loadChallengeCase(path, 'upheld-store')).rejects.toThrow(/no challenge case/);
  });

  it('an unreadable path is unavailable rather than malformed', async () => {
    const path = mkdtempSync(join(tmpdir(), 'bell-challenge-'));
    await expect(loadChallengeCase(path, 'upheld-store')).rejects.toThrow(ChallengeCaseUnavailable);
    await expect(loadChallengeCase(path, 'upheld-store')).rejects.toThrow(/could not read/);
  });

  it('loads a case written to a temp file', async () => {
    const path = writeTemp(documentOf([VALID_CASE]));
    const loaded = await loadChallengeCase(path, 'sample');
    expect(loaded.label).toBe('sample');
    expect(loaded.forSession).toBe(12345n);
  });
});
