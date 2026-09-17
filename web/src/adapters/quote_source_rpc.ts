/**
 * A quote source backed by `eth_call` against `PremiumRegistry.quote`.
 *
 * The adapter the domain's `QuoteSource` port exists for when the producer is a node. The use case
 * still receives `Quote` value objects and never learns that JSON-RPC was involved, which is what
 * lets the same honest-quote path read a file replay and a live registry through one seam.
 *
 * Calldata is the four-byte selector `0x7d989975` plus ABI words for `bytes32 nameId` and
 * `uint256 forSession`. The return is three words: verdict (0 Usable, 1 Fallback, 2 Refuse),
 * lambda, premium. Refuse drops the wads — a zero premium is a free claim, and F50 forbids
 * inventing a number from a refusal.
 *
 * `quotes()` is empty. RPC is a lookup, not a catalogue; a caller that wants every row still has
 * the file adapter.
 */

import { type QuoteFixtureRow, type QuoteSource } from '../domain/ports.js';
import { type Quote } from '../domain/quote.js';
import { type JsonRpcClient, RpcMalformed } from './json_rpc_client.js';

const QUOTE_SELECTOR = '0x7d989975';

/**
 * Reads one quote from a PremiumRegistry via JSON-RPC.
 *
 * `premium` is the registry address `eth_call` targets. Copied as a string so a caller that
 * mutates the options object they handed over does not change a request that is already in flight.
 */
export class RpcQuoteSource implements QuoteSource {
  readonly client: JsonRpcClient;
  readonly premium: string;

  constructor(options: { client: JsonRpcClient; premium: string }) {
    this.client = options.client;
    this.premium = options.premium;
  }

  /** RPC has no catalogue; the list is always empty. */
  quotes(): Promise<readonly QuoteFixtureRow[]> {
    return Promise.resolve([]);
  }

  /** One `PremiumRegistry.quote` read, decoded onto the domain `Quote`. */
  async quote(nameId: string, forSession: bigint): Promise<Quote> {
    const data = `${QUOTE_SELECTOR}${bytes32Hex(nameId)}${uint256Hex(forSession)}`;
    const result = await this.client.call('eth_call', [{ to: this.premium, data }, 'latest']);
    return decodeQuoteResult(result);
  }
}

/** `nameId` as 32-byte hex, with or without a `0x` prefix. */
function bytes32Hex(nameId: string): string {
  const hex = nameId.startsWith('0x') || nameId.startsWith('0X') ? nameId.slice(2) : nameId;
  return hex.padStart(64, '0');
}

/** `forSession` as a big-endian uint256 word. */
function uint256Hex(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

/** Map an `eth_call` result onto a `Quote`, refusing anything that is not three ABI words. */
function decodeQuoteResult(result: unknown): Quote {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/i.test(result)) {
    throw new RpcMalformed('eth_call quote: expected hex data');
  }
  const hex = result.slice(2);
  if (hex.length !== 192) {
    throw new RpcMalformed('eth_call quote: expected 3 words');
  }
  const verdict = Number.parseInt(hex.slice(62, 64), 16);
  const lambdaWad = BigInt(`0x${hex.slice(64, 128)}`);
  const premiumWad = BigInt(`0x${hex.slice(128, 192)}`);
  switch (verdict) {
    case 0:
      return { verdict: 'Usable', lambdaWad, premiumWad };
    case 1:
      return { verdict: 'Fallback', lambdaWad, premiumWad };
    case 2:
      return { verdict: 'Refuse' };
    default:
      throw new RpcMalformed(`eth_call quote: unknown verdict ${String(verdict)}`);
  }
}
