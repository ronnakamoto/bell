/**
 * A log source backed by a JSON file.
 *
 * The adapter the domain's `LogSource` port exists for. Everything that can go wrong with a file goes
 * wrong here and nowhere else: the format, the encoding, and the shape of each record. `domain/`
 * receives `RawLog` value objects and never learns that a file was involved, which is what lets the
 * fold be tested with literals and what makes `indexer-domain-takes-only-the-shared-core` honest —
 * a domain module that reached `node:fs` would not be an indexer with a seam.
 *
 * **The accepted shape is the producer's.** `spec/fixtures/logs.json` is
 * `vm.getRecordedLogsJson()` wrapped in a provenance envelope (`_generated`, `_source`, `_note`,
 * `logs`). An adapter that required only the array would refuse the corpus the fold is verified
 * against; an adapter that required only the envelope fields would invent a contract the producer
 * does not make. So the only required field is `logs`, and every other key is ignored.
 *
 * Every failure is a typed adapter error rather than a bare `Error`, so a caller can tell a missing
 * file from a malformed one — one is retryable and the other is terminal, which is the same
 * distinction the calibrator's CSV adapter draws.
 */

import { readFile } from 'node:fs/promises';

import { type RawLog } from '../domain/log.js';
import { type LogSource } from '../domain/ports.js';

/** The file could not be read at all. Retryable, in the sense that the file may appear. */
export class LogSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogSourceUnavailable';
  }
}

/** The file was read but its contents are not a log stream. Terminal. */
export class LogSourceMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogSourceMalformed';
  }
}

/**
 * Reads one JSON file of raw logs.
 *
 * The path rather than a directory is the configuration, because a log stream is one history rather
 * than one-file-per-symbol. A missing path is `LogSourceUnavailable`; a present but unreadable path
 * is the same outcome for the same reason the CSV adapter collapses them — the remedy is identical.
 */
export class FileLogSource implements LogSource {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Every log in the file, in the order the file records them.
   *
   * `async` because the read is: the port returns a promise because a source will eventually be a
   * network call. A `Promise`-returning method that threw synchronously would put its refusals
   * outside the reach of a caller's `.catch`.
   */
  async logs(): Promise<readonly RawLog[]> {
    const text = await readLogFile(this.path);
    return parseLogDocument(this.path, text);
  }
}

/** Read the file, distinguishing "not there" from "there and unreadable". */
async function readLogFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new LogSourceUnavailable(`no log stream at ${path}`);
    }
    throw new LogSourceUnavailable(`could not read ${path}: ${describeError(error)}`);
  }
}

/** The `code` of a Node filesystem error, or `undefined` for anything that is not one. */
function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** An error's message, for the message of a `LogSourceUnavailable`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse the document and refuse anything that is not a list of raw logs.
 *
 * Exported so a caller that already holds the text — a test fixture, an in-memory replay — can use
 * the same refusals without going through the filesystem. The fold still never sees this module.
 */
export function parseLogDocument(path: string, text: string): readonly RawLog[] {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new LogSourceMalformed(`${path}: ${describeError(error)}`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new LogSourceMalformed(`${path}: expected an object with a logs array`);
  }
  if (!('logs' in document)) {
    throw new LogSourceMalformed(`${path}: expected an object with a logs array`);
  }
  const { logs } = document;
  if (!Array.isArray(logs)) {
    throw new LogSourceMalformed(`${path}: logs must be an array`);
  }
  return logs.map((entry, index) => parseRawLog(path, index, entry));
}

/** One log record, with every failure naming its index so a malformed file is fixable. */
function parseRawLog(path: string, index: number, entry: unknown): RawLog {
  const where = `${path} log[${String(index)}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new LogSourceMalformed(`${where}: expected an object`);
  }
  const record = entry as Record<string, unknown>;
  const topics = record['topics'];
  const data = record['data'];
  const emitter = record['emitter'];
  if (!Array.isArray(topics) || !topics.every((topic) => typeof topic === 'string')) {
    throw new LogSourceMalformed(`${where}: topics must be an array of strings`);
  }
  if (typeof data !== 'string') {
    throw new LogSourceMalformed(`${where}: data must be a string`);
  }
  if (typeof emitter !== 'string') {
    throw new LogSourceMalformed(`${where}: emitter must be a string`);
  }
  return { topics, data, emitter };
}
