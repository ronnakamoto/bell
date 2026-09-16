/**
 * The honest-quote use case.
 *
 * One function: look up a committed fixture row by `(nameId, forSession)` and return it, or refuse
 * when the key is absent. Missing must never invent a premium — that is F50's sharpest UI rule.
 */

import { type QuoteSource } from '../domain/ports.js';
import { type Quote } from '../domain/quote.js';

/** Return the fixture quote for `(nameId, forSession)`, or `Refuse` when no row exists. */
export async function loadQuote(
  source: QuoteSource,
  nameId: string,
  forSession: bigint,
): Promise<Quote> {
  const entries = await source.quotes();
  const match = entries.find((entry) => entry.nameId === nameId && entry.forSession === forSession);
  return match?.quote ?? { verdict: 'Refuse' };
}
