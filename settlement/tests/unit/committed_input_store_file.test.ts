/**
 * The file-backed committed-input store.
 *
 * Windows are keyed by `inputsHash`. A missing key is `undefined` (the ordinary unavailable
 * outcome); a missing or unreadable file is unavailable; a present file that is not this document
 * is malformed. `rowsDigest` is derived from the window's bars rather than stored beside them.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rowsDigest } from '@bell/calibrator/application/calibrate.js';
import { bytesFromHex, hexOf } from '@bell/calibrator/domain/bytes.js';
import { DailyBar, Wad } from '@bell/calibrator/domain/models.js';
import { describe, expect, it } from 'vitest';

import {
  CommittedInputStoreMalformed,
  CommittedInputStoreUnavailable,
  FileCommittedInputStore,
  loadCommittedInputStore,
  parseCommittedInputsDocument,
} from '../../src/adapters/committed_input_store_file.js';
import { nobleKeccak } from '../../src/adapters/keccak_noble.js';

const STORE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/committed_inputs.json', import.meta.url),
);
const CHALLENGE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/challenge.json', import.meta.url),
);

const SAMPLE_HASH = `0x${'ab'.repeat(32)}`;
const SAMPLE_BAR = {
  tradingDate: '2020-01-06',
  closeWad: '100000000000000000000',
  nextOpenWad: '101000000000000000000',
};

function upheldInputsHashHex(): string {
  const document = JSON.parse(readFileSync(CHALLENGE_PATH, 'utf8')) as {
    cases: readonly { label: string; inputsHash: string }[];
  };
  const upheld = document.cases.find((entry) => entry.label === 'upheld-store');
  if (upheld === undefined) throw new Error('fixture has no upheld-store case');
  return upheld.inputsHash;
}

function aWindow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const windowSessions = (overrides['windowSessions'] as number | undefined) ?? 100;
  const bars = Array.from({ length: windowSessions }, (_, index) => ({
    tradingDate: `2020-01-${String((index % 28) + 1).padStart(2, '0')}`,
    closeWad: '100000000000000000000',
    nextOpenWad: '101000000000000000000',
  }));
  return {
    symbol: 'NVDA',
    session: 'E',
    windowSessions,
    sourceIds: ['test-fixture'],
    familyName: 'empirical',
    bars,
    ...overrides,
  };
}

function documentOf(windows: unknown): string {
  return JSON.stringify({ windows });
}

function writeTemp(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bell-store-'));
  const path = join(root, 'committed_inputs.json');
  writeFileSync(path, body, 'utf8');
  return path;
}

function storeFrom(windows: Record<string, unknown>): FileCommittedInputStore {
  return new FileCommittedInputStore(
    parseCommittedInputsDocument('/store.json', documentOf(windows)),
    nobleKeccak,
  );
}

describe('parseCommittedInputsDocument', () => {
  it('parses the committed fixture window keyed by the upheld inputsHash', () => {
    const windows = parseCommittedInputsDocument(STORE_PATH, readFileSync(STORE_PATH, 'utf8'));
    const held = windows.get(upheldInputsHashHex());
    expect(held).toBeDefined();
    expect(held?.symbol).toBe('NVDA');
    expect(held?.session).toBe('E');
    expect(held?.windowSessions).toBe(100);
    expect(held?.sourceIds).toEqual(['test-fixture']);
    expect(held?.familyName).toBe('empirical');
    expect(held?.bars).toHaveLength(100);
    expect(held?.bars[0]).toEqual({
      tradingDate: '2020-01-06',
      closeWad: 100_000_000_000_000_000_000n,
      nextOpenWad: 101_000_000_000_000_000_000n,
    });
  });

  it('refuses invalid JSON', () => {
    expect(() => parseCommittedInputsDocument('/s.json', '{')).toThrow(
      CommittedInputStoreMalformed,
    );
  });

  it('refuses a document without a windows object', () => {
    expect(() => parseCommittedInputsDocument('/s.json', '{}')).toThrow(
      CommittedInputStoreMalformed,
    );
    expect(() => parseCommittedInputsDocument('/s.json', '{"windows":[]}')).toThrow(
      CommittedInputStoreMalformed,
    );
    expect(() => parseCommittedInputsDocument('/s.json', '[]')).toThrow(
      CommittedInputStoreMalformed,
    );
    expect(() => parseCommittedInputsDocument('/s.json', 'null')).toThrow(
      CommittedInputStoreMalformed,
    );
    expect(() => parseCommittedInputsDocument('/s.json', '1')).toThrow(
      CommittedInputStoreMalformed,
    );
  });

  it('refuses a window key that is not 32-byte 0x hex', () => {
    expect(() =>
      parseCommittedInputsDocument('/s.json', documentOf({ '0x01': aWindow() })),
    ).toThrow(/must be 32 bytes/);
    expect(() =>
      parseCommittedInputsDocument('/s.json', documentOf({ ['ab'.repeat(32)]: aWindow() })),
    ).toThrow(CommittedInputStoreMalformed);
    expect(() =>
      parseCommittedInputsDocument('/s.json', documentOf({ ['0x' + 'zz'.repeat(32)]: aWindow() })),
    ).toThrow(CommittedInputStoreMalformed);
  });

  it('refuses a window that is not an object', () => {
    expect(() =>
      parseCommittedInputsDocument('/s.json', documentOf({ [SAMPLE_HASH]: null })),
    ).toThrow(CommittedInputStoreMalformed);
    expect(() => parseCommittedInputsDocument('/s.json', documentOf({ [SAMPLE_HASH]: 1 }))).toThrow(
      CommittedInputStoreMalformed,
    );
    expect(() =>
      parseCommittedInputsDocument('/s.json', documentOf({ [SAMPLE_HASH]: [] })),
    ).toThrow(CommittedInputStoreMalformed);
  });

  it('refuses a session that is not a calibrator session kind', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ session: 'X' }) }),
      ),
    ).toThrow(/session must be E, W, H, or C/);
  });

  it('refuses bigint fields that are not strings', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({
          [SAMPLE_HASH]: aWindow({ bars: [{ ...SAMPLE_BAR, closeWad: 1 }] }),
        }),
      ),
    ).toThrow(/closeWad must be a string-encoded integer/);
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({
          [SAMPLE_HASH]: aWindow({ bars: [{ ...SAMPLE_BAR, nextOpenWad: 1 }] }),
        }),
      ),
    ).toThrow(CommittedInputStoreMalformed);
  });

  it('refuses a windowSessions that is not a positive integer', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ windowSessions: 0 }) }),
      ),
    ).toThrow(/windowSessions must be a positive integer/);
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ windowSessions: 1.5 }) }),
      ),
    ).toThrow(CommittedInputStoreMalformed);
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ windowSessions: '100' }) }),
      ),
    ).toThrow(CommittedInputStoreMalformed);
  });

  it('refuses empty sourceIds', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ sourceIds: [] }) }),
      ),
    ).toThrow(/sourceIds must be a non-empty array of strings/);
  });

  it('refuses a sourceId that is not a string', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ sourceIds: [1] }) }),
      ),
    ).toThrow(/sourceIds must be a non-empty array of strings/);
  });

  it('refuses bars that are not an array', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ bars: { tradingDate: '2020-01-06' } }) }),
      ),
    ).toThrow(/bars must be an array/);
  });

  it('refuses a symbol that is not a string', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ symbol: 1 }) }),
      ),
    ).toThrow(/symbol must be a string/);
  });

  it('refuses a bar that is not an object', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ bars: [null] }) }),
      ),
    ).toThrow(CommittedInputStoreMalformed);
  });

  it('refuses a window whose bar count differs from its windowSessions', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({ [SAMPLE_HASH]: aWindow({ windowSessions: 100, bars: [SAMPLE_BAR] }) }),
      ),
    ).toThrow(/holds exactly the tail/);
  });

  it('refuses a bar whose tradingDate is not a calendar date', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({
          [SAMPLE_HASH]: aWindow({ bars: [{ ...SAMPLE_BAR, tradingDate: '2020-13-45' }] }),
        }),
      ),
    ).toThrow(/tradingDate/);
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({
          [SAMPLE_HASH]: aWindow({ bars: [{ ...SAMPLE_BAR, tradingDate: 'not-a-date' }] }),
        }),
      ),
    ).toThrow(/tradingDate/);
  });

  it('refuses a bar whose close is not positive', () => {
    expect(() =>
      parseCommittedInputsDocument(
        '/s.json',
        documentOf({
          [SAMPLE_HASH]: aWindow({ bars: [{ ...SAMPLE_BAR, closeWad: '0' }] }),
        }),
      ),
    ).toThrow(/closeWad must be positive/);
  });
});

describe('FileCommittedInputStore', () => {
  it('looks up a window by inputsHash bytes', async () => {
    const store = storeFrom({ [SAMPLE_HASH]: aWindow() });
    const found = await store.window(bytesFromHex(SAMPLE_HASH));
    expect(found?.symbol).toBe('NVDA');
    expect(found?.bars).toHaveLength(100);
    expect(found?.bars[0]?.closeWad).toBe(100_000_000_000_000_000_000n);
  });

  it('a missing hash resolves undefined rather than rejecting', async () => {
    const store = storeFrom({ [SAMPLE_HASH]: aWindow() });
    const other = bytesFromHex(`0x${'cd'.repeat(32)}`);
    await expect(store.window(other)).resolves.toBeUndefined();
    await expect(store.rowsDigest(other)).resolves.toBeUndefined();
  });

  it('derives rowsDigest from the window bars via calibrator rowsDigest', async () => {
    const store = await loadCommittedInputStore(STORE_PATH, nobleKeccak);
    const hash = bytesFromHex(upheldInputsHashHex());
    const window = await store.window(hash);
    expect(window).toBeDefined();
    const expected = rowsDigest(
      nobleKeccak,
      (window?.bars ?? []).map(
        (bar) => new DailyBar(bar.tradingDate, new Wad(bar.closeWad), new Wad(bar.nextOpenWad)),
      ),
    );
    const digest = await store.rowsDigest(hash);
    expect(digest).toHaveLength(32);
    expect(hexOf(digest ?? new Uint8Array())).toBe(hexOf(expected));
  });
});

describe('loadCommittedInputStore', () => {
  it('loads the committed fixture', async () => {
    const store = await loadCommittedInputStore(STORE_PATH, nobleKeccak);
    const window = await store.window(bytesFromHex(upheldInputsHashHex()));
    expect(window?.bars).toHaveLength(100);
  });

  it('a missing file is unavailable rather than malformed', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bell-store-')), 'absent.json');
    await expect(loadCommittedInputStore(path, nobleKeccak)).rejects.toThrow(
      CommittedInputStoreUnavailable,
    );
    await expect(loadCommittedInputStore(path, nobleKeccak)).rejects.toThrow(
      /no committed-input store/,
    );
  });

  it('an unreadable path is unavailable rather than malformed', async () => {
    const path = mkdtempSync(join(tmpdir(), 'bell-store-'));
    await expect(loadCommittedInputStore(path, nobleKeccak)).rejects.toThrow(
      CommittedInputStoreUnavailable,
    );
    await expect(loadCommittedInputStore(path, nobleKeccak)).rejects.toThrow(/could not read/);
  });

  it('loads a store written to a temp file', async () => {
    const path = writeTemp(documentOf({ [SAMPLE_HASH]: aWindow({ windowSessions: 1 }) }));
    const store = await loadCommittedInputStore(path, nobleKeccak);
    const found = await store.window(bytesFromHex(SAMPLE_HASH));
    expect(found?.windowSessions).toBe(1);
  });
});
