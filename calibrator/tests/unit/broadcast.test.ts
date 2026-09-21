/**
 * The CLI broadcast use case and its node adapter.
 *
 * The use case is exercised with a scripted node that records every call, so the tests pin the
 * order of reads (chainId, bondToken, nonce) and the per-step sequence (gasPrice, estimateGas,
 * sendRawTransaction) without a socket. The adapter test pins the JSON-RPC method mapping.
 */

import { describe, expect, it } from 'vitest';

import { nobleKeccak } from '../../src/adapters/keccak_noble.js';
import { rpcBroadcastNode } from '../../src/adapters/rpc_broadcast_node.js';
import { broadcastCommitBatch, type BroadcastNode } from '../../src/application/broadcast.js';
import { buildCommit } from '../../src/domain/commit_intent.js';

const PREMIUM = '0x1111111111111111111111111111111111111111';
const COLLATERAL = '0x2222222222222222222222222222222222222222';
const PUBLISHER = '0x3333333333333333333333333333333333333333';

const BATCH = buildCommit({
  nameId: `0x${'aa'.repeat(32)}`,
  forSession: 7n,
  lambdaWad: 1_000n,
  premiumWad: 500n,
  inputsHash: `0x${'bb'.repeat(32)}`,
});

/** A scripted node that records its calls and answers from a script. */
function scriptedNode(script: readonly unknown[]): BroadcastNode & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const next = (): unknown => {
    const value = script[index];
    if (value === undefined) throw new Error(`script exhausted at call ${String(index)}`);
    index += 1;
    return value;
  };
  const record = (label: string): Promise<unknown> => {
    calls.push(label);
    return Promise.resolve(next());
  };
  return {
    calls,
    chainId: (): Promise<bigint> => record('chainId') as Promise<bigint>,
    nonce: (account: string): Promise<bigint> => record(`nonce:${account}`) as Promise<bigint>,
    gasPrice: (): Promise<bigint> => record('gasPrice') as Promise<bigint>,
    estimateGas: (from: string, to: string, data: string): Promise<bigint> =>
      record(`estimateGas:${from}:${to}:${data.slice(0, 10)}`) as Promise<bigint>,
    call: (to: string, data: string): Promise<string> =>
      record(`call:${to}:${data}`) as Promise<string>,
    sendRawTransaction: (raw: string): Promise<string> =>
      record(`send:${raw.slice(0, 10)}`) as Promise<string>,
  };
}

describe('broadcastCommitBatch', () => {
  it('resolves the collateral by read, then sends approve and commit in order', async () => {
    const node = scriptedNode([
      46_630n, // chainId
      `0x${'00'.repeat(12)}${COLLATERAL.slice(2)}`, // bondToken()
      5n, // nonce
      1_000_000_000n, // gasPrice (approve)
      90_000n, // estimateGas (approve)
      '0xaa', // send approve
      1_000_000_000n, // gasPrice (commit)
      300_000n, // estimateGas (commit)
      '0xbb', // send commit
    ]);
    const hashes = await broadcastCommitBatch({
      batch: BATCH,
      premium: PREMIUM,
      publisher: PUBLISHER,
      node,
      signer: (tx) => `raw:${tx.nonce.toString()}:${tx.to}`,
      keccak: nobleKeccak,
    });
    expect(hashes).toEqual(['0xaa', '0xbb']);
    expect(node.calls).toEqual([
      'chainId',
      `call:${PREMIUM}:0xc28f4392`,
      `nonce:${PUBLISHER}`,
      'gasPrice',
      `estimateGas:${PUBLISHER}:${COLLATERAL}:0x095ea7b3`,
      'send:raw:5:0x22',
      'gasPrice',
      `estimateGas:${PUBLISHER}:${PREMIUM}:0x33de0913`,
      'send:raw:6:0x11',
    ]);
  });

  it('refuses a bondToken result that is not an address', async () => {
    const node = scriptedNode([46_630n, `0x${'11'.repeat(32)}`]);
    await expect(
      broadcastCommitBatch({
        batch: BATCH,
        premium: PREMIUM,
        publisher: PUBLISHER,
        node,
        signer: (tx) => `raw:${tx.nonce.toString()}`,
        keccak: nobleKeccak,
      }),
    ).rejects.toThrow(/not an ABI-encoded address/);
  });
});

describe('rpcBroadcastNode', () => {
  it('maps the six calls onto eth_* methods with hex parsing', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const client = {
      url: 'http://node',
      call: (method: string, params: unknown): Promise<unknown> => {
        calls.push({ method, params });
        return Promise.resolve('0x10');
      },
    } as never;
    const node = rpcBroadcastNode(client);
    await expect(node.chainId()).resolves.toBe(16n);
    await expect(node.nonce('0xabc')).resolves.toBe(16n);
    await expect(node.gasPrice()).resolves.toBe(16n);
    await expect(node.estimateGas('0xabc', '0xdef', '0x1234')).resolves.toBe(16n);
    await expect(node.call('0xdef', '0x1234')).resolves.toBe('0x10');
    await expect(node.sendRawTransaction('0xraw')).resolves.toBe('0x10');
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getTransactionCount', params: ['0xabc', 'pending'] },
      { method: 'eth_gasPrice', params: [] },
      { method: 'eth_estimateGas', params: [{ from: '0xabc', to: '0xdef', data: '0x1234' }] },
      { method: 'eth_call', params: [{ to: '0xdef', data: '0x1234' }, 'latest'] },
      { method: 'eth_sendRawTransaction', params: ['0xraw'] },
    ]);
  });
});
