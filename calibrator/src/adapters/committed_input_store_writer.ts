/**
 * Merge one committed window into a `committed_inputs.json`-shaped file.
 *
 * The challenge-verify path reads this document. Everything that can go wrong with the file — missing
 * path, malformed JSON, wrong shape — is named here so the CLI can exit 2 without inventing a second
 * grammar. WAD fields must already be decimal strings on the payload; this writer does not coerce
 * numbers (a JSON number above 2^53 would silently round).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { rowsDigest } from '../application/calibrate.js';
import { hexOf } from '../domain/bytes.js';
import { inputsHash } from '../domain/digest.js';
import { DailyBar, type SessionKind, Wad } from '../domain/models.js';
import { type Keccak } from '../domain/ports.js';

/** The file could not be read or created. */
export class CommittedInputStoreWriterUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommittedInputStoreWriterUnavailable';
  }
}

/** The path exists but is not a committed-input store document. */
export class CommittedInputStoreWriterMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommittedInputStoreWriterMalformed';
  }
}

/** One bar as the store file records it. WADs are strings so a JS reader cannot round them. */
export interface StoreBarPayload {
  readonly tradingDate: string;
  readonly closeWad: string;
  readonly nextOpenWad: string;
}

/** The window payload keyed by `inputsHash`. Matches settlement's committed-input fixture shape. */
export interface StoreWindowPayload {
  readonly symbol: string;
  readonly session: SessionKind;
  readonly windowSessions: number;
  readonly sourceIds: readonly string[];
  readonly familyName: string;
  readonly bars: readonly StoreBarPayload[];
}

const HASH_KEY = /^0x[0-9a-f]{64}$/;

/**
 * Create or update `windows[inputsHashHex]` in the document at `path`.
 *
 * A missing file is created. An existing file keeps other windows. The hash key must already be
 * lowercase `0x` + 64 hex — callers hex the digest; this refuses a mixed-case key so the store cannot
 * hold two spellings of the same hash.
 *
 * The key is verified against the window's own content: the `inputsHash` is recomputed from the
 * window's metadata and rows and must equal the key. A window stored under a hash it does not
 * produce would let the store serve inputs the publisher never committed, so the writer refuses it
 * rather than persisting a broken binding.
 */
export async function mergeCommittedWindow(input: {
  readonly path: string;
  readonly inputsHashHex: string;
  readonly window: StoreWindowPayload;
  readonly keccak: Keccak;
}): Promise<void> {
  if (!HASH_KEY.test(input.inputsHashHex)) {
    throw new CommittedInputStoreWriterMalformed(
      `inputsHash key must be 0x followed by 64 lowercase hex characters`,
    );
  }

  const computed = inputsHash(
    input.keccak,
    input.window.windowSessions,
    input.window.session,
    input.window.sourceIds,
    input.window.windowSessions,
    rowsDigest(input.keccak, dailyBarsOf(input.window.bars)),
  );
  if (hexOf(computed) !== input.inputsHashHex.slice(2)) {
    throw new CommittedInputStoreWriterMalformed(
      `the window's content does not hash to the key ${input.inputsHashHex}; ` +
        `refusing to store a window under a hash it does not produce`,
    );
  }

  let document: { windows: Record<string, StoreWindowPayload> };
  let text: string | undefined;
  try {
    text = await readFile(input.path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new CommittedInputStoreWriterUnavailable(
        `could not read ${input.path}: ${describeError(error)}`,
      );
    }
  }

  if (text === undefined) {
    document = { windows: {} };
  } else {
    document = parseDocument(input.path, text);
  }

  document.windows[input.inputsHashHex] = input.window;

  try {
    await mkdir(dirname(input.path), { recursive: true });
    await writeFile(input.path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new CommittedInputStoreWriterUnavailable(
      `could not write ${input.path}: ${describeError(error)}`,
    );
  }
}

function parseDocument(
  path: string,
  text: string,
): { windows: Record<string, StoreWindowPayload> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CommittedInputStoreWriterMalformed(`${path}: ${describeError(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommittedInputStoreWriterMalformed(
      `${path}: expected an object with a windows object`,
    );
  }
  if (!('windows' in parsed)) {
    throw new CommittedInputStoreWriterMalformed(
      `${path}: expected an object with a windows object`,
    );
  }
  const { windows } = parsed;
  if (windows === null || typeof windows !== 'object' || Array.isArray(windows)) {
    throw new CommittedInputStoreWriterMalformed(`${path}: windows must be an object`);
  }
  return { windows: { ...(windows as Record<string, StoreWindowPayload>) } };
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The window's bars as the calibrator's `DailyBar`s, so the digest is over the same rows a fit reads. */
function dailyBarsOf(bars: readonly StoreBarPayload[]): DailyBar[] {
  return bars.map(
    (bar) =>
      new DailyBar(
        bar.tradingDate,
        new Wad(BigInt(bar.closeWad)),
        new Wad(BigInt(bar.nextOpenWad)),
      ),
  );
}
