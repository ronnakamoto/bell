/**
 * A gap source backed by a CSV file.
 *
 * The adapter the domain's `GapSource` port exists for. Everything that can go wrong with a file goes
 * wrong here and nowhere else: the format, the encoding, the date parsing, the unit conversion and the
 * row-level validation. `domain/` receives `DailyBar` value objects and never learns that a file was
 * involved, which is what lets the domain be tested with literals.
 *
 * Every failure is a typed adapter error rather than a `ValueError`, so the application layer can tell
 * a missing file from a malformed one — one is retryable and the other is terminal, and the brief's
 * §9.2 requires that distinction to be expressible.
 *
 * **Every departure below was measured, not reasoned about, and the differential over 58 fixtures is
 * what measured it.** Three of the four are the same failure mode — the oracle lets something escape
 * this layer that this layer exists to stop — and the fourth is a narrowing of a grammar the port
 * declines to reimplement.
 *
 * 1. **A negative `next_open` is refused, where the Python accepts it (F64a).** The Python bounds
 *    `close > 0` and not `next_open`, so a row reading `2026-09-10,100.00,-5.00` produces a `DailyBar`
 *    whose `.gap()` computes fine and which then dies inside `rowsDigest` at
 *    `uintToBytes(..., 32, ...)` — `OverflowError` in the Python, and a `DomainError` three layers down
 *    in the port. That is exactly the leak this adapter's own contract exists to prevent, so the port
 *    closes it here with `GapSourceMalformed`, which blames the data.
 *
 *    The Python's own test on this subject is named `test_a_negative_open_is_read_rather_than_refused`
 *    and its fixture is `2026-09-10,100.00,50.00` — a **positive** open and a negative *gap*. So the
 *    test documents an asymmetry as deliberate while asserting something else, and the real negative
 *    open was never exercised. The port keeps that test, under a name that says what it does.
 *
 *    The bound is `next_open < 0` and not `next_open <= 0`, and the difference is the point: each bound
 *    in this file exists because a *named downstream operation* cannot handle the value. `close <= 0`
 *    is refused because `DailyBar.gap` divides by it; `next_open < 0` is refused because `rowsDigest`
 *    encodes it as an unsigned 256-bit integer. An open of exactly zero is a -100% gap, which both can
 *    handle, so it is read.
 *
 * 2. **A short row is refused, where the Python raises `AttributeError`.** A row with fewer fields
 *    than the header gives `csv.DictReader` a `None` for the missing column, and the Python then calls
 *    `.strip()` on it: measured, `2026-09-10,100.00` under a three-column header raises
 *    `AttributeError: 'NoneType' object has no attribute 'strip'`, which is not in the Python's
 *    `except (KeyError, ValueError, DecimalException)` and therefore escapes the adapter entirely.
 *    The port reads the absent cell as the empty string, so the failure lands in the `try` below and
 *    is named `GapSourceMalformed` with its row number — the same outcome as any other unparseable
 *    cell, and the one the adapter's docstring promises. A short row is the most likely malformed file
 *    there is, so this is the leak most worth closing.
 *
 * 3. **A date in a format other than `YYYY-MM-DD` is refused (F63).** Measured against CPython 3.13,
 *    `date.fromisoformat` accepts three forms this adapter refuses — `YYYYMMDD`, an ISO week date with
 *    a day (`2026-W37-4`) and one without (`2026-W37`) — and refuses the ordinal form `YYYY-DDD`
 *    exactly as `dateOrdinal` does. The port refuses the three, because reimplementing three more
 *    grammars would mean three more places for a day number to be silently wrong, and a wrong day
 *    number is unobservable on chain (see `domain/dates.ts`). The narrowing is in the domain, not
 *    here; this file simply does not undo it.
 *
 * 4. **The upper bound is left to `rowsDigest` rather than duplicated here.** A price at or above 2^256
 *    also fails to encode, but reaching it needs a price around 1e59, and adding a fifth departure
 *    from the oracle for an input no source can emit is not worth the noise it puts into the
 *    differential. Stated so the omission reads as a decision.
 *
 * **And one departure in the other direction, found rather than designed: a byte-order mark.** Every
 * cell is trimmed before it is parsed, and JavaScript's `String.trim()` and Python's `str.strip()`
 * disagree about what whitespace is — in *both* directions. `trim()` removes `U+FEFF`, which `strip()`
 * keeps, so a cell carrying a BOM is read here and refused by the oracle (the fixture `bom`). `strip()`
 * removes `U+0085` and `U+001C`, which `trim()` keeps, so those are the reverse. The line reader
 * diverges the same way, because Python's `str.splitlines` breaks on `U+0085`, `U+000B`, `U+001C`,
 * `U+2028` and `U+2029` and RFC 4180 breaks on `CRLF`, `CR` and `LF`. See F65.
 *
 * **A fifth departure this header used to claim, and the differential disproved.** An earlier version
 * said that Python's `text.splitlines()` destroys a newline inside a quoted field, so the port's
 * RFC 4180 reader would read a file the oracle could not. Measured, that is false: `csv.reader`
 * reassembles a quoted field across as many lines as it takes, so `"2026-09-10\n",100.00,102.00` is
 * read identically by both, and the fixture `quoted_date_newline` is one of the ones the two agree on
 * byte for byte. The claim was removed rather than kept as a difference that does not exist.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dateOrdinal } from '../domain/dates.js';
import { DailyBar, Wad } from '../domain/models.js';
import { type GapSource, type SymbolLike } from '../domain/ports.js';

/**
 * The columns a source file must carry.
 *
 * Named rather than positional so that a file with an extra column is accepted and one with the columns
 * reordered is not silently misread. Both are verified against the oracle rather than assumed: a
 * four-column file and a `close,date,next_open` file are both read correctly by the Python and here.
 */
