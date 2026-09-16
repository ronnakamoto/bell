/**
 * A BELL-IV source backed by a JSON fixture.
 *
 * The adapter the web slice reads committed publish inputs from. Everything that can go wrong with
 * the file goes wrong here: the format, the encoding, and the shape of each row. `domain/` receives
 * `IvPublishInput` value objects and never learns that a file was involved.
 *
 * Every failure is a typed adapter error rather than a bare `Error`, so a caller can tell a missing
 * file from a malformed one — one is retryable and the other is terminal.
 */

import { readFile } from 'node:fs/promises';

import { type IvProvenance } from '../domain/iv.js';
import { type IvPublishInput, type IvReadingFields, type IvSource } from '../domain/ports.js';

/** The file could not be read at all. Retryable, in the sense that the file may appear. */
export class IvSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IvSourceUnavailable';
  }
}

/** The file was read but its contents are not an IV fixture. Terminal. */
export class IvSourceMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IvSourceMalformed';
  }
}

/**
 * Reads one JSON file of fixture BELL-IV publish inputs.
 *
 * The path rather than an in-memory map is the configuration, because the committed fixture is one
 * publisher rather than one-file-per-session.
 */
export class FileIvSource implements IvSource {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Every publish input in the file, in the order the file records them. */
  async readings(): Promise<readonly IvPublishInput[]> {
    const text = await readIvFile(this.path);
    return parseIvDocument(this.path, text);
  }
}

/** Read the file, distinguishing "not there" from "there and unreadable". */
async function readIvFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new IvSourceUnavailable(`no iv fixture at ${path}`);
    }
    throw new IvSourceUnavailable(`could not read ${path}: ${describeError(error)}`);
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

/** An error's message, for the message of an `IvSourceUnavailable`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse the document and refuse anything that is not a list of IV publish rows.
 *
 * Exported so a caller that already holds the text — a test fixture, an in-memory replay — can use
 * the same refusals without going through the filesystem.
 */
export function parseIvDocument(path: string, text: string): readonly IvPublishInput[] {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new IvSourceMalformed(`${path}: ${describeError(error)}`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new IvSourceMalformed(`${path}: expected an object with a readings array`);
  }
  if (!('readings' in document)) {
    throw new IvSourceMalformed(`${path}: expected an object with a readings array`);
  }
  const { readings } = document;
  if (!Array.isArray(readings)) {
    throw new IvSourceMalformed(`${path}: readings must be an array`);
  }
  return readings.map((entry, index) => parseIvEntry(path, index, entry));
}

function parseIvEntry(path: string, index: number, entry: unknown): IvPublishInput {
  const label = `readings[${String(index)}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new IvSourceMalformed(`${path}: ${label}: expected an object`);
  }
  const row = entry as Record<string, unknown>;
  const forSessionAddress = requireString(path, label, row, 'forSessionAddress').toLowerCase();
  const viewSession = parseBigIntField(path, label, row, 'viewSession');
  const pool = parseReadingFields(path, `${label}.pool`, row['pool']);
  const fallback = parseFallback(path, `${label}.fallback`, row['fallback']);
  if (!('boundSessions' in row)) {
    return { forSessionAddress, viewSession, pool, fallback };
  }
  return {
    forSessionAddress,
    viewSession,
    boundSessions: parseBigIntField(path, label, row, 'boundSessions'),
    pool,
    fallback,
  };
}

function parseFallback(path: string, label: string, value: unknown): IvReadingFields | null {
  if (value === null) return null;
  return parseReadingFields(path, label, value);
}

function parseReadingFields(path: string, label: string, value: unknown): IvReadingFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IvSourceMalformed(`${path}: ${label}: expected an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    sigmaWad: parseBigIntField(path, label, row, 'sigmaWad'),
    session: parseBigIntField(path, label, row, 'session'),
    provenance: parseProvenance(path, label, row),
  };
}

function parseProvenance(path: string, label: string, row: Record<string, unknown>): IvProvenance {
  const value = requireString(path, label, row, 'provenance');
  if (value === 'pool' || value === 'trailing-realised') return value;
  throw new IvSourceMalformed(`${path}: ${label}: unknown provenance ${value}`);
}

function requireString(
  path: string,
  label: string,
  row: Record<string, unknown>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new IvSourceMalformed(`${path}: ${label}: ${field} must be a string`);
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
    throw new IvSourceMalformed(`${path}: ${label}: ${field} must be a string-encoded integer`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new IvSourceMalformed(`${path}: ${label}: ${field} is not a valid integer`);
  }
}
