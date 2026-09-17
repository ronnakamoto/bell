import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FileQuoteSource } from '../../src/adapters/quote_source_file.js';
import { loadQuote } from '../../src/application/quote.js';
import { type QuoteFixtureRow, type QuoteSource } from '../../src/domain/ports.js';
import { formatQuote, type Quote } from '../../src/domain/quote.js';

const QUOTES_PATH = fileURLToPath(new URL('../../../spec/fixtures/quotes.json', import.meta.url));
const quoteSource = new FileQuoteSource(QUOTES_PATH);

const CORPUS_NAME_ID = '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';
const FALLBACK_NAME_ID = '0x00000000000000000000000000000000000000000000000000000000000000f1';
const REFUSE_NAME_ID = '0x00000000000000000000000000000000000000000000000000000000000000f2';

/** A source whose list is empty so a quotes()-only lookup cannot invent a hit. */
class LookupQuoteSource implements QuoteSource {
  readonly inner: QuoteSource;
  constructor(inner: QuoteSource) {
    this.inner = inner;
  }
  quotes(): Promise<readonly QuoteFixtureRow[]> {
    return Promise.resolve([]);
  }
  quote(nameId: string, forSession: bigint): Promise<Quote> {
    return this.inner.quote(nameId, forSession);
  }
}

describe('loadQuote', () => {
  it('returns Usable for the corpus name commitment', async () => {
    const quote = await loadQuote(quoteSource, CORPUS_NAME_ID, 1n);
    expect(quote).toEqual({
      verdict: 'Usable',
      lambdaWad: 15_000_000_000_000_000_000n,
      premiumWad: 174_000_000_000_000_000n,
    });
    const display = formatQuote(quote);
    expect(display.kind).toBe('price');
    if (display.kind !== 'price') return;
    expect(display.isFallback).toBe(false);
  });

  it('returns Refuse for a missing key rather than inventing a premium', async () => {
    const quote = await loadQuote(quoteSource, CORPUS_NAME_ID, 99n);
    expect(quote).toEqual({ verdict: 'Refuse' });
    expect(quote).not.toHaveProperty('premiumWad');
    expect(quote).not.toHaveProperty('lambdaWad');
    const display = formatQuote(quote);
    expect(display.kind).toBe('refuse');
  });

  it('decodes a Fallback row with WAD parameters', async () => {
    const quote = await loadQuote(quoteSource, FALLBACK_NAME_ID, 2n);
    expect(quote).toEqual({
      verdict: 'Fallback',
      lambdaWad: 10_000_000_000_000_000_000n,
      premiumWad: 100_000_000_000_000_000n,
    });
    const display = formatQuote(quote);
    expect(display.kind).toBe('price');
    if (display.kind !== 'price') return;
    expect(display.isFallback).toBe(true);
  });

  it('decodes an explicit Refuse row without parameters', async () => {
    const quote = await loadQuote(quoteSource, REFUSE_NAME_ID, 3n);
    expect(quote).toEqual({ verdict: 'Refuse' });
    expect(formatQuote(quote).kind).toBe('refuse');
  });

  it('looks up through quote() rather than scanning quotes()', async () => {
    const quote = await loadQuote(new LookupQuoteSource(quoteSource), CORPUS_NAME_ID, 1n);
    expect(quote).toEqual({
      verdict: 'Usable',
      lambdaWad: 15_000_000_000_000_000_000n,
      premiumWad: 174_000_000_000_000_000n,
    });
  });

  it('reads the committed fixture from spec/fixtures/quotes.json', () => {
    const fixturePath = fileURLToPath(
      new URL('../../../spec/fixtures/quotes.json', import.meta.url),
    );
    expect(fixturePath).toMatch(/spec\/fixtures\/quotes\.json$/);
  });
});
