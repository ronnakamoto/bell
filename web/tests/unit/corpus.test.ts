/**
 * Source composition at the web edge.
 *
 * `resolveSources` is the switch between a fixture replay and a live node. Every case below hands
 * an env object in; none of them open a socket. Construction of an RPC adapter is not a call.
 */

import { FileLogSource } from '@bell/indexer/adapters/log_source_file.js';
import { RpcLogSource } from '@bell/indexer/adapters/log_source_rpc.js';
import { SessionAwareLogSource } from '@bell/indexer/adapters/log_source_sessions.js';
import { describe, expect, it } from 'vitest';

import {
  INDEXER_CONFIG,
  IV_PATH,
  LOGS_PATH,
  QUOTES_PATH,
  resolveSources,
} from '../../src/adapters/corpus.js';
import { FileIvSource } from '../../src/adapters/iv_source_file.js';
import { FileQuoteSource } from '../../src/adapters/quote_source_file.js';
import { RpcQuoteSource } from '../../src/adapters/quote_source_rpc.js';

const RPC_URL = 'http://rpc.test';
const FACTORY = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const PREMIUM = '0x3333333333333333333333333333333333333333';

const LIVE_ENV = {
  BELL_RPC_URL: RPC_URL,
  BELL_FACTORY: FACTORY,
  BELL_REGISTRY: REGISTRY,
  BELL_PREMIUM: PREMIUM,
};

describe('resolveSources', () => {
  it('replays the committed fixtures when BELL_RPC_URL is unset', () => {
    const sources = resolveSources({});
    expect(sources.logSource).toBeInstanceOf(FileLogSource);
    expect(sources.quoteSource).toBeInstanceOf(FileQuoteSource);
    expect(sources.ivSource).toBeInstanceOf(FileIvSource);
    if (!(sources.logSource instanceof FileLogSource)) return;
    if (!(sources.quoteSource instanceof FileQuoteSource)) return;
    if (!(sources.ivSource instanceof FileIvSource)) return;
    expect(sources.logSource.path).toBe(LOGS_PATH);
    expect(sources.quoteSource.path).toBe(QUOTES_PATH);
    expect(sources.ivSource.path).toBe(IV_PATH);
    expect(sources.indexerConfig).toBe(INDEXER_CONFIG);
  });

  it('replays the fixtures when BELL_RPC_URL is empty or whitespace', () => {
    expect(resolveSources({ BELL_RPC_URL: '' }).logSource).toBeInstanceOf(FileLogSource);
    expect(resolveSources({ BELL_RPC_URL: '  \n' }).quoteSource).toBeInstanceOf(FileQuoteSource);
  });

  it('uses RPC log and quote sources when BELL_RPC_URL is set', () => {
    const sources = resolveSources(LIVE_ENV);
    // The log source is session-aware: the singleton filter discovers sessions, and the wrapper
    // fetches the sessions' own logs the filter cannot see.
    expect(sources.logSource).toBeInstanceOf(SessionAwareLogSource);
    expect(sources.quoteSource).toBeInstanceOf(RpcQuoteSource);
    expect(sources.ivSource).toBeInstanceOf(FileIvSource);
    if (!(sources.logSource instanceof SessionAwareLogSource)) return;
    if (!(sources.quoteSource instanceof RpcQuoteSource)) return;
    if (!(sources.ivSource instanceof FileIvSource)) return;
    expect(sources.logSource.base).toBeInstanceOf(RpcLogSource);
    if (!(sources.logSource.base instanceof RpcLogSource)) return;
    expect(sources.logSource.base.client.url).toBe(RPC_URL);
    expect(sources.logSource.base.addresses).toEqual([FACTORY, REGISTRY, PREMIUM]);
    expect(sources.quoteSource.client.url).toBe(RPC_URL);
    expect(sources.quoteSource.premium).toBe(PREMIUM);
    expect(sources.ivSource.path).toBe(IV_PATH);
    expect(sources.indexerConfig).toEqual({
      factory: FACTORY,
      registry: REGISTRY,
      premium: PREMIUM,
    });
  });

  it('does not open a network connection when composing RPC sources', () => {
    const original = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> => {
      throw new Error('resolveSources must not call the node');
    };
    try {
      const sources = resolveSources(LIVE_ENV);
      expect(sources.logSource).toBeInstanceOf(SessionAwareLogSource);
      expect(sources.quoteSource).toBeInstanceOf(RpcQuoteSource);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses a live URL that is missing BELL_FACTORY', () => {
    expect(() =>
      resolveSources({
        BELL_RPC_URL: RPC_URL,
        BELL_REGISTRY: REGISTRY,
        BELL_PREMIUM: PREMIUM,
      }),
    ).toThrow(/BELL_FACTORY/);
  });

  it('refuses a live URL that is missing BELL_REGISTRY', () => {
    expect(() =>
      resolveSources({
        BELL_RPC_URL: RPC_URL,
        BELL_FACTORY: FACTORY,
        BELL_PREMIUM: PREMIUM,
      }),
    ).toThrow(/BELL_REGISTRY/);
  });

  it('refuses a live URL that is missing BELL_PREMIUM', () => {
    expect(() =>
      resolveSources({
        BELL_RPC_URL: RPC_URL,
        BELL_FACTORY: FACTORY,
        BELL_REGISTRY: REGISTRY,
      }),
    ).toThrow(/BELL_PREMIUM/);
  });

  it('treats a blank companion address as missing', () => {
    expect(() =>
      resolveSources({
        ...LIVE_ENV,
        BELL_FACTORY: '  ',
      }),
    ).toThrow(/BELL_FACTORY/);
  });
});
