/**
 * The file-backed log source.
 *
 * The adapter is where a file's problems are supposed to live, so every way a file can be wrong is
 * tested here rather than three layers up. Each failure is a typed adapter error, because a caller
 * has to tell a missing file from a malformed one — one is retryable and the other is terminal.
 *
 * The acceptance test is the producer corpus: reading `spec/fixtures/logs.json` and folding it must
 * recover the same session the fold's own suite asserts against a literal list. An adapter that
 * reshaped the corpus would be a place for the consumer's assumptions to enter the producer's
 * output, which is the failure the oracle exists to prevent.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FileLogSource,
  LogSourceMalformed,
  LogSourceUnavailable,
  parseLogDocument,
} from '../../src/adapters/log_source_file.js';
import { catalogueFrom } from '../../src/application/catalogue.js';

const CORPUS_PATH = fileURLToPath(new URL('../../../spec/fixtures/logs.json', import.meta.url));
const SESSION_CREATED = '0xbfea4ffed12dea0f10d6ed0862b3b921c451b49a70efdd3461d7423842282b00';
const SESSION_REGISTERED = '0x28e487a6111e0cb65c7a6ef4ffc45a36e06b481fb2cf18dbde02b4c88e6aee67';
const COMMITTED = '0x8c8ec3404e0fe9635c7532cb2fabce3bb5e9f7e539e917ac8765bbea6a7696d8';

function writeTemp(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bell-logs-'));
  const path = join(root, 'logs.json');
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('reading the producer corpus', () => {
  it('yields every log the fixture carries', async () => {
    const logs = await new FileLogSource(CORPUS_PATH).logs();
    expect(logs).toHaveLength(29);
    expect(logs[0]?.topics[0]).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('folds into the same settled session the fold suite asserts', async () => {
    const source = new FileLogSource(CORPUS_PATH);
    const logs = await source.logs();
    const created = logs.find((log) => log.topics[0] === SESSION_CREATED);
    const registered = logs.find((log) => log.topics[0] === SESSION_REGISTERED);
    const committed = logs.find((log) => log.topics[0] === COMMITTED);
    if (created === undefined || registered === undefined || committed === undefined) {
      throw new Error('the corpus is missing a singleton anchor');
    }
    const catalogue = await catalogueFrom(source, {
      factory: created.emitter,
      registry: registered.emitter,
      premium: committed.emitter,
    });
    expect(catalogue.sessions).toHaveLength(1);
    expect(catalogue.sessions[0]?.resolution).toEqual({
      branch: 'LivePrint',
      gapWad: 20_000_000_000_000_000n,
      payoffWad: 300_000_000_000_000_000n,
      settled: true,
    });
  });
});

describe('availability', () => {
  it('a missing file is unavailable rather than malformed', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bell-logs-')), 'absent.json');
    await expect(new FileLogSource(path).logs()).rejects.toThrow(LogSourceUnavailable);
    await expect(new FileLogSource(path).logs()).rejects.toThrow(/no log stream/);
  });

  it('an unreadable path is unavailable rather than malformed', async () => {
    // A directory where the file should be is the simplest path that is present and not a file.
    const path = mkdtempSync(join(tmpdir(), 'bell-logs-'));
    await expect(new FileLogSource(path).logs()).rejects.toThrow(LogSourceUnavailable);
    await expect(new FileLogSource(path).logs()).rejects.toThrow(/could not read/);
  });
});

describe('malformed documents', () => {
  it('refuses a non-JSON body', () => {
    expect(() => parseLogDocument('x.json', '{')).toThrow(LogSourceMalformed);
  });

  it('refuses a top-level array', () => {
    expect(() => parseLogDocument('x.json', '[]')).toThrow(/expected an object with a logs array/);
  });

  it('refuses an object without logs', () => {
    expect(() => parseLogDocument('x.json', '{"_note":"hi"}')).toThrow(
      /expected an object with a logs array/,
    );
  });

  it('refuses a logs field that is not an array', () => {
    expect(() => parseLogDocument('x.json', '{"logs":{}}')).toThrow(/logs must be an array/);
  });

  it('refuses a log that is not an object', () => {
    expect(() => parseLogDocument('x.json', '{"logs":[1]}')).toThrow(
      /log\[0\]: expected an object/,
    );
  });

  it('refuses a log whose topics are not strings', () => {
    expect(() =>
      parseLogDocument('x.json', '{"logs":[{"topics":[1],"data":"0x","emitter":"0x1"}]}'),
    ).toThrow(/topics must be an array of strings/);
  });

  it('refuses a log whose data is not a string', () => {
    expect(() =>
      parseLogDocument('x.json', '{"logs":[{"topics":[],"data":1,"emitter":"0x1"}]}'),
    ).toThrow(/data must be a string/);
  });

  it('refuses a log whose emitter is not a string', () => {
    expect(() =>
      parseLogDocument('x.json', '{"logs":[{"topics":[],"data":"0x","emitter":1}]}'),
    ).toThrow(/emitter must be a string/);
  });

  it('accepts an empty logs array', () => {
    expect(parseLogDocument('x.json', '{"logs":[]}')).toEqual([]);
  });

  it('ignores provenance keys the producer adds', async () => {
    const path = writeTemp(
      JSON.stringify({
        _generated: 'GENERATED',
        _note: 'ignored',
        logs: [{ topics: ['0xab'], data: '0x', emitter: '0x1' }],
      }),
    );
    expect(await new FileLogSource(path).logs()).toEqual([
      { topics: ['0xab'], data: '0x', emitter: '0x1' },
    ]);
  });
});
