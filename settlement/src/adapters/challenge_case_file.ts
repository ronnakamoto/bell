/**
 * Challenge cases backed by a JSON fixture.
 *
 * The adapter the CLI's `--case` flag exists for. Everything that can go wrong with the file goes
 * wrong here: the format, the encoding, hex width, and the bigint-as-string rule the fixture guard
 * exists to keep. `application/` receives a `ChallengeCase` and never learns that a file was
 * involved, which is what lets `verifyChallenge` stay a thin wrap of `adjudicate`.
 *
 * Every failure is a typed adapter error rather than a bare `Error`, so a caller can tell a missing
 * file from a malformed one — one is retryable and the other is terminal.
 */

import { readFile } from 'node:fs/promises';

import { bytesFromHex } from '@bell/calibrator/domain/bytes.js';
import { DIGEST_BYTES } from '@bell/calibrator/domain/models.js';

import { type RefitRunner, type RefittedParameters } from '../domain/adjudication.js';

/** The file could not be read at all. Retryable, in the sense that the file may appear. */
export class ChallengeCaseUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChallengeCaseUnavailable';
  }
}

/** The file was read but its contents are not a challenge-case fixture. Terminal. */
export class ChallengeCaseMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChallengeCaseMalformed';
  }
}

/** The parameters a fixture-backed re-run returns, or `null` when inputs are unavailable. */
export interface ChallengeRefit {
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
}

/** One labelled challenge case, with hex decoded and integers as `bigint`. */
export interface ChallengeCase {
  readonly label: string;
  readonly nameId: Uint8Array;
  readonly forSession: bigint;
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
  readonly inputsHash: Uint8Array;
  readonly expectedDigest: Uint8Array;
  readonly refit: ChallengeRefit | null;
}

/**
 * Parse the document and refuse anything that is not a list of challenge cases.
 *
 * Exported so a caller that already holds the text — a test fixture, an in-memory replay — can use
 * the same refusals without going through the filesystem.
 */
export function parseChallengeDocument(path: string, text: string): readonly ChallengeCase[] {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ChallengeCaseMalformed(`${path}: ${describeError(error)}`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new ChallengeCaseMalformed(`${path}: expected an object with a cases array`);
  }
  if (!('cases' in document)) {
    throw new ChallengeCaseMalformed(`${path}: expected an object with a cases array`);
  }
  const { cases } = document;
  if (!Array.isArray(cases)) {
    throw new ChallengeCaseMalformed(`${path}: cases must be an array`);
  }
  return cases.map((entry, index) => parseChallengeCase(path, index, entry));
}

/**
 * Load one labelled case from a fixture file.
 *
 * A missing path is `ChallengeCaseUnavailable`; a present file that does not contain `label` is
 * `ChallengeCaseMalformed` — the file was the document, and the document is wrong for this request.
 */
export async function loadChallengeCase(path: string, label: string): Promise<ChallengeCase> {
  const text = await readChallengeFile(path);
  const cases = parseChallengeDocument(path, text);
  const found = cases.find((entry) => entry.label === label);
  if (found === undefined) {
    throw new ChallengeCaseMalformed(`${path}: no case labelled ${label}`);
  }
  return found;
}

/**
 * A `RefitRunner` from a fixture case.
 *
 * `null` is the inputs-unavailable outcome: the runner always resolves `undefined`. A present
 * object is a stub re-run that returns those parameters regardless of `inputsHash` — this slice has
 * no committed-input store, and the fixture *is* the re-run.
 */
export function refitFromCase(loaded: ChallengeCase): RefitRunner {
  const { refit } = loaded;
  if (refit === null) {
    return (): Promise<undefined> => Promise.resolve(undefined);
  }
  const parameters: RefittedParameters = {
    lambdaWad: refit.lambdaWad,
    premiumWad: refit.premiumWad,
  };
  return (): Promise<RefittedParameters> => Promise.resolve(parameters);
}

/** Read the file, distinguishing "not there" from "there and unreadable". */
async function readChallengeFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new ChallengeCaseUnavailable(`no challenge case fixture at ${path}`);
    }
    throw new ChallengeCaseUnavailable(`could not read ${path}: ${describeError(error)}`);
  }
}

function parseChallengeCase(path: string, index: number, entry: unknown): ChallengeCase {
  const where = `cases[${String(index)}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ChallengeCaseMalformed(`${path}: ${where}: expected an object`);
  }
  const row = entry as Record<string, unknown>;
  return {
    label: requireString(path, where, row, 'label'),
    nameId: parseBytes32Field(path, where, row, 'nameId'),
    forSession: parseBigIntField(path, where, row, 'forSession'),
    lambdaWad: parseBigIntField(path, where, row, 'lambdaWad'),
    premiumWad: parseBigIntField(path, where, row, 'premiumWad'),
    inputsHash: parseBytes32Field(path, where, row, 'inputsHash'),
    expectedDigest: parseBytes32Field(path, where, row, 'expectedDigest'),
    refit: parseRefit(path, `${where}.refit`, row['refit']),
  };
}

function parseRefit(path: string, where: string, value: unknown): ChallengeRefit | null {
  if (value === null) return null;
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChallengeCaseMalformed(`${path}: ${where}: expected an object or null`);
  }
  const row = value as Record<string, unknown>;
  return {
    lambdaWad: parseBigIntField(path, where, row, 'lambdaWad'),
    premiumWad: parseBigIntField(path, where, row, 'premiumWad'),
  };
}

function parseBytes32Field(
  path: string,
  where: string,
  row: Record<string, unknown>,
  field: string,
): Uint8Array {
  const text = requireString(path, where, row, field);
  if (!text.startsWith('0x')) {
    throw new ChallengeCaseMalformed(`${path}: ${where}: ${field} must be 0x-prefixed hex`);
  }
  let bytes: Uint8Array;
  try {
    bytes = bytesFromHex(text);
  } catch (error) {
    throw new ChallengeCaseMalformed(`${path}: ${where}: ${field}: ${describeError(error)}`);
  }
  if (bytes.length !== DIGEST_BYTES) {
    throw new ChallengeCaseMalformed(`${path}: ${where}: ${field} must be 32 bytes`);
  }
  return bytes;
}

function requireString(
  path: string,
  where: string,
  row: Record<string, unknown>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new ChallengeCaseMalformed(`${path}: ${where}: ${field} must be a string`);
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
    throw new ChallengeCaseMalformed(
      `${path}: ${where}: ${field} must be a string-encoded integer`,
    );
  }
  try {
    return BigInt(value);
  } catch {
    throw new ChallengeCaseMalformed(`${path}: ${where}: ${field} is not a valid integer`);
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

/** An error's message, for the message of an adapter error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
