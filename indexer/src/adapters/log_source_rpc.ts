/**
 * A log source backed by `eth_getLogs`.
 *
 * The adapter the domain's `LogSource` port exists for when the producer is a node. The fold still
 * receives `RawLog` value objects and never learns that JSON-RPC was involved, which is what lets
 * the same catalogue use case fold a file replay and a live node through one seam.
 *
 * The filter is the three singleton addresses the indexer is configured with — factory, registry,
 * premium — plus whatever else a caller passes. Session contracts are discovered from
 * `SessionCreated`, not by asking the node for every log on the chain.
 *
 * The history is fetched in bounded block pages rather than one `earliest`-to-`latest` request,
 * because a node caps both the block range and the result count of a single `eth_getLogs`: a range
 * that spans the whole chain would be refused, and a page that returns more than the node's result
 * cap would be truncated or rejected. A page that the node refuses is halved and retried, so a
 * burst of logs in one range still comes back whole.
 *
 * A JSON-RPC log names its emitter `address`. `RawLog` names it `emitter`. The adapter is the only
 * place that translation happens.
 */

import { type RawLog } from '../domain/log.js';
import { type LogSource } from '../domain/ports.js';
import { type JsonRpcClient, RpcMalformed } from './json_rpc_client.js';

/**
 * The width of one `eth_getLogs` page, in blocks. Ten thousand is the common node cap on a single
 * request's block range; a page at this width stays under it while keeping the request count for a
 * whole-chain walk small.
 */
const PAGE_BLOCKS = 10_000n;

/**
 * Reads the current log history from one JSON-RPC node.
 *
 * `addresses` is the `eth_getLogs` `address` filter. Copied at call time so a caller that mutates
 * the array they handed over does not change a request that is already in flight.
 */
export class RpcLogSource implements LogSource {
  readonly client: JsonRpcClient;
  readonly addresses: readonly string[];

  constructor(options: { client: JsonRpcClient; addresses: readonly string[] }) {
    this.client = options.client;
    this.addresses = options.addresses;
  }

  /**
   * Every log the node holds for the configured addresses, in block order.
   *
   * The head is read once and the walk is bounded by it, so a block mined mid-walk is picked up by
   * the next call rather than half-included. A page the node refuses is halved and retried; a page
   * that still fails at a single block propagates the refusal.
   */
  async logs(): Promise<readonly RawLog[]> {
    const head = await this.currentBlock();
    const logs: RawLog[] = [];
    for (let from = 0n; from <= head; from += PAGE_BLOCKS) {
      const to = from + PAGE_BLOCKS - 1n < head ? from + PAGE_BLOCKS - 1n : head;
      logs.push(...(await this.page(from, to)));
    }
    return logs;
  }

  /** The chain's current block, as a quantity. */
  private async currentBlock(): Promise<bigint> {
    const result = await this.client.call('eth_blockNumber', []);
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) {
      throw new RpcMalformed('eth_blockNumber: expected a hex quantity');
    }
    return BigInt(result);
  }

  /**
   * One bounded `eth_getLogs` page, halving the range on a refusal.
   *
   * A node refuses a page that spans too many blocks or returns too many results; both refusals
   * arrive as JSON-RPC errors, which the client maps to `RpcMalformed`. Halving on that error — and
   * only on it, never on `RpcUnavailable`, which is a down node — recovers the logs the node would
   * otherwise truncate. A page that still fails at a single block is a genuine refusal and
   * propagates.
   */
  private async page(fromBlock: bigint, toBlock: bigint): Promise<readonly RawLog[]> {
    try {
      const result = await this.client.call('eth_getLogs', [
        {
          address: [...this.addresses],
          fromBlock: hexOfBlock(fromBlock),
          toBlock: hexOfBlock(toBlock),
        },
      ]);
      return parseRpcLogs(result);
    } catch (error) {
      if (error instanceof RpcMalformed && toBlock - fromBlock + 1n > 1n) {
        const mid = fromBlock + (toBlock - fromBlock) / 2n;
        const first = await this.page(fromBlock, mid);
        const second = await this.page(mid + 1n, toBlock);
        return [...first, ...second];
      }
      throw error;
    }
  }
}

/** A block number as the `0x`-prefixed hex quantity `eth_getLogs` expects. */
function hexOfBlock(block: bigint): string {
  return `0x${block.toString(16)}`;
}

/** Map an `eth_getLogs` result onto `RawLog` records, refusing anything that is not that list. */
function parseRpcLogs(result: unknown): readonly RawLog[] {
  if (!Array.isArray(result)) {
    throw new RpcMalformed('eth_getLogs: expected an array of logs');
  }
  return result.map((entry, index) => parseRpcLog(index, entry));
}

function parseRpcLog(index: number, entry: unknown): RawLog {
  const where = `eth_getLogs log[${String(index)}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new RpcMalformed(`${where}: expected an object`);
  }
  const record = entry as Record<string, unknown>;
  const topics = record['topics'];
  const data = record['data'];
  const address = record['address'];
  if (!Array.isArray(topics) || !topics.every((topic) => typeof topic === 'string')) {
    throw new RpcMalformed(`${where}: topics must be an array of strings`);
  }
  if (typeof data !== 'string') {
    throw new RpcMalformed(`${where}: data must be a string`);
  }
  if (typeof address !== 'string') {
    throw new RpcMalformed(`${where}: address must be a string`);
  }
  return { topics, data, emitter: address };
}
