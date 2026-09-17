/**
 * A log source backed by `eth_getLogs`.
 *
 * The adapter the domain's `LogSource` port exists for when the producer is a node. The fold still
 * receives `RawLog` value objects and never learns that JSON-RPC was involved, which is what lets
 * the same catalogue use case fold a file replay and a live node through one seam.
 *
 * The filter is the three singleton addresses the indexer is configured with — factory, registry,
 * premium — plus whatever else a caller passes. Session contracts are discovered from
 * `SessionCreated`, not by asking the node for every log on the chain. `fromBlock`/`toBlock` are
 * the whole history because this slice has no cursor; a later slice that pages will replace the
 * bounds, not the mapping.
 *
 * A JSON-RPC log names its emitter `address`. `RawLog` names it `emitter`. The adapter is the only
 * place that translation happens.
 */

import { type RawLog } from '../domain/log.js';
import { type LogSource } from '../domain/ports.js';
import { type JsonRpcClient, RpcMalformed } from './json_rpc_client.js';

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

  /** Every log the node currently holds for the configured addresses, in the order it returned them. */
  async logs(): Promise<readonly RawLog[]> {
    const result = await this.client.call('eth_getLogs', [
      {
        address: [...this.addresses],
        fromBlock: 'earliest',
        toBlock: 'latest',
      },
    ]);
    return parseRpcLogs(result);
  }
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
