/**
 * Challenge-verify composition root.
 *
 * Wires the file-backed case adapter, the committed-input store, the noble keccak adapter, and
 * `verifyChallenge`. Nothing in `application/` or `domain/` learns that a CLI invoked them — this
 * file is the first importer that is allowed to see both layers at once.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChallengeCaseMalformed,
  ChallengeCaseUnavailable,
  loadChallengeCase,
} from '../adapters/challenge_case_file.js';
import {
  CommittedInputStoreMalformed,
  CommittedInputStoreUnavailable,
} from '../adapters/committed_input_store_file.js';
import { type FetchLike } from '../adapters/committed_input_store_http.js';
import { nobleKeccak } from '../adapters/keccak_noble.js';
import { refitFromStore } from '../adapters/refit_from_store.js';
import { resolveCommittedInputStore } from '../adapters/resolve_input_store.js';
import { formatChallengeReport, verifyChallenge } from '../application/verify_challenge.js';
import { CommittedParameterSet } from '../domain/adjudication.js';

const USAGE = 'usage: verify --case <label> [--fixture <path>] [--store <path>]';

/** A sink the CLI writes a line to. `process.stdout` satisfies it. */
export interface TextWriter {
  write(chunk: string): unknown;
}

/** Stdout and stderr for `main`, so a test can capture both without mocking `process`. */
export interface ChallengeVerifyIo {
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
}

const PROCESS_IO: ChallengeVerifyIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Thrown when the argv cannot be read as a verify invocation. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

interface ParsedArgs {
  readonly caseLabel: string;
  readonly fixturePath: string;
  readonly storePath: string;
  /** True when `--store` was passed — forces the file store even if BELL_INPUT_STORE_URL is set. */
  readonly storePathExplicit: boolean;
}

function defaultFixturePath(): string {
  return fileURLToPath(new URL('../../../spec/fixtures/challenge.json', import.meta.url));
}

function defaultStorePath(): string {
  return fileURLToPath(new URL('../../../spec/fixtures/committed_inputs.json', import.meta.url));
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  let caseLabel: string | undefined;
  let fixturePath: string | undefined;
  let storePath: string | undefined;
  let storePathExplicit = false;
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
      case '--case':
        caseLabel = value();
        break;
      case '--fixture':
        fixturePath = value();
        break;
      case '--store':
        storePath = value();
        storePathExplicit = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${argument}\n${USAGE}`);
    }
  }
  if (caseLabel === undefined || caseLabel === '') {
    throw new UsageError(`--case is required\n${USAGE}`);
  }
  return {
    caseLabel,
    fixturePath: fixturePath === undefined ? defaultFixturePath() : resolve(fixturePath),
    storePath: storePath === undefined ? defaultStorePath() : resolve(storePath),
    storePathExplicit,
  };
}

/** Optional env / fetch for tests; production uses `process.env` and global fetch. */
export interface ChallengeVerifyOptions {
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: FetchLike;
}

/**
 * Run one labelled challenge case and return the process exit code.
 *
 * 0 — the commitment was upheld. 1 — it was not. 2 — the invocation, fixture, or store is unusable.
 */
export async function main(
  argv: readonly string[],
  io: ChallengeVerifyIo = PROCESS_IO,
  options: ChallengeVerifyOptions = {},
): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const loaded = await loadChallengeCase(parsed.fixturePath, parsed.caseLabel);
    const store = await resolveCommittedInputStore({
      keccak: nobleKeccak,
      filePath: parsed.storePath,
      forceFile: parsed.storePathExplicit,
      env: options.env ?? process.env,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const result = await verifyChallenge({
      commitment: new CommittedParameterSet({
        nameId: loaded.nameId,
        forSession: loaded.forSession,
        lambdaWad: loaded.lambdaWad,
        premiumWad: loaded.premiumWad,
        inputsHash: loaded.inputsHash,
      }),
      expectedDigest: loaded.expectedDigest,
      refit: refitFromStore(store, nobleKeccak),
      keccak: nobleKeccak,
    });
    io.stdout.write(`${formatChallengeReport(result)}\n`);
    return result.kind === 'upheld' ? 0 : 1;
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ChallengeCaseUnavailable ||
      error instanceof ChallengeCaseMalformed ||
      error instanceof CommittedInputStoreUnavailable ||
      error instanceof CommittedInputStoreMalformed
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
