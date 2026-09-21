/**
 * A JSON-RPC 2.0 client over `fetch` for the CLI's broadcast surface.
 *
 * The same generic client the indexer and the web carry — a node is reached through this and
 * nothing else, so a refused connection, a non-OK status, a body that is not JSON, and a JSON-RPC
 * `error` member all become typed refusals here. The three copies of this adapter are transport
 * plumbing, not domain logic: the encoder and the constants live in the domain exactly once, but a
 * fetch client is a stable ~80 lines that each workspace carries so it does not depend on a
 * sibling's adapters. Consolidating the copies into the shared core is noted in DESIGN_NOTES as
 * future work; it would touch the indexer's tested surface for no behavioural change.
 */

/** The transport could not complete a call. Retryable, in the sense that the node may recover. */
export class RpcUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcUnavailable';
  }
}

/** The node answered, but the body is not a JSON-RPC result. Terminal for this request. */
export class RpcMalformed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcMalformed';
  }
}

/**
 * Posts JSON-RPC 2.0 method calls to one URL. One request at a time, so the id is fixed at `1`.
 */
export class JsonRpcClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { url: string; fetchImpl?: typeof fetch }) {
    this.url = options.url;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** One JSON-RPC method call. `params` is whatever the method takes — an array or an object. */
  async call(method: string, params: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch (error) {
      throw new RpcUnavailable(`rpc ${this.url}: ${describeError(error)}`);
    }
    if (!response.ok) {
      throw new RpcUnavailable(`rpc ${this.url}: HTTP ${String(response.status)}`);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcMalformed(`rpc ${this.url}: body is not JSON`);
    }
    if (typeof body !== 'object' || body === null) {
      throw new RpcMalformed(`rpc ${this.url}: body is not an object`);
    }
    const envelope = body as { result?: unknown; error?: unknown };
    if (envelope.error !== undefined) {
      throw new RpcMalformed(`rpc ${this.url}: ${describeError(envelope.error)}`);
    }
    if (envelope.result === undefined) {
      throw new RpcMalformed(`rpc ${this.url}: no result member`);
    }
    return envelope.result;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}
