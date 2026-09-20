/**
 * The calibrator publish composition root.
 *
 * Exercises `main` with argv rather than spawning node, so usage, refuse, and publish codes are
 * assertions rather than a smoke script's only record.
 */

import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { main, type TextWriter } from '../../src/cli/publish.js';

function capture(): { text: () => string; writer: TextWriter } {
  const chunks: string[] = [];
  return {
    text: (): string => chunks.join(''),
    writer: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
  };
}

async function run(argv: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, { stdout: stdout.writer, stderr: stderr.writer });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** 100 overnight-sized rows so the default tail screen passes. */
function csvBody(rows: number): string {
  const lines = ['date,close,next_open'];
  for (let index = 0; index < rows; index += 1) {
    const month = index < 28 ? '01' : '02';
    const dayNum = String((index % 28) + 1).padStart(2, '0');
    lines.push(`2020-${month}-${dayNum},100.00,101.00`);
  }
  return `${lines.join('\n')}\n`;
}

describe('publish CLI main', () => {
  it('exits 0, writes a window, and prints commit intent on the hermetic default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-publish-'));
    const store = join(dir, 'store.json');
    const result = await run(['--store', store]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('kind=published');
    expect(result.stdout).toContain('kind=commit');
    expect(result.stdout).toContain('collateral.approve');
    expect(result.stdout).toContain('premium.commit');
    expect(result.stdout).toContain('inputsHash=0x');
    const document = JSON.parse(await readFile(store, 'utf8')) as {
      windows: Record<string, { symbol: string; bars: unknown[] }>;
    };
    const hashes = Object.keys(document.windows);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(document.windows[hashes[0]!]?.symbol).toBe('NVDA');
    expect(document.windows[hashes[0]!]?.bars).toHaveLength(100);
  });

  it('loads bars from a CSV directory and accepts session / source / symbol flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-publish-'));
    const store = join(dir, 'store.json');
    const barsDir = join(dir, 'bars');
    await mkdir(barsDir);
    await writeFile(join(barsDir, 'AAPL.csv'), csvBody(100), 'utf8');
    const result = await run([
      '--store',
      store,
      '--bars',
      barsDir,
      '--symbol',
      'AAPL',
      '--session',
      'E',
      '--source-id',
      'csv-a',
      '--source-id',
      'csv-b',
      '--window',
      '100',
      '--for-session',
      '99',
      '--current-session',
      '1',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind=published');
    expect(result.stdout).toContain('forSession=99');
    const document = JSON.parse(await readFile(store, 'utf8')) as {
      windows: Record<string, { symbol: string; sourceIds: string[] }>;
    };
    const window = Object.values(document.windows)[0];
    expect(window?.symbol).toBe('AAPL');
    expect(window?.sourceIds).toEqual(['csv-a', 'csv-b']);
  });

  it('loads bars from a single CSV file named for the symbol', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-publish-'));
    const store = join(dir, 'store.json');
    const file = join(dir, 'NVDA.csv');
    await writeFile(file, csvBody(100), 'utf8');
    const result = await run(['--store', store, '--bars', file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind=published');
  });

  it('exits 1 on alreadyOpen and does not write the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-publish-'));
    const store = join(dir, 'store.json');
    const result = await run(['--store', store, '--for-session', '10', '--current-session', '10']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('kind=alreadyOpen');
    await expect(access(store)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exits 1 when the sample is insufficient', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-publish-'));
    const store = join(dir, 'store.json');
    const barsDir = join(dir, 'bars');
    await mkdir(barsDir);
    await writeFile(join(barsDir, 'AAPL.csv'), csvBody(50), 'utf8');
    const result = await run([
      '--store',
      store,
      '--bars',
      barsDir,
      '--symbol',
      'AAPL',
      '--window',
      '200',
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('kind=insufficient');
    await expect(access(store)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exits 2 on unknown argv', async () => {
    const result = await run(['--nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown argument');
  });

  it('exits 2 when --window is missing a value', async () => {
    const result = await run(['--window']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('needs a value');
  });

  it('exits 2 on an invalid session or non-integer window', async () => {
    expect((await run(['--session', 'Z'])).code).toBe(2);
    expect((await run(['--window', '0'])).code).toBe(2);
    expect((await run(['--for-session', '-1'])).code).toBe(2);
    expect((await run(['--current-session', 'x'])).code).toBe(2);
  });

  it('exits 2 when --bars points at a missing path or a misnamed file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-publish-'));
    const missing = await run(['--store', join(dir, 's.json'), '--bars', join(dir, 'nope')]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/could not read|no gap series/);

    const file = join(dir, 'OTHER.csv');
    await writeFile(file, csvBody(100), 'utf8');
    const misnamed = await run(['--store', join(dir, 's2.json'), '--bars', file]);
    expect(misnamed.code).toBe(2);
    expect(misnamed.stderr).toContain('must be named NVDA.csv');
  });

  it('exits 2 when the store file is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-publish-'));
    const store = join(dir, 'store.json');
    await writeFile(store, '[]\n', 'utf8');
    const result = await run(['--store', store]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/windows|expected an object/);
  });
});
