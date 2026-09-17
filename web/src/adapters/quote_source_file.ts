/**
 * A quote source backed by a JSON fixture.
 *
 * The adapter the web slice reads committed oracle quotes from. Everything that can go wrong with
 * the file goes wrong here: the format, the encoding, and the shape of each row. `domain/` receives
 * `Quote` value objects and never learns that a file was involved.
 *
 * Every failure is a typed adapter error rather than a bare `Error`, so a caller can tell a missing
 * file from a malformed one — one is retryable and the other is terminal.
 */

import { readFile } from 'node:fs/promises';

import { type QuoteFixtureRow, type QuoteSource } from '../domain/ports.js';
import { type Quote } from '../domain/quote.js';

/** The file could not be read at all. Retryable, in the sense that the file may appear. */
export class QuoteSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteSourceUnavailable';
  }
}

/** The file was read but its contents are not a quote fixture. Terminal. */
export class QuoteSourceMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteSourceMalformed';
  }
}

/** One fixture row keyed by `(nameId, forSession)`. */
export type QuoteEntry = QuoteFixtureRow;

/**
 * Reads one JSON file of fixture quotes.
 *
 * The path rather than an in-memory map is the configuration, because the committed fixture is one
 * oracle rather than one-file-per-name.
 */
export class FileQuoteSource implements QuoteSource {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Every quote in the file, in the order the file records them. */
  async quotes(): Promise<readonly QuoteEntry[]> {
    const text = await readQuoteFile(this.path);
    return parseQuoteDocument(this.path, text);
  }

  /** The quote for `(nameId, forSession)`, or `Refuse` when the key is absent. */
  async quote(nameId: string, forSession: bigint): Promise<Quote> {
    const entries = await this.quotes();
    const match = entries.find(
      (entry) => entry.nameId === nameId && entry.forSession === forSession,
    );
    return match?.quote ?? { verdict: 'Refuse' };
  }
}

/** Read the file, distinguishing "not there" from "there and unreadable". */
async function readQuoteFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new QuoteSourceUnavailable(`no quote fixture at ${path}`);
    }
    throw new QuoteSourceUnavailable(`could not read ${path}: ${describeError(error)}`);
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

/** An error's message, for the message of a `QuoteSourceUnavailable`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse the document and refuse anything that is not a list of quote rows.
 *
 * Exported so a caller that already holds the text — a test fixture, an in-memory replay — can use
 * the same refusals without going through the filesystem.
 */
export function parseQuoteDocument(path: string, text: string): readonly QuoteEntry[] {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new QuoteSourceMalformed(`${path}: ${describeError(error)}`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new QuoteSourceMalformed(`${path}: expected an object with a quotes array`);
  }
  if (!('quotes' in document)) {
    throw new QuoteSourceMalformed(`${path}: expected an object with a quotes array`);
  }
  const { quotes } = document;
  if (!Array.isArray(quotes)) {
    throw new QuoteSourceMalformed(`${path}: quotes must be an array`);
  }
  return quotes.map((entry, index) => parseQuoteEntry(path, index, entry));
}

function parseQuoteEntry(path: string, index: number, entry: unknown): QuoteEntry {
  const label = `quotes[${String(index)}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new QuoteSourceMalformed(`${path}: ${label}: expected an object`);
  }
  const row = entry as Record<string, unknown>;
  const nameId = requireString(path, label, row, 'nameId');
  const forSession = parseBigIntField(path, label, row, 'forSession');
  const verdict = requireString(path, label, row, 'verdict');
  switch (verdict) {
    case 'Usable':
    case 'Fallback':
      return {
        nameId,
        forSession,
        quote: {
          verdict,
          lambdaWad: parseBigIntField(path, label, row, 'lambdaWad'),
          premiumWad: parseBigIntField(path, label, row, 'premiumWad'),
        },
      };
    case 'Refuse':
      return { nameId, forSession, quote: { verdict: 'Refuse' } };
    default:
      throw new QuoteSourceMalformed(`${path}: ${label}: unknown verdict ${verdict}`);
  }
}

function requireString(
  path: string,
  label: string,
  row: Record<string, unknown>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new QuoteSourceMalformed(`${path}: ${label}: ${field} must be a string`);
  }
  return value;
}

function parseBigIntField(
  path: string,
  label: string,
  row: Record<string, unknown>,
  field: string,
): bigint {
  const value = row[field];
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new QuoteSourceMalformed(`${path}: ${label}: ${field} must be a string-encoded integer`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new QuoteSourceMalformed(`${path}: ${label}: ${field} is not a valid integer`);
  }
}
