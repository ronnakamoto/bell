/**
 * The CSV gap source.
 *
 * The adapter is where a file's problems are supposed to live, so every way a file can be wrong is
 * tested here rather than three layers up. Each failure is a *typed* adapter error, because the
 * application layer has to tell a missing file from a malformed one — one is retryable and the other
 * is terminal, and the brief's §9.2 requires that distinction to be expressible.
 *
 * Ported from `calibrator/tests/unit/test_gap_source_file.py`, which has 12 tests in two classes; this
 * file has 26. The Python file's own docstring claims the same thing this header does — that every way
 * a file can be wrong is tested here — and the fourteen added tests are the ones where that was not
 * true of the Python. They fall into four groups:
 *
 *  - **Two places where the oracle lets a failure escape the layer it is guarding.** A negative
 *    `next_open` is accepted by the Python and dies inside `rows_digest` with an `OverflowError` three
 *    layers down (F64a); a short row raises `AttributeError` from `csv.DictReader`'s `None`, which is
 *    not in the Python's `except` clause and so escapes the adapter entirely. The port names both.
 *  - **One narrowing.** A `YYYYMMDD` date and an ISO week date are accepted by the Python's
 *    `date.fromisoformat` and refused by the port's `dateOrdinal` (F63) — three grammars the port
 *    declines to reimplement. The ordinal form `YYYY-DDD` is refused by both, measured.
 *  - **One boundary, written around the refusal above.** An open of *exactly* zero is still read: the
 *    bound is `< 0` and not `<= 0`, and the difference is the whole argument for where the bound goes.
 *  - **Ten that close gaps the Python's suite has but does not fill** — an extra column, reordered
 *    columns, `CRLF`, a lone `CR`, a quoted field, a newline inside a quoted field, a day outside its
 *    month, the record-numbering of a blank line, the refusal's error *type*, and a byte-order mark.
 *    The last two are the interesting ones: the BOM is the only *loosening* in the file (F65), and the
 *    lone `CR` is a case the differential could see and this suite could not until it was added.
 *
 * Every one of the fourteen was measured against the Python rather than reasoned about, and each is
 * recorded in `DESIGN_NOTES.md`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Decimal } from 'decimal.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CsvGapSource,
  GapSourceMalformed,
  GapSourceUnavailable,
} from '../../src/adapters/gap_source_file.js';
import { WAD } from '../../src/domain/constants.js';
import { Symbol } from '../../src/domain/models.js';

/** A decimal literal at WAD scale, exactly, the way the Python's `int(Decimal(v) * WAD)` does it. */
const wad = (value: string): bigint => BigInt(new Decimal(value).times(WAD.toString()).toFixed(0));

const NVDA = new Symbol('NVDA');
const TSLA = new Symbol('TSLA');
const HEADER = 'date,close,next_open\n';

let root: string;

beforeEach(() => {
  // A fresh directory per test, so a file written by one cannot be read by the next. The Python gets
  // this from `tmp_path`; the port has to make it.
  root = mkdtempSync(join(tmpdir(), 'bell-gap-'));
});

/** Write a file for `symbol` and return a source rooted at the directory. */
function write(symbol: Symbol, body: string, header = HEADER): CsvGapSource {
  writeFileSync(join(root, `${symbol.text}.csv`), header + body, 'utf8');
  return new CsvGapSource(root);
}

