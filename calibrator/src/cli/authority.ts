/**
 * Session authority composition root.
 *
 * Two commands the publisher (or anyone for `expire`) runs against a session: `expire` moves the
 * session from Open to Expired after the expiry timestamp, and `close` sweeps remaining collateral
 * back to the publisher after all claims are redeemed. Both are single-call txs — no batch
 * infrastructure needed — signed with the same signer F108 built.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nobleKeccak } from '../adapters/keccak_noble.js';
import { rpcBroadcastNode } from '../adapters/rpc_broadcast_node.js';
import { JsonRpcClient, RpcMalformed, RpcUnavailable } from '../adapters/rpc_client.js';
import { privateKeyToAddress } from '../adapters/signer.js';
import { signLegacyTx } from '../adapters/tx_signer.js';
import { type BroadcastNode } from '../application/broadcast.js';
import { fragmentOf, selectorOf } from '../domain/abi.js';

interface TextWriter {
  write(chunk: string): unknown;
}
interface CliIo {
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
}
const PROCESS_IO: CliIo = { stdout: process.stdout, stderr: process.stderr };

const USAGE =
  'usage: authority <expire|close> --rpc-url <url> --private-key <hex> --session <address>';

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

interface ParsedArgs {
  readonly command: 'expire' | 'close';
  readonly rpcUrl: string;
  readonly privateKey: string;
  readonly session: string;
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  let command: 'expire' | 'close' | undefined;
  let rpcUrl: string | undefined;
  let privateKey: string | undefined;
  let session: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) throw new UsageError(USAGE);
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`${arg} needs a value\n${USAGE}`);
      index += 1;
      return next;
    };
    switch (arg) {
      case 'expire':
        command = 'expire';
        break;
      case 'close':
        command = 'close';
        break;
      case '--rpc-url':
        rpcUrl = value();
        break;
      case '--private-key':
        privateKey = value();
        break;
      case '--session':
        session = value();
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}\n${USAGE}`);
    }
  }

  if (command === undefined) throw new UsageError('command must be expire or close\n' + USAGE);
  if (rpcUrl === undefined || privateKey === undefined || session === undefined) {
    throw new UsageError('all of --rpc-url, --private-key and --session are required\n' + USAGE);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(session)) {
    throw new UsageError('--session must be a 0x-prefixed address\n' + USAGE);
  }
  return { command, rpcUrl, privateKey, session };
}

/**
 * Send a single-call tx to the session. The selector is computed, not copied — same discipline
 * as every other ABI encoding in the tree.
 */
async function sendAuthorityTx(
  command: 'expire' | 'close',
  session: string,
  privateKey: string,
  node: BroadcastNode,
): Promise<string> {
  const data = selectorOf(fragmentOf(command), nobleKeccak);
  const chainId = await node.chainId();
  const publisher = privateKeyToAddress(privateKey);
  const nonce = await node.nonce(publisher);
  const gasPrice = await node.gasPrice();
  const gasLimit = await node.estimateGas(publisher, session, data);
  const raw = signLegacyTx(
    { nonce, gasPrice, gasLimit, to: session, value: 0n, data, chainId },
    privateKey,
  );
  return await node.sendRawTransaction(raw);
}

export async function main(argv: readonly string[], io: CliIo = PROCESS_IO): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const node = rpcBroadcastNode(new JsonRpcClient({ url: parsed.rpcUrl }));
    const txHash = await sendAuthorityTx(parsed.command, parsed.session, parsed.privateKey, node);
    io.stdout.write(`${txHash}\n`);
    return 0;
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof RpcUnavailable ||
      error instanceof RpcMalformed
    ) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

/** True when this file is the entry point — tested by passing `entry` explicitly. */
export function invokedDirectly(entry: string | undefined): boolean {
  if (entry === undefined) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
}

if (invokedDirectly(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
