import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CommittedInputStoreWriterMalformed,
  mergeCommittedWindow,
  type StoreWindowPayload,
} from '../../src/adapters/committed_input_store_writer.js';

const HASH_A = `0x${'ab'.repeat(32)}`;
const HASH_B = `0x${'cd'.repeat(32)}`;

function sampleWindow(symbol: string): StoreWindowPayload {
  return {
    symbol,
    session: 'E',
    windowSessions: 2,
    sourceIds: ['test-fixture'],
    familyName: 'empirical',
    bars: [
      {
        tradingDate: '2020-01-06',
        closeWad: '100000000000000000000',
        nextOpenWad: '101000000000000000000',
      },
      {
        tradingDate: '2020-01-07',
        closeWad: '100000000000000000000',
        nextOpenWad: '101000000000000000000',
      },
    ],
  };
}

describe('mergeCommittedWindow', () => {
  it('creates a new store file with one window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-store-'));
    const path = join(dir, 'nested', 'store.json');
    const window = sampleWindow('NVDA');
    await mergeCommittedWindow({ path, inputsHashHex: HASH_A, window });
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      windows: Record<string, StoreWindowPayload>;
    };
    expect(document.windows[HASH_A]).toEqual(window);
    expect(document.windows[HASH_A]?.bars[0]?.closeWad).toBe('100000000000000000000');
  });

  it('merges a second hash and preserves the first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-store-'));
    const path = join(dir, 'store.json');
    await mergeCommittedWindow({
      path,
      inputsHashHex: HASH_A,
      window: sampleWindow('NVDA'),
    });
    await mergeCommittedWindow({
      path,
      inputsHashHex: HASH_B,
      window: sampleWindow('AAPL'),
    });
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      windows: Record<string, StoreWindowPayload>;
    };
    expect(document.windows[HASH_A]?.symbol).toBe('NVDA');
    expect(document.windows[HASH_B]?.symbol).toBe('AAPL');
  });

  it('overwrites the same hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-store-'));
    const path = join(dir, 'store.json');
    await mergeCommittedWindow({
      path,
      inputsHashHex: HASH_A,
      window: sampleWindow('NVDA'),
    });
    await mergeCommittedWindow({
      path,
      inputsHashHex: HASH_A,
      window: sampleWindow('TSLA'),
    });
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      windows: Record<string, StoreWindowPayload>;
    };
    expect(Object.keys(document.windows)).toEqual([HASH_A]);
    expect(document.windows[HASH_A]?.symbol).toBe('TSLA');
  });

  it('refuses a malformed existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-store-'));
    const path = join(dir, 'store.json');
    await writeFile(path, '[]\n', 'utf8');
    await expect(
      mergeCommittedWindow({
        path,
        inputsHashHex: HASH_A,
        window: sampleWindow('NVDA'),
      }),
    ).rejects.toThrow(CommittedInputStoreWriterMalformed);
  });

  it('refuses invalid JSON, a missing windows field, and a non-object windows value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-store-'));
    const badJson = join(dir, 'bad.json');
    await writeFile(badJson, '{', 'utf8');
    await expect(
      mergeCommittedWindow({
        path: badJson,
        inputsHashHex: HASH_A,
        window: sampleWindow('NVDA'),
      }),
    ).rejects.toThrow(CommittedInputStoreWriterMalformed);

    const noWindows = join(dir, 'no-windows.json');
    await writeFile(noWindows, '{}\n', 'utf8');
    await expect(
      mergeCommittedWindow({
        path: noWindows,
        inputsHashHex: HASH_A,
        window: sampleWindow('NVDA'),
      }),
    ).rejects.toThrow(/windows/);

    const windowsArray = join(dir, 'windows-array.json');
    await writeFile(windowsArray, '{"windows":[]}\n', 'utf8');
    await expect(
      mergeCommittedWindow({
        path: windowsArray,
        inputsHashHex: HASH_A,
        window: sampleWindow('NVDA'),
      }),
    ).rejects.toThrow(/windows must be an object/);
  });

  it('refuses a mixed-case hash key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-store-'));
    const path = join(dir, 'store.json');
    await expect(
      mergeCommittedWindow({
        path,
        inputsHashHex: `0x${'AB'.repeat(32)}`,
        window: sampleWindow('NVDA'),
      }),
    ).rejects.toThrow(/lowercase/);
  });
});
