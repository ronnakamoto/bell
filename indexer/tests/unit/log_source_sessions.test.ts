/**
 * The session-aware log source.
 *
 * The singleton filter learns that a session exists from `SessionCreated`; this source then fetches
 * the session's own logs, which the singleton filter cannot see. The session logs follow the
 * singleton batch, so the fold learns each session's role before it attributes the session's events.
 */

import { describe, expect, it } from 'vitest';

import { JsonRpcClient } from '../../src/adapters/json_rpc_client.js';
import { SessionAwareLogSource } from '../../src/adapters/log_source_sessions.js';
import { type RawLog } from '../../src/domain/log.js';
import { type LogSource } from '../../src/domain/ports.js';

const FACTORY = '0x1111111111111111111111111111111111111111';
const SESSION = '0x2222222222222222222222222222222222222222';
const SESSION_B = '0x3333333333333333333333333333333333333333';

/** An address as the 32-byte topic an event carries it in. */
function topicOf(address: string): string {
  return `0x${'00'.repeat(12)}${address.slice(2)}`;
}

/** The `SessionCreated` topic0, from the taxonomy. */
const SESSION_CREATED_TOPIC0 = '0xbfea4ffed12dea0f10d6ed0862b3b921c451b49a70efdd3461d7423842282b00';
/** The `PoolSeeded` topic0, a session-emitted event the singleton filter cannot see. */
const POOL_SEEDED_TOPIC0 = '0x5d429557f34c498cc29db4d2e2663bee1f80a8df8a3aace3a0166eccfcda58f4';
/** A 32-byte word for a topic that is not a recognised event. */
const ZERO_WORD = `0x${'00'.repeat(32)}`;

function sessionCreated(session: string): RawLog {
  return {
    emitter: FACTORY,
    topics: [
      SESSION_CREATED_TOPIC0,
      topicOf(session),
      topicOf('0x4444444444444444444444444444444444444444'),
    ],
    data: `0x${'00'.repeat(32)}${'00'.repeat(32)}${'00'.repeat(32)}${'00'.repeat(32)}${'00'.repeat(32)}`,
  };
}

/** A session log as the node returns it, before `RpcLogSource` maps `address` to `emitter`. */
function poolSeeded(session: string): Record<string, unknown> {
  return {
    address: session,
    topics: [POOL_SEEDED_TOPIC0],
    data: '0x',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** The JSON-RPC request a mock node was posted, or a failure if the body is not JSON. */
function postedBody(init: RequestInit | undefined): { method?: string; params?: unknown } {
  if (typeof init?.body !== 'string') {
    throw new Error('mock node: expected a string body');
  }
  return JSON.parse(init.body) as { method?: string; params?: unknown };
}

/** A base source returning the given singleton logs, plus a node answering `eth_getLogs`. */
function sourceOf(singleton: readonly RawLog[], nodeLogs: unknown): SessionAwareLogSource {
  const base: LogSource = {
    logs: (): Promise<readonly RawLog[]> => Promise.resolve([...singleton]),
  };
  const fetchImpl: typeof fetch = (_input, init): Promise<Response> => {
    const { method } = postedBody(init);
    if (method === 'eth_blockNumber') {
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x64' }));
    }
    if (method === 'eth_getLogs') {
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: nodeLogs }));
    }
    return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: null }));
  };
  return new SessionAwareLogSource({
    base,
    client: new JsonRpcClient({ url: 'http://rpc.test', fetchImpl }),
  });
}

describe('SessionAwareLogSource', () => {
  it('returns the singleton batch untouched when no session was created', async () => {
    const source = sourceOf([{ emitter: FACTORY, topics: [ZERO_WORD], data: '0x' }], []);
    expect(await source.logs()).toEqual([{ emitter: FACTORY, topics: [ZERO_WORD], data: '0x' }]);
  });

  it("fetches the discovered sessions' logs and appends them after the singleton batch", async () => {
    const source = sourceOf([sessionCreated(SESSION)], [poolSeeded(SESSION)]);
    const logs = await source.logs();
    expect(logs).toHaveLength(2);
    // The session log follows the creation event, so the fold learns the role first.
    expect(logs[0]?.topics[0]).toBe(SESSION_CREATED_TOPIC0);
    expect(logs[1]?.topics[0]).toBe(POOL_SEEDED_TOPIC0);
  });

  it('fetches each discovered session once, in first-seen order', async () => {
    const requested: string[][] = [];
    const base: LogSource = {
      logs: (): Promise<readonly RawLog[]> =>
        Promise.resolve([
          sessionCreated(SESSION),
          sessionCreated(SESSION),
          sessionCreated(SESSION_B),
        ]),
    };
    const fetchImpl: typeof fetch = (_input, init): Promise<Response> => {
      const { method, params } = postedBody(init);
      if (method === 'eth_blockNumber') {
        return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x64' }));
      }
      if (method === 'eth_getLogs') {
        const filter = (params as unknown[])[0] as { address: string[] };
        requested.push(filter.address);
        return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: [] }));
      }
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: 1, result: null }));
    };
    const source = new SessionAwareLogSource({
      base,
      client: new JsonRpcClient({ url: 'http://rpc.test', fetchImpl }),
    });
    await source.logs();
    expect(requested).toEqual([[SESSION, SESSION_B]]);
  });
});