export const DATE_COLUMN = 'date';
export const CLOSE_COLUMN = 'close';
export const NEXT_OPEN_COLUMN = 'next_open';

/** The columns, in the order the error message lists them. */
export const REQUIRED_COLUMNS: readonly string[] = [DATE_COLUMN, CLOSE_COLUMN, NEXT_OPEN_COLUMN];

/** The file could not be read at all. Retryable, in the sense that the file may appear. */
export class GapSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GapSourceUnavailable';
  }
}

/** The file was read but its contents are not a gap series. Terminal. */
export class GapSourceMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GapSourceMalformed';
  }
}

/**
 * Reads one CSV per symbol from a directory.
 *
 * The directory rather than the file is the configuration, so the symbol selects the file and the
 * adapter holds no per-symbol state. A symbol with no file is `GapSourceUnavailable`, which is the same
 * outcome as a symbol whose file has not been written yet — and the caller cannot tell the difference,
 * which is correct because it has the same remedy.
 */
export class CsvGapSource implements GapSource {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Every daily bar for `symbol`, oldest first.
   *
   * `async` because the read is: the port's `GapSource` returns a promise because a source will
   * eventually be a network call, and the port is not decorated with a promise it does not use. A
   * `Promise`-returning method that threw synchronously would put its refusals outside the reach of a
   * caller's `.catch`, which is a contract no type signature shows.
   */
  async dailyBars(symbol: SymbolLike): Promise<readonly DailyBar[]> {
    const path = join(this.root, `${symbol.text}.csv`);
    const text = await readGapFile(path);
    const records = parseCsv(text);

    // `csv.DictReader` skips an empty record rather than yielding one, so a blank line between rows is
    // not an error in the oracle and must not become one here. It also means the row numbers below
    // count *records*, not physical lines.
    const header = records[0];
    if (header === undefined) {
      throw new GapSourceMalformed(`${path} has a header but no rows`);
    }
    const dataRows = records.slice(1).filter((record) => record.length > 0);
    if (dataRows.length === 0) {
      throw new GapSourceMalformed(`${path} has a header but no rows`);
    }

    const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
    if (missing.length > 0) {
      throw new GapSourceMalformed(
        `${path} is missing ${missing.join(', ')}; expected ${REQUIRED_COLUMNS.join(', ')}`,
      );
    }

    const columns = new Map<string, number>();
    header.forEach((name, index) => columns.set(name, index));

    const bars = dataRows.map((record, index) => parseRow(path, index, record, columns));
    return [...bars].sort(compareByTradingDate);
  }
}

