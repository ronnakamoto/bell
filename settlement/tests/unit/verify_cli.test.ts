/**
 * The challenge-verify composition root.
 *
 * Exercises `main` with argv rather than spawning node, so usage, fixture, store, and outcome codes
 * are assertions rather than a smoke script's only record.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type FetchLike } from '../../src/adapters/committed_input_store_http.js';
import { main, type TextWriter } from '../../src/cli/verify.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/challenge.json', import.meta.url),
);
const STORE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/committed_inputs.json', import.meta.url),
);

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

async function run(
  argv: readonly string[],
  options: { env?: Record<string, string | undefined>; fetch?: FetchLike } = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, { stdout: stdout.writer, stderr: stderr.writer }, options);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('main', () => {
  it('exits 0 when the store re-fit upholds the commitment', async () => {
    const result = await run(['--case', 'upheld-store']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind=upheld');
    expect(result.stderr).toBe('');
  });

  it('exits 1 when the expected digest does not reproduce', async () => {
    const result = await run(['--case', 'digest-mismatch']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('kind=digest-mismatch');
    expect(result.stderr).toBe('');
  });

  it('exits 1 when inputs are unavailable', async () => {
    const result = await run(['--case', 'inputs-unavailable']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('kind=inputs-unavailable');
  });

  it('exits 1 when the refit premium is slashed', async () => {
    const result = await run(['--case', 'slashed-premium']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('kind=slashed');
  });

  it('accepts an explicit --fixture path', async () => {
    const result = await run(['--case', 'upheld-store', '--fixture', FIXTURE_PATH]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind=upheld');
  });

  it('accepts an explicit --store path', async () => {
    const result = await run(['--case', 'upheld-store', '--store', STORE_PATH]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind=upheld');
  });

  it('exits 2 when --case is missing', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--case is required');
    expect(result.stdout).toBe('');
  });

  it('exits 2 when --case is present but empty', async () => {
    const result = await run(['--case', '']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--case is required');
  });

  it('exits 2 when --case has no value', async () => {
    const result = await run(['--case']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--case needs a value');
  });

  it('exits 2 when --fixture has no value', async () => {
    const result = await run(['--case', 'upheld-store', '--fixture']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--fixture needs a value');
  });

  it('exits 2 when --store has no value', async () => {
    const result = await run(['--case', 'upheld-store', '--store']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--store needs a value');
  });

  it('exits 2 on an unknown argument', async () => {
    const result = await run(['--case', 'upheld-store', '--nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown argument: --nope');
  });

  it('exits 2 when the labelled case is not in the fixture', async () => {
    const result = await run(['--case', 'no-such-case']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no case labelled no-such-case');
  });

  it('exits 2 when the fixture file is missing', async () => {
    const result = await run(['--case', 'upheld-store', '--fixture', '/no/such/challenge.json']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no challenge case fixture at');
  });

  it('exits 2 when the store file is missing', async () => {
    const result = await run([
      '--case',
      'upheld-store',
      '--store',
      '/no/such/committed_inputs.json',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no committed-input store at');
  });

  it('exits 2 when the store file is present but not a store', async () => {
    const result = await run(['--case', 'upheld-store', '--store', FIXTURE_PATH]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('expected an object with a windows object');
  });

  it('re-fits from HTTP when BELL_INPUT_STORE_URL is set', async () => {
    const storeDocument = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as {
      windows: Record<string, unknown>;
    };
    const challengeDocument = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
      cases: readonly { label: string; inputsHash: string }[];
    };
    const upheld = challengeDocument.cases.find((entry) => entry.label === 'upheld-store');
    if (upheld === undefined) throw new Error('missing upheld-store');
    const window = storeDocument.windows[upheld.inputsHash];
    if (window === undefined) throw new Error('missing window');

    const result = await run(['--case', 'upheld-store'], {
      env: { BELL_INPUT_STORE_URL: 'https://store.example/inputs' },
      fetch: async (url) => {
        await Promise.resolve();
        expect(url).toBe(`https://store.example/inputs/${upheld.inputsHash}`);
        return new Response(JSON.stringify(window), { status: 200 });
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind=upheld');
  });

  it('explicit --store forces the file even when the URL is set', async () => {
    const result = await run(['--case', 'upheld-store', '--store', STORE_PATH], {
      env: { BELL_INPUT_STORE_URL: 'https://store.example/inputs' },
      fetch: async () => {
        await Promise.resolve();
        throw new Error('must not fetch');
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind=upheld');
  });
});
