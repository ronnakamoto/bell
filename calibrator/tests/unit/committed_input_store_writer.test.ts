import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CommittedInputStoreWriterMalformed,
  mergeCommittedWindow,
  type StoreWindowPayload,
} from '../../src/adapters/committed_input_store_writer.js';
import { nobleKeccak } from '../../src/adapters/keccak_noble.js';
import { rowsDigest } from '../../src/application/calibrate.js';
import { hexOf } from '../../src/domain/bytes.js';
import { inputsHash } from '../../src/domain/digest.js';
import { DailyBar, Wad } from '../../src/domain/models.js';

function hashOf(window: StoreWindowPayload): string {
  const digest = inputsHash(
    nobleKeccak,
    window.windowSessions,
    window.session,
    window.sourceIds,
    window.windowSessions,
    rowsDigest(
      nobleKeccak,
      window.bars.map(
        (bar) =>
          new DailyBar(
            bar.tradingDate,
            new Wad(BigInt(bar.closeWad)),
            new Wad(BigInt(bar.nextOpenWad)),
          ),
      ),
    ),
  );
  return `0x${hexOf(digest)}`;
}

const HASH_A = hashOf(sampleWindow('NVDA'));
const HASH_B = hashOf(sampleWindow('AAPL', 'second-source'));

function sampleWindow(symbol: string, sourceId = 'test-fixture'): StoreWindowPayload {
  return {
    symbol,
    session: 'E',
    windowSessions: 2,
    sourceIds: [sourceId],
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
    await mergeCommittedWindow({ path, inputsHashHex: HASH_A, window, keccak: nobleKeccak });
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
      keccak: nobleKeccak,
    });
    await mergeCommittedWindow({
      path,
      inputsHashHex: HASH_B,
      window: sampleWindow('AAPL', 'second-source'),
      keccak: nobleKeccak,
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
      keccak: nobleKeccak,
    });
    await mergeCommittedWindow({
      path,
      inputsHashHex: HASH_A,
      window: sampleWindow('TSLA'),
      keccak: nobleKeccak,
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
        keccak: nobleKeccak,
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
        keccak: nobleKeccak,
      }),
    ).rejects.toThrow(CommittedInputStoreWriterMalformed);

    const noWindows = join(dir, 'no-windows.json');
    await writeFile(noWindows, '{}\n', 'utf8');
    await expect(
      mergeCommittedWindow({
        path: noWindows,
        inputsHashHex: HASH_A,
        window: sampleWindow('NVDA'),
        keccak: nobleKeccak,
      }),
    ).rejects.toThrow(/windows/);

    const windowsArray = join(dir, 'windows-array.json');
    await writeFile(windowsArray, '{"windows":[]}\n', 'utf8');
    await expect(
      mergeCommittedWindow({
        path: windowsArray,
        inputsHashHex: HASH_A,
        window: sampleWindow('NVDA'),
        keccak: nobleKeccak,
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
        keccak: nobleKeccak,
      }),
    ).rejects.toThrow(/lowercase/);
  });

  it('refuses a window stored under a hash its content does not produce', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-store-'));
    const path = join(dir, 'store.json');
    await expect(
      mergeCommittedWindow({
        path,
        inputsHashHex: `0x${'ab'.repeat(32)}`,
        window: sampleWindow('NVDA'),
        keccak: nobleKeccak,
      }),
    ).rejects.toThrow(/does not hash to the key/);
  });

  it('refuses a window whose bars were altered after the key was computed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-store-'));
    const path = join(dir, 'store.json');
    const window = sampleWindow('NVDA');
    const tampered = {
      ...window,
      bars: window.bars.map((bar, index) =>
        index === 0 ? { ...bar, closeWad: '99900000000000000000' } : bar,
      ),
    };
    await expect(
      mergeCommittedWindow({
        path,
        inputsHashHex: HASH_A,
        window: tampered,
        keccak: nobleKeccak,
      }),
    ).rejects.toThrow(/does not hash to the key/);
  });
});
