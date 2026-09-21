/**
 * The `BroadcastNode` over a JSON-RPC node.
 *
 * Maps the use case's six calls onto `eth_*` methods. Hex results come back as `0x`-prefixed
 * strings and are parsed here — the use case deals in bigints and addresses, not node hex.
 */

import { type BroadcastNode } from '../application/broadcast.js';
import { type JsonRpcClient } from './rpc_client.js';

/** A `BroadcastNode` whose calls go to `client`. */
export function rpcBroadcastNode(client: JsonRpcClient): BroadcastNode {
  return {
    chainId: async () => BigInt((await client.call('eth_chainId', [])) as string),
    nonce: async (account) =>
      BigInt((await client.call('eth_getTransactionCount', [account, 'pending'])) as string),
    gasPrice: async () => BigInt((await client.call('eth_gasPrice', [])) as string),
    estimateGas: async (from, to, data) =>
      BigInt((await client.call('eth_estimateGas', [{ from, to, data }])) as string),
    call: async (to, data) => (await client.call('eth_call', [{ to, data }, 'latest'])) as string,
    sendRawTransaction: async (raw) =>
      (await client.call('eth_sendRawTransaction', [raw])) as string,
  };
}
