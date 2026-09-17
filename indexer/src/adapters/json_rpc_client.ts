/**
 * A JSON-RPC 2.0 client over `fetch`.
 *
 * The adapter a live node is reached through. Everything that can go wrong with HTTP or with the
 * JSON-RPC envelope goes wrong here and nowhere else: a refused connection, a non-OK status, a body
 * that is not JSON, and a JSON-RPC `error` member. Callers receive `result` or a typed refusal —
 * never a bare `TypeError` from `fetch`, which would make a down node indistinguishable from a
 * programmer error.
 *
 * Fetch is injected so the tests never open a socket. The default is `globalThis.fetch`, which is
 * what a process that is actually talking to a node uses.
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
 * Posts JSON-RPC 2.0 method calls to one URL.
 *
 * The id is fixed at `1` because this client does not pipeline overlapping calls; matching replies
 * by id would be ceremony for a conversation that is one request at a time.
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
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      throw new RpcMalformed(`rpc ${this.url}: ${describeError(error)}`);
    }
    return resultOf(this.url, payload);
  }
}

/** Unwrap `result`, or refuse a JSON-RPC error object / a body that is not an object. */
function resultOf(url: string, payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RpcMalformed(`rpc ${url}: expected a JSON-RPC object`);
  }
  const record = payload as Record<string, unknown>;
  if ('error' in record && record['error'] != null) {
    throw new RpcMalformed(`rpc ${url}: ${describeRpcError(record['error'])}`);
  }
  if (!('result' in record)) {
    throw new RpcMalformed(`rpc ${url}: missing result`);
  }
  return record['result'];
}

/** An error's message, for the message of an `RpcUnavailable` or `RpcMalformed`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A JSON-RPC error member, preferring `.message` when the node sent one. */
function describeRpcError(error: unknown): string {
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  return describeError(error);
}
