/**
 * The challenge-report use case.
 *
 * List fixture labels and run one labelled case through the injected source. The application
 * never learns that a file or a settlement adapter was involved — that is the adapter's job.
 */

import { type ChallengeReportView } from '../domain/challenge.js';
import { type ChallengeSource } from '../domain/ports.js';

/** Return every case label the source currently holds, in source order. */
export async function listChallengeLabels(source: ChallengeSource): Promise<readonly string[]> {
  return source.labels();
}

/** Return the source report for `label`. */
export async function verifyChallengeCase(
  source: ChallengeSource,
  label: string,
): Promise<ChallengeReportView> {
  return source.verify(label);
}