describe('reading', () => {
  it('a well-formed series is read', async () => {
    const source = write(NVDA, '2026-09-10,100.00,102.00\n2026-09-11,102.00,101.00\n');
    const bars = await source.dailyBars(NVDA);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.close.raw).toBe(100n * WAD);
    expect(bars[0]!.nextOpen.raw).toBe(102n * WAD);
  });

  it('the gap is the close-to-open return', async () => {
    const source = write(NVDA, '2026-09-10,100.00,102.00\n');
    expect((await source.dailyBars(NVDA))[0]!.gap().raw).toBe(wad('0.02'));
  });

  it('the series is returned oldest first', async () => {
    // A file written newest-first is read oldest-first. The window is defined as the *last* N
    // sessions, so a source that returned a reversed series would calibrate on the wrong rows.
    const source = write(NVDA, '2026-09-11,102.00,101.00\n2026-09-10,100.00,102.00\n');
    const bars = await source.dailyBars(NVDA);
    expect(bars.map((bar) => bar.tradingDate)).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('a missing file is unavailable rather than malformed', async () => {
    await expect(new CsvGapSource(root).dailyBars(TSLA)).rejects.toThrow(/no gap series/);
    await expect(new CsvGapSource(root).dailyBars(TSLA)).rejects.toThrow(GapSourceUnavailable);
  });

  it('an unreadable path is unavailable rather than malformed', async () => {
    // The `OSError` branch that a missing file does not reach.
    //
    // `FileNotFoundError` is a subclass of `OSError`, so the missing-file test above is caught by the
    // first handler and never touches the second. A directory where the file should be is the simplest
    // error that is not a missing file: the path exists, so the first handler does not catch it, and
    // reading it raises `IsADirectoryError` (Node: `EISDIR`).
    //
    // The distinction is load-bearing. Both outcomes are `GapSourceUnavailable` — a datum the service
    // cannot obtain — rather than `GapSourceMalformed`, which would blame the data and route the
    // session differently.
    mkdirSync(join(root, 'NVDA.csv'));
    const error: unknown = await new CsvGapSource(root)
      .dailyBars(NVDA)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GapSourceUnavailable);
    expect(error).not.toBeInstanceOf(GapSourceMalformed);
    expect((error as Error).message).toMatch(/could not read/);
  });

  it('a file for one symbol is not returned for another', async () => {
    write(NVDA, '2026-09-10,100.00,102.00\n');
    await expect(new CsvGapSource(root).dailyBars(TSLA)).rejects.toThrow(GapSourceUnavailable);
  });

  it('an extra column is accepted', async () => {
    // Added by the port, though the Python behaves the same way. The columns are named rather than
    // positional, and this is the test that makes that a fact: a source that grew a `volume` column
    // must not stop being readable.
    const source = write(NVDA, '2026-09-10,100.00,102.00,1200\n', 'date,close,next_open,volume\n');
    expect((await source.dailyBars(NVDA))[0]!.close.raw).toBe(100n * WAD);
  });

  it('the columns may be in any order', async () => {
    // Added by the port. Named mapping means a reordered file is read correctly rather than silently
    // misread, which is the failure mode the Python's comment claims to prevent.
    const source = write(NVDA, '100.00,2026-09-10,102.00\n', 'close,date,next_open\n');
    const bar = (await source.dailyBars(NVDA))[0]!;
    expect(bar.tradingDate).toBe('2026-09-10');
    expect(bar.close.raw).toBe(100n * WAD);
    expect(bar.nextOpen.raw).toBe(102n * WAD);
  });

  it('CRLF line endings are read', async () => {
    const source = write(NVDA, '2026-09-10,100.00,102.00\r\n2026-09-11,102.00,101.00\r\n');
    expect(await source.dailyBars(NVDA)).toHaveLength(2);
  });

  it('a lone CR ends a line', async () => {
    // Added by the port *after* the differential caught the first version of `parseCsv` getting this
    // wrong. It discarded `\r` outright rather than treating it as a terminator, so a file using bare
    // CR — which Python's `str.splitlines` reads as two lines — became one malformed record.
    //
    // The probe direction `cr_not_a_terminator` reproduces that bug and leaves this whole file green,
    // so the differential was the only thing that saw it. That is why this test exists: a case the
    // differential can see and the suite cannot is a case the suite is missing.
    const source = write(NVDA, '2026-09-10,100.00,102.00\r2026-09-11,102.00,101.00\r');
    const bars = await source.dailyBars(NVDA);
    expect(bars.map((bar) => bar.tradingDate)).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('a byte-order mark inside a cell is stripped', async () => {
    // Added by the port, and it pins a *loosening* rather than a refusal: JavaScript's `String.trim()`
    // strips `U+FEFF` and Python's `str.strip()` does not, so the port reads a cell the oracle refuses.
    // Measured rather than assumed, and found by the differential — `bom` is one of the fixtures the
    // two sides disagree on. See F65.
    //
    // Recorded rather than corrected. Reading a file whose first data cell carries a BOM is the
    // *better* behaviour and it is what a spreadsheet export produces; reproducing Python's answer
    // would mean writing a `strip()` that is deliberately narrower than the language's.
    const source = write(NVDA, '\ufeff2026-09-10,100.00,102.00\n');
    expect((await source.dailyBars(NVDA))[0]!.tradingDate).toBe('2026-09-10');
  });

  it('a quoted field is read', async () => {
    const source = write(NVDA, '2026-09-10,"100.00",102.00\n');
    expect((await source.dailyBars(NVDA))[0]!.close.raw).toBe(100n * WAD);
  });

  it('a newline inside a quoted field is read', async () => {
    // Added by the port to pin a behaviour, and it turned out to pin an *agreement* rather than a
    // departure. The expectation when this test was written was that Python's `text.splitlines()` —
    // called before `csv` sees the text — would destroy a newline inside a quoted field, so the port
    // would read a file the oracle could not. Measured, that is false: `csv.reader` reassembles a
    // quoted field across as many lines as it takes, so both sides read this file and the differential
    // fixture `quoted_date_newline` is one of the ones the two agree on byte for byte.
    //
    // Kept, because the reader is the port's own code and a quoted field spanning a line is the case
    // most likely to break it; the comment is corrected because the departure it claimed does not
    // exist. The `trim()` in `parseRow` is what turns the field back into a date.
    const source = write(NVDA, '"2026-09-10\n",100.00,102.00\n');
    const bar = (await source.dailyBars(NVDA))[0]!;
    expect(bar.tradingDate).toBe('2026-09-10');
    expect(bar.close.raw).toBe(100n * WAD);
  });
});

describe('malformed files', () => {
  it('a missing column is refused', async () => {
    const source = write(NVDA, '2026-09-10,100.00\n', 'date,close\n');
    await expect(source.dailyBars(NVDA)).rejects.toThrow(/next_open/);
  });

  it('a header with no rows is refused', async () => {
    await expect(write(NVDA, '').dailyBars(NVDA)).rejects.toThrow(/no rows/);
  });

  it('an unparseable date names its line', async () => {
    // The line number is in the message because a malformed file has to be fixable, and "row 3" is
    // the difference between a fixable file and a hunt.
    const source = write(NVDA, '2026-09-10,100.00,102.00\nnot-a-date,100.00,102.00\n');
    await expect(source.dailyBars(NVDA)).rejects.toThrow(/row 3/);
  });

  it('a non-numeric price is refused', async () => {
    const source = write(NVDA, '2026-09-10,one hundred,102.00\n');
    await expect(source.dailyBars(NVDA)).rejects.toThrow(/row 2/);
  });

  it('a non-positive close is refused', async () => {
    // A zero or negative close makes the gap ratio undefined, and `DailyBar.gap` would raise a bare
    // error from three layers down rather than an adapter error here.
    const source = write(NVDA, '2026-09-10,0.00,102.00\n');
    await expect(source.dailyBars(NVDA)).rejects.toThrow(/must be positive/);
  });

  it('a negative gap from a positive open is read', async () => {
    // The Python's test of this name is `test_a_negative_open_is_read_rather_than_refused` and its
    // fixture is `2026-09-10,100.00,50.00` — a **positive** open and a negative *gap*, which is what
    // this asserts. The port keeps the assertion and renames the test after it, because the name the
    // oracle used describes the asymmetry it intended to document and the fixture does not exercise
    // the case it names. The real negative open is the next test.
    const source = write(NVDA, '2026-09-10,100.00,50.00\n');
    expect((await source.dailyBars(NVDA))[0]!.gap().raw).toBe(-WAD / 2n);
  });

  it('a negative next open is refused', async () => {
    // Added by the port; the Python accepts this row. `DailyBar.gap` computes `-1.05` from it happily,
    // and `rows_digest` then fails encoding it as an unsigned 256-bit integer — three layers below the
    // adapter whose entire contract is that a file's problems live here. See F64a.
    const source = write(NVDA, '2026-09-10,100.00,-5.00\n');
    await expect(source.dailyBars(NVDA)).rejects.toThrow(/a next open cannot be negative/);
  });

  it('a next open of exactly zero is read', async () => {
    // Added by the port, and it is the boundary the test above is written around. An open of zero is a
    // -100% gap, which `gap` and `rowsDigest` both handle; the bound is `< 0` because the reason for
    // each bound in the adapter is a *named downstream operation* that cannot handle the value.
    const source = write(NVDA, '2026-09-10,100.00,0.00\n');
    const bar = (await source.dailyBars(NVDA))[0]!;
    expect(bar.nextOpen.raw).toBe(0n);
    expect(bar.gap().raw).toBe(-WAD);
  });

  it('a short row is refused rather than throwing from the reader', async () => {
    // Added by the port; the Python raises `AttributeError: 'NoneType' object has no attribute
    // 'strip'`, which is not in its `except (KeyError, ValueError, DecimalException)` and therefore
    // escapes the adapter. A short row is the most likely malformed file there is, so this is the leak
    // most worth closing.
    const source = write(NVDA, '2026-09-10,100.00\n');
    await expect(source.dailyBars(NVDA)).rejects.toThrow(GapSourceMalformed);
  });

  it('a compact date is refused', async () => {
    // Added by the port. Python's `date.fromisoformat` accepts `YYYYMMDD` as well as `YYYY-MM-DD`, and
    // measured, the Python reads this file. The port's `dateOrdinal` accepts only the hyphenated form
    // (F63): reimplementing three more grammars is three more places for a day number to be silently
    // wrong, and a wrong day number is unobservable on chain.
    const source = write(NVDA, '20260910,100.00,102.00\n');
    await expect(source.dailyBars(NVDA)).rejects.toThrow(/expected YYYY-MM-DD/);
  });

  it('a day outside the month is refused', async () => {
    // Added by the port. The Python refuses this too, from `date.fromisoformat`; the port refuses it
    // from `dateOrdinal`, and the assertion is here because a date that *parses* as four digits and a
    // dash is not yet a date.
    await expect(write(NVDA, '2026-02-30,100.00,102.00\n').dailyBars(NVDA)).rejects.toThrow(
      /day is out of range/,
    );
  });

  it('a blank line is skipped and the row number counts records', async () => {
    // Added by the port, and it pins the oracle's least intuitive behaviour. `csv.DictReader` skips an
    // empty line before the row is numbered, so the second *record* is on physical line 4 and is
    // reported as "row 3". Reproduced rather than corrected: the number is in the message so a
    // malformed file is fixable, and a port that renumbered would disagree with the oracle about which
    // row it is complaining about.
    //
    // **The assertion names the offending value as well as the row, and the first version did not.**
    // It asserted `/row 3/` alone, which the *broken* port also satisfies: with the blank record left
    // in, the blank row is itself index 1 and reports "row 3" — an empty date rather than `bad`. The
    // probe direction `blanks_not_filtered` left the suite green, which is how this was found.
    const source = write(NVDA, '2026-09-10,100.00,102.00\n\nbad,100.00,102.00\n');
    await expect(source.dailyBars(NVDA)).rejects.toThrow(/row 3: [^"]*"bad"/);
  });

  it('a malformed file is refused with a named error type', async () => {
    // Added by the port. The Python raises `GapSourceMalformed`, which is a bare `Exception` subclass
    // and therefore catchable — but `GapSourceUnavailable` is its sibling, and the whole reason the two
    // exist is that a caller must be able to branch. This asserts the branch is real.
    const error: unknown = await write(NVDA, '2026-09-10,0.00,102.00\n')
      .dailyBars(NVDA)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GapSourceMalformed);
    expect(error).not.toBeInstanceOf(GapSourceUnavailable);
  });
});
