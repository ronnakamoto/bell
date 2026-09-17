/**
 * The challenge-verify composition root.
 *
 * Exercises `main` with argv rather than spawning node, so usage, fixture, and outcome codes are
 * assertions rather than a smoke script's only record.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { main, type TextWriter } from '../../src/cli/verify.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/challenge.json', import.meta.url),
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

describe('main', () => {
  it('exits 0 when the overnight commitment is upheld', async () => {
    const result = await run(['--case', 'upheld-overnight']);
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

  it('accepts an explicit --fixture path', async () => {
    const result = await run(['--case', 'upheld-overnight', '--fixture', FIXTURE_PATH]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kind=upheld');
  });

  it('exits 2 when --case is missing', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--case is required');
    expect(result.stdout).toBe('');
  });

  it('exits 2 when the labelled case is not in the fixture', async () => {
    const result = await run(['--case', 'no-such-case']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no case labelled no-such-case');
  });

  it('exits 2 when the fixture file is missing', async () => {
    const result = await run([
      '--case',
      'upheld-overnight',
      '--fixture',
      '/no/such/challenge.json',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no challenge case fixture at');
  });
});
