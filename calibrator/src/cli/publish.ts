/**
 * Calibrator publish composition root.
 *
 * Wires file/synthetic bars, noble keccak, `calibrate`, `publish`, the recording publisher, the
 * committed-input store writer, and the commit intent preview. Nothing in `application/` or `domain/`
 * learns that a CLI invoked them — this file is the first importer that is allowed to see both layers
 * at once.
 */

import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';

import {
  CommittedInputStoreWriterMalformed,
  CommittedInputStoreWriterUnavailable,
  mergeCommittedWindow,
} from '../adapters/committed_input_store_writer.js';
import {
  CsvGapSource,
  GapSourceMalformed,
  GapSourceUnavailable,
} from '../adapters/gap_source_file.js';
import { nobleKeccak } from '../adapters/keccak_noble.js';
import { RecordingPublisher } from '../adapters/publisher_recording.js';
import { RpcMalformed, RpcUnavailable } from '../adapters/rpc_client.js';
import { calibrate, CalibrationRequest } from '../application/calibrate.js';
import { publish, PublishRequest } from '../application/publish.js';
import { hexOf } from '../domain/bytes.js';
import { buildCommit } from '../domain/commit_intent.js';
import { WAD } from '../domain/constants.js';
import { nameId } from '../domain/digest.js';
import { seedFamily } from '../domain/families/index.js';
import { DailyBar, DomainError, SessionKind, Symbol, Wad } from '../domain/models.js';
import {
  broadcastIntent,
  BroadcastUsageError,
  requireBroadcastFlags,
} from './publish_broadcast.js';

const USAGE =
  'usage: publish [--bars <csv-or-dir>] [--store <path>] [--symbol <sym>] [--session E|W|H|C] [--window <n>] [--source-id <id>]... [--for-session <n>] [--current-session <n>] [--rpc-url <url> --private-key <hex> --premium <address>]';

const DEFAULT_SYMBOL = 'NVDA';
const DEFAULT_SESSION = SessionKind.OVERNIGHT;
const DEFAULT_WINDOW = 100;
const DEFAULT_SOURCE_ID = 'test-fixture';
const DEFAULT_FOR_SESSION = 12_345n;
const DEFAULT_CURRENT_SESSION = 0n;
const SYNTHETIC_GAP = '0.01';
const SYNTHETIC_BAR_START = '2020-01-06';

/** A sink the CLI writes a line to. `process.stdout` satisfies it. */
export interface TextWriter {
  write(chunk: string): unknown;
}

/** Stdout and stderr for `main`, so a test can capture both without mocking `process`. */
export interface PublishCliIo {
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
}

const PROCESS_IO: PublishCliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Thrown when the argv cannot be read as a publish invocation. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

interface ParsedArgs {
  readonly barsPath: string | undefined;
  readonly storePath: string;
  readonly symbol: string;
  readonly session: SessionKind;
  readonly windowSessions: number;
  readonly sourceIds: readonly string[];
  readonly forSession: bigint;
  readonly currentSession: bigint;
  readonly rpcUrl: string | undefined;
  readonly privateKey: string | undefined;
  readonly premium: string | undefined;
}

function defaultStorePath(): string {
  return fileURLToPath(new URL('../../../.recon/committed_inputs_publish.json', import.meta.url));
}

function parseSession(value: string): SessionKind {
  const allowed = Object.values(SessionKind) as string[];
  if (!allowed.includes(value)) {
    throw new UsageError(`--session must be one of ${allowed.join('|')}\n${USAGE}`);
  }
  return value as SessionKind;
}