/** Read the file, distinguishing "not there" from "there and unreadable". */
async function readGapFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    // `FileNotFoundError` is a subclass of `OSError`, so the Python's first handler catches the missing
    // file and the second is reachable only from something that is not a missing file — a directory
    // where the file should be, whose read raises `IsADirectoryError` (Node: `EISDIR`). Both outcomes
    // are `GapSourceUnavailable`, a datum the service cannot obtain, rather than `GapSourceMalformed`,
    // which would blame the data and route the session differently.
    if (errorCode(error) === 'ENOENT') {
      throw new GapSourceUnavailable(`no gap series at ${path}`);
    }
    throw new GapSourceUnavailable(`could not read ${path}: ${describeError(error)}`);
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

/** An error's message, for the message of a `GapSourceUnavailable`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One row, with every failure named by its line so a malformed file is fixable.
 *
 * The line number counts *records*, not physical lines, because `csv.DictReader` skips a blank record
 * before the row is numbered — so a file whose second record is blank reports the next bad row as
 * "row 3" while it sits on physical line 4. Verified against the oracle rather than reasoned about.
 * Reproduced rather than corrected: the number is in the message so a malformed file is fixable, and a
 * port that renumbered would disagree with the oracle about which row it is complaining about.
 */
function parseRow(
  path: string,
  index: number,
  record: readonly string[],
  columns: ReadonlyMap<string, number>,
): DailyBar {
  const line = `row ${String(index + 2)}`;
  const cell = (name: string): string => record[columns.get(name) ?? -1] ?? '';

  let tradingDate: string;
  let close: Wad;
  let nextOpen: Wad;
  try {
    tradingDate = cell(DATE_COLUMN).trim();
    // Called for its refusal, not its value. The Python's `date.fromisoformat` both parsed the date and
    // validated it; the port's `DailyBar` carries the string unparsed, so the validation has to be
    // requested explicitly. The day number is computed again by `rowsDigest` when it is wanted, and
    // dropped here — computing it twice is cheaper than a second copy of the rule.
    dateOrdinal(tradingDate);
    close = Wad.fromStr(cell(CLOSE_COLUMN).trim());
    nextOpen = Wad.fromStr(cell(NEXT_OPEN_COLUMN).trim());
  } catch (error) {
    // The Python catches `(KeyError, ValueError, DecimalException)` and the last is not cosmetic:
    // `Decimal("one hundred")` raises `InvalidOperation`, which derives from `ArithmeticError` rather
    // than from `ValueError`, so an `except ValueError` alone would let a malformed price escape the
    // adapter as a decimal exception. In TypeScript both failures are plain `Error`s, and catching both
    // is the same statement.
    throw new GapSourceMalformed(`${path} ${line}: ${describeError(error)}`);
  }
  if (close.raw <= 0n) {
    throw new GapSourceMalformed(`${path} ${line}: a close must be positive`);
  }
  if (nextOpen.raw < 0n) {
    throw new GapSourceMalformed(`${path} ${line}: a next open cannot be negative`);
  }
  return new DailyBar(tradingDate, close, nextOpen);
}

/** Oldest first. ISO 8601 calendar dates order lexicographically and chronologically alike. */
function compareByTradingDate(left: DailyBar, right: DailyBar): number {
  if (left.tradingDate < right.tradingDate) return -1;
  if (left.tradingDate > right.tradingDate) return 1;
  return 0;
}

/**
 * A CSV file as records of fields, per RFC 4180.
 *
 * Written out rather than taken from a library for the reason `digest.ts` spells its preimage out: the
 * layout is short enough to check by reading, and a dependency that changed its quoting rules would
 * silently change what a gap series is. It handles quoted fields, doubled quotes inside them, `CRLF`,
 * and a newline inside a quoted field.
 *
 * A blank line yields an empty record rather than a record with one empty field, which is what Python's
 * `csv` module does and what makes the caller's "skip an empty record" step correct.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    // Unreachable, and written anyway: the type checker does not narrow an indexed access from the
    // loop condition, so without this every `field += character` below is a `string | undefined`
    // concatenation. A guard that cannot fire is better than an assertion that cannot be checked.
    if (character === undefined) break;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === ',') {
      record.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (character === '\r' || character === '\n') {
      // A `CRLF` pair is one terminator, and a lone `CR` is one too — Python's `str.splitlines` breaks
      // on either, so the oracle reads a file that uses bare `CR` and a reader that only broke on `\n`
      // would not. The first version of this reader discarded `\r` outright, which turned a CR-only
      // file into one malformed record; the differential fixture `cr_only` is what caught it.
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      if (field !== '' || record.length > 0) record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }

  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}
