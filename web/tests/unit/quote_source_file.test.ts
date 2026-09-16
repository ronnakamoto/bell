import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileQuoteSource,
  parseQuoteDocument,
  QuoteSourceMalformed,
  QuoteSourceUnavailable,
} from '../../src/adapters/quote_source_file.js';

describe('parseQuoteDocument', () => {
  it('refuses invalid JSON', () => {
    expect(() => parseQuoteDocument('/q.json', 'not json')).toThrow(QuoteSourceMalformed);
  });

  it('refuses a document without a quotes array', () => {
    expect(() => parseQuoteDocument('/q.json', '{}')).toThrow(QuoteSourceMalformed);
    expect(() => parseQuoteDocument('/q.json', '{"quotes":"x"}')).toThrow(QuoteSourceMalformed);
    expect(() => parseQuoteDocument('/q.json', '[]')).toThrow(QuoteSourceMalformed);
  });

  it('refuses malformed quote rows', () => {
    expect(() => parseQuoteDocument('/q.json', '{"quotes":[null]}')).toThrow(QuoteSourceMalformed);
    expect(() =>
      parseQuoteDocument(
        '/q.json',
        '{"quotes":[{"nameId":1,"forSession":"1","verdict":"Usable"}]}',
      ),
    ).toThrow(QuoteSourceMalformed);
    expect(() =>
      parseQuoteDocument(
        '/q.json',
        '{"quotes":[{"nameId":"n","forSession":"x","verdict":"Usable","lambdaWad":"1","premiumWad":"1"}]}',
      ),
    ).toThrow(QuoteSourceMalformed);
    expect(() =>
      parseQuoteDocument(
        '/q.json',
        '{"quotes":[{"nameId":"n","forSession":"1","verdict":"Bad","lambdaWad":"1","premiumWad":"1"}]}',
      ),
    ).toThrow(QuoteSourceMalformed);
  });

  it('parses Usable, Fallback, and Refuse rows', () => {
    const rows = parseQuoteDocument(
      '/q.json',
      JSON.stringify({
        quotes: [
          {
            nameId: 'a',
            forSession: '1',
            verdict: 'Usable',
            lambdaWad: '10',
            premiumWad: '20',
          },
          {
            nameId: 'b',
            forSession: '2',
            verdict: 'Fallback',
            lambdaWad: '30',
            premiumWad: '40',
          },
          { nameId: 'c', forSession: '3', verdict: 'Refuse' },
        ],
      }),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.quote.verdict).toBe('Usable');
    expect(rows[2]?.quote).toEqual({ verdict: 'Refuse' });
  });
});

describe('FileQuoteSource', () => {
  it('reads a fixture file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-quotes-'));
    try {
      const path = join(dir, 'quotes.json');
      await writeFile(
        path,
        JSON.stringify({
          quotes: [{ nameId: 'n', forSession: '1', verdict: 'Refuse' }],
        }),
      );
      const source = new FileQuoteSource(path);
      const rows = await source.quotes();
      expect(rows).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws QuoteSourceUnavailable when the file is missing', async () => {
    const source = new FileQuoteSource('/no/such/quotes.json');
    await expect(source.quotes()).rejects.toThrow(QuoteSourceUnavailable);
  });

  it('throws QuoteSourceUnavailable for unreadable paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bell-quotes-'));
    try {
      const path = join(dir, 'quotes.json');
      await writeFile(path, '{}');
      await readFile(path, 'utf8');
      const source = new FileQuoteSource(path);
      await rm(path);
      await expect(source.quotes()).rejects.toThrow(QuoteSourceUnavailable);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wraps non-ENOENT read failures as unavailable', async () => {
    const source = new FileQuoteSource('\0');
    await expect(source.quotes()).rejects.toThrow(QuoteSourceUnavailable);
  });

  it('reports non-Error throws while parsing JSON', () => {
    const original = JSON.parse;
    JSON.parse = (): unknown => {
      throw new Error('bad');
    };
    try {
      expect(() => parseQuoteDocument('/q.json', '{}')).toThrow(QuoteSourceMalformed);
    } finally {
      JSON.parse = original;
    }
  });
});
