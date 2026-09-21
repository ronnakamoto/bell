/**
 * A log source that discovers sessions and fetches their logs too.
 *
 * The singleton filter — factory, registry, premium — is enough to learn that a session exists
 * (`SessionCreated`) but not to see what it did: `PoolSeeded`, `Traded` and `Settled` are emitted
 * by the session's own contract, whose address is only known after the creation event is read. This
 * source composes the two fetches: the base source's singleton logs first, then one more fetch for
 * every session address the creation events name. The session logs follow the singleton batch, so
 * the fold learns each session's role from `SessionCreated` before it attributes the session's own
 * events — a session's events always postdate its creation, so the concatenation preserves the one
 * ordering the fold depends on.
 */

import { decodeEvent } from '../domain/decode.js';
import { type RawLog, topicAt } from '../domain/log.js';
import { type LogSource } from '../domain/ports.js';
import { describeEvent } from '../domain/taxonomy.js';
import { type JsonRpcClient } from './json_rpc_client.js';
import { RpcLogSource } from './log_source_rpc.js';

/**
 * Wraps a singleton-filtered source and adds the session logs its creation events name.
 *
 * `base` is the source filtered to the configured singleton addresses; `client` is the node the
 * session logs are fetched from, paged exactly as `RpcLogSource` pages. A stream with no
 * `SessionCreated` events is returned untouched — there is nothing to discover.
 */
export class SessionAwareLogSource implements LogSource {
  readonly base: LogSource;
  readonly client: JsonRpcClient;

  constructor(options: { base: LogSource; client: JsonRpcClient }) {
    this.base = options.base;
    this.client = options.client;
  }

  async logs(): Promise<readonly RawLog[]> {
    const singleton = await this.base.logs();
    const sessions = sessionAddressesOf(singleton);
    if (sessions.length === 0) return singleton;
    const sessionLogs = await new RpcLogSource({
      client: this.client,
      addresses: sessions,
    }).logs();
    return [...singleton, ...sessionLogs];
  }
}

/**
 * The session addresses the creation events in a singleton log stream name, in first-seen order.
 *
 * `SessionCreated`'s topic0 is unique to the factory's event, so matching the descriptor by role
 * and topic0 is enough — no emitter check is needed, and a registry or premium log cannot collide
 * with it. The address is read from topic 1, which is the session the factory deployed.
 */
function sessionAddressesOf(logs: readonly RawLog[]): readonly string[] {
  const sessions: string[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const descriptor = describeEvent('factory', topicAt(log, 0));
    if (descriptor === undefined) continue;
    const event = decodeEvent(descriptor, log);
    if (event.kind === 'SessionCreated' && !seen.has(event.session)) {
      seen.add(event.session);
      sessions.push(event.session);
    }
  }
  return sessions;
}
