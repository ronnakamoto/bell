/**
 * The honest-quote use case.
 *
 * One function: look up a committed fixture row by `(nameId, forSession)` and return it, or refuse
 * when the key is absent. Missing must never invent a premium — that is F50's sharpest UI rule.
 */

import { fileURLToPath } from 'node:url';

import { FileQuoteSource } from '../adapters/quote_source_file.js';
import { type Quote } from '../domain/quote.js';

const QUOTES_PATH = fileURLToPath(new URL('../../../spec/fixtures/quotes.json', import.meta.url));

/** Return the fixture quote for `(nameId, forSession)`, or `Refuse` when no row exists. */
export async function loadQuote(nameId: string, forSession: bigint): Promise<Quote> {
  const entries = await new FileQuoteSource(QUOTES_PATH).quotes();
  const match = entries.find((entry) => entry.nameId === nameId && entry.forSession === forSession);
  return match?.quote ?? { verdict: 'Refuse' };
}
