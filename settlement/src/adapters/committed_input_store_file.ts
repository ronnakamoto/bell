/**
 * Committed-input windows backed by a JSON fixture.
 *
 * The adapter the challenge-verify path will ask for stored bars. Everything that can go wrong with
 * the file goes wrong here: the format, the encoding, hex width, and the bigint-as-string rule.
 * `application/` never learns that a file was involved.
 *
 * A missing key is `undefined` — ordinary unavailability — rather than an exception. A missing or
 * unreadable file is `CommittedInputStoreUnavailable`; a present file that is not this document is
 * `CommittedInputStoreMalformed`.
 *
 * `rowsDigest` is derived from the window via the calibrator's `rowsDigest`, so the digest cannot
 * drift from the bars a challenger would re-hash.
 */

import { readFile } from 'node:fs/promises';

import { rowsDigest } from '@bell/calibrator/application/calibrate.js';
import { bytesFromHex, hexOf } from '@bell/calibrator/domain/bytes.js';
import { DailyBar, DIGEST_BYTES, type SessionKind, Wad } from '@bell/calibrator/domain/models.js';
import { type Keccak } from '@bell/calibrator/domain/ports.js';

import {
  type CommittedBar,
  type CommittedInputStore,
  type CommittedWindow,
} from '../domain/ports.js';

/** The file could not be read at all. Retryable, in the sense that the file may appear. */
export class CommittedInputStoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommittedInputStoreUnavailable';
  }
}

/** The file was read but its contents are not a committed-input store. Terminal. */
export class CommittedInputStoreMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommittedInputStoreMalformed';
  }
}

/** Windows keyed by `0x`-prefixed lowercase `inputsHash`. */
export type CommittedWindows = ReadonlyMap<string, CommittedWindow>;

/**
 * Parse the document and refuse anything that is not a map of windows keyed by `inputsHash`.
 *
 * Exported so a caller that already holds the text — a test fixture, an in-memory replay — can use
 * the same refusals without going through the filesystem.
 */
export function parseCommittedInputsDocument(path: string, text: string): CommittedWindows {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CommittedInputStoreMalformed(`${path}: ${describeError(error)}`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new CommittedInputStoreMalformed(`${path}: expected an object with a windows object`);
  }
  if (!('windows' in document)) {
    throw new CommittedInputStoreMalformed(`${path}: expected an object with a windows object`);
  }
  const { windows } = document;
  if (windows === null || typeof windows !== 'object' || Array.isArray(windows)) {
    throw new CommittedInputStoreMalformed(`${path}: windows must be an object`);
  }
  const parsed = new Map<string, CommittedWindow>();
  for (const [key, value] of Object.entries(windows)) {
    parsed.set(parseWindowKey(path, key), parseWindow(path, key, value));
  }
  return parsed;
}

/**
 * Load a committed-input store from a fixture file.
 *
 * A missing path is `CommittedInputStoreUnavailable`. Keccak is injected so `rowsDigest` can be
 * derived from the window without the domain port taking a hash function.
 */
export async function loadCommittedInputStore(
  path: string,
  keccak: Keccak,
): Promise<FileCommittedInputStore> {
  const text = await readStoreFile(path);
  return new FileCommittedInputStore(parseCommittedInputsDocument(path, text), keccak);
}

/** File-backed store. `rowsDigest` hashes the window's bars with the injected keccak. */
export class FileCommittedInputStore implements CommittedInputStore {
  readonly #windows: CommittedWindows;
  readonly #keccak: Keccak;

  constructor(windows: CommittedWindows, keccak: Keccak) {
    this.#windows = new Map(windows);
    this.#keccak = keccak;
  }

  window(inputsHash: Uint8Array): Promise<CommittedWindow | undefined> {
    return Promise.resolve(this.#windows.get(keyOf(inputsHash)));
  }

  async rowsDigest(inputsHash: Uint8Array): Promise<Uint8Array | undefined> {
    const held = await this.window(inputsHash);
    if (held === undefined) return undefined;
    return rowsDigest(this.#keccak, dailyBarsOf(held.bars));
  }
}

/** Read the file, distinguishing "not there" from "there and unreadable". */
async function readStoreFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new CommittedInputStoreUnavailable(`no committed-input store at ${path}`);
    }
    throw new CommittedInputStoreUnavailable(`could not read ${path}: ${describeError(error)}`);
  }
}

