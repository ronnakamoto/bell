/**
 * Ports. Declarations only — no implementations, and no imports beyond the domain's own value types.
 *
 * Ports are declared in the domain and implemented by adapters, so the dependency arrow points
 * inward. The log source is a port rather than a concrete client for the reason the other workspaces
 * already state: the feed will change (an RPC, a replay file, a recorded fixture) and the domain
 * must not.
 *
 * **The port is the point of this workspace rather than a formality.** An indexer reads logs, and the
 * way that goes wrong is a domain module that reaches an RPC client, a socket or `node:fs` directly.
 * `LogSource` is the seam, and `indexer-domain-takes-only-the-shared-core` is what makes it one: a
 * two-line file importing `node:fs` from this tree fails the architecture gate, which is the probe
 * that exists because a deny-list of categories fails open on the category nobody thought of.
 *
 * **`Promise`-returning, matching every other outward-facing port in the tree.** A synchronous source
 * would be honest for the only implementation this workspace has today — a list built from the log
 * corpus — and wrong for the real one, which is a network read. The fold itself is synchronous; the
 * asynchrony lives in the use case that asks the source and then folds, which is where a network
 * read belongs.
 */

import { type RawLog } from './log.js';

/**
 * A source of raw logs.
 *
 * Implemented by an RPC client against a node, by a file reader for a replay, and by a list for the
 * tests. The domain never learns which.
 *
 * **Unordered at the port, ordered at the fold.** A source that reordered on a retry would look like
 * a different history if the fold assumed the port had sorted; the fold reads the stream it is given
 * and attributes by content, not by position. Emission order is what a real node yields and what the
 * corpus records, and it is a property of the producer rather than a contract this side imposes.
 */
export interface LogSource {
  /** Every log currently held, as the producer rendered it. */
  logs(): Promise<readonly RawLog[]>;
}

/**
 * The three singleton addresses the indexer is configured with.
 *
 * Three, not four: the session role is a family of addresses the fold *learns* from `SessionCreated`,
 * and configuring it would make the indexer able to see only the sessions the caller already knew —
 * which is the discovery problem the indexer exists to solve. The factory, the registry and the
 * premium store are deployed once and do not move.
 *
 * Strings rather than `AddressKey`, because a caller hands over whatever rendering it has (EIP-55
 * from an RPC, lower-case from a fixture) and the fold is the one place that normalises. Requiring
 * the key type here would push the case rule out to every adapter.
 */
export interface IndexerConfig {
  readonly factory: string;
  readonly registry: string;
  readonly premium: string;
}
