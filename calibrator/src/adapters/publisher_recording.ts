/**
 * A `ParameterPublisher` that records the call and returns a digest hex string.
 *
 * The real publisher posts a transaction. This one is what the CLI and unit tests use until a wallet
 * adapter exists: it proves `publish` was invoked (or not, on `alreadyOpen`) without touching a chain.
 */

import { type ParameterSet } from '../domain/models.js';
import { type ParameterPublisher } from '../domain/ports.js';

/** Records each `publish` call; returns a fixed or supplied digest hex. */
export class RecordingPublisher implements ParameterPublisher {
  readonly calls: { parameters: ParameterSet; forSession: bigint }[] = [];
  private readonly digestHex;

  constructor(digestHex = `0x${'00'.repeat(32)}`) {
    this.digestHex = digestHex;
  }

  async publish(parameters: ParameterSet, forSession: bigint): Promise<string> {
    this.calls.push({ parameters, forSession });
    await Promise.resolve();
    return this.digestHex;
  }
}
