/**
 * The JSON-RPC client the live log source uses — re-exported from the calibrator's shared copy.
 *
 * The transport client lives exactly once, in `@bell/calibrator/adapters/rpc_client.js` (F112);
 * this file is the indexer's seam to it, kept so the adapter directory's shape is unchanged and a
 * future divergence has a place to live. The implementation, the typed refusals, and the tests
 * that pin them are the calibrator's.
 */
export {
  JsonRpcClient,
  RpcMalformed,
  RpcUnavailable,
} from '@bell/calibrator/adapters/rpc_client.js';
