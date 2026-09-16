import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileIvSource,
  IvSourceMalformed,
  IvSourceUnavailable,
  parseIvDocument,
} from '../../src/adapters/iv_source_file.js';

describe('parseIvDocument', () => {
  it('refuses invalid JSON', () => {
    expect(() => parseIvDocument('/iv.json', 'not json')).toThrow(IvSourceMalformed);
  });

  it('refuses a document without a readings array', () => {
    expect(() => parseIvDocument('/iv.json', '{}')).toThrow(IvSourceMalformed);
    expect(() => parseIvDocument('/iv.json', '{"readings":"x"}')).toThrow(IvSourceMalformed);
    expect(() => parseIvDocument('/iv.json', '[]')).toThrow(IvSourceMalformed);
    expect(() => parseIvDocument('/iv.json', 'null')).toThrow(IvSourceMalformed);
  });

  it('refuses malformed reading rows', () => {
    expect(() => parseIvDocument('/iv.json', '{"readings":[null]}')).toThrow(IvSourceMalformed);
    expect(() =>
      parseIvDocument(
        '/iv.json',
        '{"readings":[{"forSessionAddress":1,"viewSession":"1","pool":{},"fallback":null}]}',
      ),
    ).toThrow(IvSourceMalformed);
    expect(() =>
      parseIvDocument(
        '/iv.json',
        '{"readings":[{"forSessionAddress":"0xabc","viewSession":"x","pool":{"sigmaWad":"1","session":"1","provenance":"pool"},"fallback":null}]}',
      ),
    ).toThrow(IvSourceMalformed);
    expect(() =>
      parseIvDocument(
        '/iv.json',
        '{"readings":[{"forSessionAddress":"0xabc","viewSession":"1","pool":{"sigmaWad":"1","session":"1","provenance":"stale"},"fallback":null}]}',
      ),
    ).toThrow(IvSourceMalformed);
    expect(() => parseIvDocument('/iv.json', '{"readings":[[]]}')).toThrow(IvSourceMalformed);
    expect(() =>
      parseIvDocument(
        '/iv.json',
        '{"readings":[{"forSessionAddress":"0xabc","viewSession":"1","pool":null,"fallback":null}]}',
      ),
    ).toThrow(IvSourceMalformed);
    expect(() =>
      parseIvDocument(
        '/iv.json',
        '{"readings":[{"forSessionAddress":"0xabc","viewSession":"1","pool":{"sigmaWad":"1","session":"1","provenance":"pool"},"fallback":"x"}]}',
      ),
    ).toThrow(IvSourceMalformed);
    expect(() =>
      parseIvDocument(
        '/iv.json',
        '{"readings":[{"forSessionAddress":"0xabc","viewSession":"1","boundSessions":"x","pool":{"sigmaWad":"1","session":"1","provenance":"pool"},"fallback":null}]}',
      ),
    ).toThrow(IvSourceMalformed);
  });

  it('lowercases forSessionAddress on parse', () => {
    const rows = parseIvDocument(
      '/iv.json',
      JSON.stringify({
        readings: [
          {
            forSessionAddress: '0x3FC355A5BC036EA3F52849BBA638D3E257A0E6CC',
            viewSession: '1',
            pool: { sigmaWad: '1', session: '1', provenance: 'pool' },
            fallback: null,
          },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.forSessionAddress).toBe('0x3fc355a5bc036ea3f52849bba638d3e257a0e6cc');
    expect(rows[0]?.boundSessions).toBeUndefined();
  });

  it('parses pool, trailing fallback, and refuse rows', () => {
    const rows = parseIvDocument(
      '/iv.json',
      JSON.stringify({
        readings: [
          {
            forSessionAddress: '0xaaa',
            viewSession: '1',
            boundSessions: '12',
            pool: { sigmaWad: '200000000000000000', session: '1', provenance: 'pool' },
            fallback: null,
          },
          {
            forSessionAddress: '0xbbb',
            viewSession: '20',
            boundSessions: '12',
            pool: { sigmaWad: '200000000000000000', session: '1', provenance: 'pool' },
            fallback: {
              sigmaWad: '150000000000000000',
              session: '20',
              provenance: 'trailing-realised',
            },
          },
          {
            forSessionAddress: '0xccc',
            viewSession: '20',
            boundSessions: '12',
            pool: { sigmaWad: '200000000000000000', session: '1', provenance: 'pool' },
            fallback: null,
          },
        ],
      }),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.pool.provenance).toBe('pool');
    expect(rows[0]?.fallback).toBeNull();
    expect(rows[0]?.boundSessions).toBe(12n);
    expect(rows[1]?.fallback?.provenance).toBe('trailing-realised');
    expect(rows[1]?.fallback?.sigmaWad).toBe(150_000_000_000_000_000n);
    expect(rows[2]?.fallback).toBeNull();
  });
});

describe('FileIvSource', () => {
  it('reads a fixture file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-iv-'));
    try {
      const path = join(dir, 'iv.json');
      await writeFile(
        path,
        JSON.stringify({
          readings: [
            {
              forSessionAddress: '0xabc',
              viewSession: '1',
              pool: { sigmaWad: '1', session: '1', provenance: 'pool' },
              fallback: null,
            },
          ],
        }),
      );
      const source = new FileIvSource(path);
      const rows = await source.readings();
      expect(rows).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws IvSourceUnavailable when the file is missing', async () => {
    const source = new FileIvSource('/no/such/iv.json');
    await expect(source.readings()).rejects.toThrow(IvSourceUnavailable);
  });

  it('throws IvSourceUnavailable for unreadable paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-iv-'));
    try {
      const path = join(dir, 'iv.json');
      await writeFile(path, '{}');
      await readFile(path, 'utf8');
      const source = new FileIvSource(path);
      await rm(path);
      await expect(source.readings()).rejects.toThrow(IvSourceUnavailable);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wraps non-ENOENT read failures as unavailable', async () => {
    const source = new FileIvSource('\0');
    await expect(source.readings()).rejects.toThrow(IvSourceUnavailable);
  });

  it('reports non-Error throws while parsing JSON', () => {
    const original = JSON.parse;
    JSON.parse = (): unknown => {
      throw new Error('bad');
    };
    try {
      expect(() => parseIvDocument('/iv.json', '{}')).toThrow(IvSourceMalformed);
    } finally {
      JSON.parse = original;
    }
  });
});