function parseNonNegativeBigInt(flag: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${flag} must be a non-negative integer\n${USAGE}`);
  }
  return BigInt(value);
}

function parsePositiveInt(flag: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new UsageError(`${flag} must be a positive integer\n${USAGE}`);
  }
  return Number(value);
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  let barsPath: string | undefined;
  let storePath: string | undefined;
  let symbol = DEFAULT_SYMBOL;
  let session: SessionKind = DEFAULT_SESSION;
  let windowSessions = DEFAULT_WINDOW;
  const sourceIds: string[] = [];
  let forSession = DEFAULT_FOR_SESSION;
  let currentSession = DEFAULT_CURRENT_SESSION;
  let rpcUrl: string | undefined;
  let privateKey: string | undefined;
  let premium: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      throw new UsageError(USAGE);
    }
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new UsageError(`${argument} needs a value\n${USAGE}`);
      }
      index += 1;
      return next;
    };
    switch (argument) {
      case '--bars':
        barsPath = resolve(value());
        break;
      case '--store':
        storePath = resolve(value());
        break;
      case '--symbol':
        symbol = value();
        break;
      case '--session':
        session = parseSession(value());
        break;
      case '--window':
        windowSessions = parsePositiveInt('--window', value());
        break;
      case '--source-id':
        sourceIds.push(value());
        break;
      case '--for-session':
        forSession = parseNonNegativeBigInt('--for-session', value());
        break;
      case '--current-session':
        currentSession = parseNonNegativeBigInt('--current-session', value());
        break;
      case '--rpc-url':
        rpcUrl = value();
        break;
      case '--private-key':
        privateKey = value();
        break;
      case '--premium':
        premium = value();
        break;
      default:
        throw new UsageError(`unknown argument: ${argument}\n${USAGE}`);
    }
  }

  return {
    barsPath,
    storePath: storePath ?? defaultStorePath(),
    symbol,
    session,
    windowSessions,
    sourceIds: sourceIds.length === 0 ? [DEFAULT_SOURCE_ID] : sourceIds,
    forSession,
    currentSession,
    rpcUrl,
    privateKey,
    premium,
  };
}

/** `date(2020, 1, 6) + timedelta(days=offset)`, independent of `dateOrdinal`. */
function isoDateFrom(startIso: string, offset: number): string {
  const base = Date.UTC(
    Number(startIso.slice(0, 4)),
    Number(startIso.slice(5, 7)) - 1,
    Number(startIso.slice(8, 10)),
  );
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A hermetic bar series whose gaps are exactly the ones given.
 *
 * Same construction as `tools/gen_challenge_store_fixture.ts`: close held at 100, next open from the
 * gap, `Decimal` product truncated so a gap of `0.01` is a bar with `nextOpen = 101`.
 */
function barsFromGaps(gaps: readonly string[], start = SYNTHETIC_BAR_START): DailyBar[] {
  return gaps.map((gap, index) => {
    const move = BigInt(new Decimal(gap).times(WAD.toString()).trunc().toFixed(0));
    return new DailyBar(
      isoDateFrom(start, index),
      new Wad(100n * WAD),
      new Wad(100n * WAD + move * 100n),
    );
  });
}

function syntheticBars(windowSessions: number): DailyBar[] {
  return barsFromGaps(Array.from({ length: windowSessions }, () => SYNTHETIC_GAP));
}

async function loadBars(
  barsPath: string | undefined,
  symbol: Symbol,
  windowSessions: number,
): Promise<readonly DailyBar[]> {
  if (barsPath === undefined) {
    return syntheticBars(windowSessions);
  }
  const info = await stat(barsPath).catch((error: unknown) => {
    throw new GapSourceUnavailable(`could not read ${barsPath}: ${describeError(error)}`);
  });
  if (info.isDirectory()) {
    return new CsvGapSource(barsPath).dailyBars(symbol);
  }
  // Single CSV file: the source still keys by symbol text, so the file must live as `{symbol}.csv`.
  const root = dirname(barsPath);
  const expected = join(root, `${symbol.text}.csv`);
  if (resolve(barsPath) !== resolve(expected)) {
    throw new UsageError(
      `--bars file must be named ${symbol.text}.csv (got ${barsPath})\n${USAGE}`,
    );
  }
  return new CsvGapSource(root).dailyBars(symbol);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIntent(batch: ReturnType<typeof buildCommit>): string {
  const lines = [`kind=${batch.kind}`];
  batch.steps.forEach((step, index) => {
    const args = step.args
      .map((arg) => (typeof arg === 'bigint' ? arg.toString() : arg))
      .join(', ');
    lines.push(`  ${String(index + 1)}. ${step.target}.${step.method}(${args})`);
  });
  return lines.join('\n');
}

/**
 * Calibrate, publish (or refuse), write the window on success, and print the commit intent.
 *
 * 0 — published. 1 — alreadyOpen or insufficient. 2 — usage / I/O / malformed.
 */
export async function main(
  argv: readonly string[],
  io: PublishCliIo = PROCESS_IO,
): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const symbol = new Symbol(parsed.symbol);
    const bars = await loadBars(parsed.barsPath, symbol, parsed.windowSessions);
    const request = new CalibrationRequest({
      symbol,
      session: parsed.session,
      windowSessions: parsed.windowSessions,
      sourceIds: parsed.sourceIds,
    });
    const result = calibrate(request, bars, seedFamily(), nobleKeccak);
    if (result.kind === 'insufficient') {
      io.stdout.write(
        `kind=insufficient observations=${String(result.observations)} required=${String(result.requiredTailObservations)}\n`,
      );
      return 1;
    }

    const published = await publish(
      new PublishRequest({ parameters: result.parameters, forSession: parsed.forSession }),
      new RecordingPublisher(),
      nobleKeccak,
      { currentSession: parsed.currentSession },
    );
    if (published.kind === 'alreadyOpen') {
      io.stdout.write(
        `kind=alreadyOpen forSession=${published.forSession.toString()} currentSession=${published.currentSession.toString()}\n`,
      );
      return 1;
    }

    const windowBars = bars.slice(bars.length - parsed.windowSessions);
    const inputsHashHex = `0x${hexOf(result.parameters.inputsHash)}`;
    await mergeCommittedWindow({
      path: parsed.storePath,
      inputsHashHex,
      window: {
        symbol: result.parameters.symbol.text,
        session: result.parameters.session,
        windowSessions: parsed.windowSessions,
        sourceIds: parsed.sourceIds,
        familyName: result.parameters.model,
        bars: windowBars.map((bar) => ({
          tradingDate: bar.tradingDate,
          closeWad: bar.close.raw.toString(),
          nextOpenWad: bar.nextOpen.raw.toString(),
        })),
      },
      keccak: nobleKeccak,
    });

    const digestHex = `0x${hexOf(published.digest)}`;
    const nameIdHex = `0x${hexOf(nameId(nobleKeccak, result.parameters.symbol))}`;
    const intent = buildCommit({
      nameId: nameIdHex,
      forSession: published.forSession,
      lambdaWad: published.lambdaWad,
      premiumWad: published.premiumWad,
      inputsHash: inputsHashHex,
    });

    io.stdout.write(
      [
        `kind=published forSession=${published.forSession.toString()} model=${published.model}`,
        `inputsHash=${inputsHashHex}`,
        `lambdaWad=${published.lambdaWad.toString()}`,
        `premiumWad=${published.premiumWad.toString()}`,
        `digest=${digestHex}`,
        `store=${parsed.storePath}`,
        formatIntent(intent),
      ].join('\n') + '\n',
    );
    if (
      parsed.rpcUrl !== undefined ||
      parsed.privateKey !== undefined ||
      parsed.premium !== undefined
    ) {
      await broadcastIntent(intent, requireBroadcastFlags(parsed), (line) => io.stdout.write(line));
    }
    return 0;
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof GapSourceUnavailable ||
      error instanceof GapSourceMalformed ||
      error instanceof CommittedInputStoreWriterUnavailable ||
      error instanceof CommittedInputStoreWriterMalformed ||
      error instanceof DomainError ||
      error instanceof RpcUnavailable ||
      error instanceof RpcMalformed ||
      error instanceof BroadcastUsageError
    ) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
}

if (invokedDirectly()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
