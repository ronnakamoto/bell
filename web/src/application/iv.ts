/**
 * The honest BELL-IV use case.
 *
 * Look up a committed fixture row by session address, run it through `publishedVolatility`, and
 * format the result. Missing rows and ImpliedError refusals omit the number rather than inventing
 * a sigma — the same honesty rule the quote use case applies to a missing premium.
 */

import {
  ImpliedError,
  publishedVolatility,
  VolatilityReading,
} from '@bell/calibrator/domain/implied.js';

import { formatOmittedIv, formatPublishedIv, type IvDisplay } from '../domain/iv.js';
import { type IvSource } from '../domain/ports.js';

/** Return the published IV display for `sessionAddress`, or omit when none can be published. */
export async function loadPublishedIv(
  source: IvSource,
  sessionAddress: string,
): Promise<IvDisplay> {
  const entries = await source.readings();
  const match = entries.find((entry) => entry.forSessionAddress === sessionAddress.toLowerCase());
  if (match === undefined) {
    return formatOmittedIv();
  }
  try {
    const pool = new VolatilityReading(match.pool);
    const fallback = match.fallback === null ? null : new VolatilityReading(match.fallback);
    const published = publishedVolatility(pool, match.viewSession, fallback, match.boundSessions);
    return formatPublishedIv({
      sigmaWad: published.sigmaWad,
      provenance: published.provenance,
      ageSessions: published.ageAt(match.viewSession),
    });
  } catch (error) {
    if (error instanceof ImpliedError) {
      return formatOmittedIv();
    }
    throw error;
  }
}