function parseWindowKey(path: string, key: string): string {
  if (!key.startsWith('0x')) {
    throw new CommittedInputStoreMalformed(`${path}: window key must be 0x-prefixed hex`);
  }
  let bytes: Uint8Array;
  try {
    bytes = bytesFromHex(key);
  } catch (error) {
    throw new CommittedInputStoreMalformed(`${path}: window key: ${describeError(error)}`);
  }
  if (bytes.length !== DIGEST_BYTES) {
    throw new CommittedInputStoreMalformed(`${path}: window key must be 32 bytes`);
  }
  return `0x${hexOf(bytes)}`;
}

function parseWindow(path: string, key: string, value: unknown): CommittedWindow {
  const where = `windows[${key}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommittedInputStoreMalformed(`${path}: ${where}: expected an object`);
  }
  const row = value as Record<string, unknown>;
  const sourceIds = parseSourceIds(path, where, row);
  const barsValue = row['bars'];
  if (!Array.isArray(barsValue)) {
    throw new CommittedInputStoreMalformed(`${path}: ${where}: bars must be an array`);
  }
  return {
    symbol: requireString(path, where, row, 'symbol'),
    session: parseSession(path, where, row),
    windowSessions: parseWindowSessions(path, where, row),
    sourceIds,
    familyName: requireString(path, where, row, 'familyName'),
    bars: barsValue.map((entry, index) => parseBar(path, `${where}.bars[${String(index)}]`, entry)),
  };
}

function parseSession(path: string, where: string, row: Record<string, unknown>): SessionKind {
  const session = requireString(path, where, row, 'session');
  if (session === 'E' || session === 'W' || session === 'H' || session === 'C') {
    return session;
  }
  throw new CommittedInputStoreMalformed(`${path}: ${where}: session must be E, W, H, or C`);
}

function parseWindowSessions(path: string, where: string, row: Record<string, unknown>): number {
  const value = row['windowSessions'];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new CommittedInputStoreMalformed(
      `${path}: ${where}: windowSessions must be a positive integer`,
    );
  }
  return value;
}

function parseSourceIds(
  path: string,
  where: string,
  row: Record<string, unknown>,
): readonly string[] {
  const value = row['sourceIds'];
  if (!Array.isArray(value) || value.length === 0) {
    throw new CommittedInputStoreMalformed(
      `${path}: ${where}: sourceIds must be a non-empty array of strings`,
    );
  }
  const sourceIds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new CommittedInputStoreMalformed(
        `${path}: ${where}: sourceIds must be a non-empty array of strings`,
      );
    }
    sourceIds.push(entry);
  }
  return sourceIds;
}

function parseBar(path: string, where: string, value: unknown): CommittedBar {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommittedInputStoreMalformed(`${path}: ${where}: expected an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    tradingDate: requireString(path, where, row, 'tradingDate'),
    closeWad: parseBigIntField(path, where, row, 'closeWad'),
    nextOpenWad: parseBigIntField(path, where, row, 'nextOpenWad'),
  };
}

function requireString(
  path: string,
  where: string,
  row: Record<string, unknown>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new CommittedInputStoreMalformed(`${path}: ${where}: ${field} must be a string`);
  }
  return value;
}

function parseBigIntField(
  path: string,
  where: string,
  row: Record<string, unknown>,
  field: string,
): bigint {
  const value = row[field];
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new CommittedInputStoreMalformed(
      `${path}: ${where}: ${field} must be a string-encoded integer`,
    );
  }
  try {
    return BigInt(value);
  } catch {
    throw new CommittedInputStoreMalformed(`${path}: ${where}: ${field} is not a valid integer`);
  }
}

function dailyBarsOf(bars: readonly CommittedBar[]): DailyBar[] {
  return bars.map(
    (bar) => new DailyBar(bar.tradingDate, new Wad(bar.closeWad), new Wad(bar.nextOpenWad)),
  );
}

function keyOf(inputsHash: Uint8Array): string {
  return `0x${hexOf(inputsHash)}`;
}

/** The `code` of a Node filesystem error, or `undefined` for anything that is not one. */
function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** An error's message, for the message of an adapter error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
