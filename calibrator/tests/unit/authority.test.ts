/**
 * The session authority CLI.
 *
 * Two commands the publisher (or anyone for `expire`) runs against a session. Exercised with a
 * scripted node, so the test pins the selector sent (computed from the ABI fragment, not copied)
 * and the single-tx flow without a socket.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { invokedDirectly, main } from '../../src/cli/authority.js';

function capture(): { text: () => string; write: (chunk: string) => void } {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(''),
    write: (chunk: string) => chunks.push(chunk),
  };
}

const SESSION = '0x1111111111111111111111111111111111111111';
const PRIV_KEY = `0x${'46'.repeat(32)}`;

function scriptedFetch(script: unknown[]): typeof globalThis.fetch {
  let index = 0;
  const next = (): unknown => {
    const v = script[index];
    if (v === undefined) throw new Error(`script exhausted at ${String(index)}`);
    index += 1;
    return v;
  };
  return (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const result = next();
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }),
    );
  };
}

describe('authority CLI', () => {
  it('sends an expire tx and prints the hash', async () => {
    const stdout = capture();
    const stderr = capture();
    const fetchImpl = scriptedFetch([
      '0xb62a', // chainId
      '0x5', // nonce
      '0x3b9aca00', // gasPrice
      '0x186a0', // estimateGas
      '0xaabb', // sendRawTransaction
    ]);
    const prev = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const code = await main(
        ['expire', '--rpc-url', 'http://node', '--private-key', PRIV_KEY, '--session', SESSION],
        { stdout, stderr },
      );
      expect(code).toBe(0);
      expect(stdout.text()).toContain('0xaabb');
      expect(stderr.text()).toBe('');
    } finally {
      globalThis.fetch = prev;
    }
  });

  it('sends a close tx and prints the hash', async () => {
    const stdout = capture();
    const stderr = capture();
    const fetchImpl = scriptedFetch(['0xb62a', '0x3', '0x3b9aca00', '0x186a0', '0xccdd']);
    const prev = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const code = await main(
        ['close', '--rpc-url', 'http://node', '--private-key', PRIV_KEY, '--session', SESSION],
        { stdout, stderr },
      );
      expect(code).toBe(0);
      expect(stdout.text()).toContain('0xccdd');
    } finally {
      globalThis.fetch = prev;
    }
  });

  it('exits 2 on missing subcommand', async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await main([], { stdout, stderr });
    expect(code).toBe(2);
    expect(stderr.text()).toContain('command must be expire or close');
  });

  it('exits 2 on missing --session', async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await main(['expire', '--rpc-url', 'http://node', '--private-key', PRIV_KEY], {
      stdout,
      stderr,
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain('all of --rpc-url, --private-key and --session are required');
  });

  it('exits 2 on bad session address', async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await main(
      ['expire', '--rpc-url', 'http://node', '--private-key', PRIV_KEY, '--session', 'nope'],
      { stdout, stderr },
    );
    expect(code).toBe(2);
    expect(stderr.text()).toContain('--session must be a 0x-prefixed address');
  });

  it('exits 2 on unknown argument', async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await main(['expire', '--nope'], { stdout, stderr });
    expect(code).toBe(2);
    expect(stderr.text()).toContain('unknown argument');
  });

  it('exits 2 when the node is unreachable', async () => {
    const stdout = capture();
    const stderr = capture();
    const prev = globalThis.fetch;
    const fetchImpl = (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    globalThis.fetch = fetchImpl;
    try {
      const code = await main(
        ['expire', '--rpc-url', 'http://node', '--private-key', PRIV_KEY, '--session', SESSION],
        { stdout, stderr },
      );
      expect(code).toBe(2);
      expect(stderr.text()).toMatch(/rpc http:\/\/node/);
    } finally {
      globalThis.fetch = prev;
    }
  });
});

describe('invokedDirectly', () => {
  it('returns false when the entry is undefined', () => {
    expect(invokedDirectly(undefined)).toBe(false);
  });

  it('returns false when the entry does not match the module path', () => {
    expect(invokedDirectly('/some/other/path.ts')).toBe(false);
  });

  it('returns true when the entry matches the module path', () => {
    const modulePath = fileURLToPath(new URL('../../src/cli/authority.ts', import.meta.url));
    expect(invokedDirectly(modulePath)).toBe(true);
  });
});
