/**
 * The discovery use case.
 *
 * The use case is tested against a `LogSource` that returns literals, because that is the test the
 * brief applies for whether something belongs in the application layer: it sequences the domain's
 * pieces and touches nothing. The corpus is the literal; a recording double is the source.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { catalogueFrom } from '../../src/application/catalogue.js';
import { emptyCatalogue } from '../../src/domain/catalogue.js';
import { type RawLog } from '../../src/domain/log.js';
import { type IndexerConfig, type LogSource } from '../../src/domain/ports.js';

interface Fixture {
  readonly logs: readonly RawLog[];
}

const CORPUS: Fixture = JSON.parse(
  readFileSync(new URL('../../../spec/fixtures/logs.json', import.meta.url), 'utf8'),
) as Fixture;

const SESSION_CREATED = '0xbfea4ffed12dea0f10d6ed0862b3b921c451b49a70efdd3461d7423842282b00';
const SESSION_REGISTERED = '0x28e487a6111e0cb65c7a6ef4ffc45a36e06b481fb2cf18dbde02b4c88e6aee67';
const COMMITTED = '0x8c8ec3404e0fe9635c7532cb2fabce3bb5e9f7e539e917ac8765bbea6a7696d8';

function configFromCorpus(): IndexerConfig {
  const created = CORPUS.logs.find((log) => log.topics[0] === SESSION_CREATED);
  const registered = CORPUS.logs.find((log) => log.topics[0] === SESSION_REGISTERED);
  const committed = CORPUS.logs.find((log) => log.topics[0] === COMMITTED);
  if (created === undefined || registered === undefined || committed === undefined) {
    throw new Error('the corpus is missing a singleton anchor');
  }
  return {
    factory: created.emitter,
    registry: registered.emitter,
    premium: committed.emitter,
  };
}

function sourceOf(logs: readonly RawLog[]): LogSource {
  return { logs: () => Promise.resolve(logs) };
}

describe('catalogueFrom', () => {
  const config = configFromCorpus();

  it('folds the source\u2019s logs into the corpus session', async () => {
    const catalogue = await catalogueFrom(sourceOf(CORPUS.logs), config);
    expect(catalogue.sessions).toHaveLength(1);
    expect(catalogue.sessions[0]?.resolution?.gapWad).toBe(20_000_000_000_000_000n);
    expect(catalogue.sessions[0]?.resolution?.payoffWad).toBe(300_000_000_000_000_000n);
  });

  it('is empty when the source is empty', async () => {
    expect(await catalogueFrom(sourceOf([]), config)).toBe(emptyCatalogue());
  });

  it('awaits the source rather than folding an argument it was not given', async () => {
    // A source that refuses is how a use case that skipped the port and folded `[]` would still
    // pass the empty-source test above.
    const refusing: LogSource = {
      logs: () => Promise.reject(new Error('the source was asked')),
    };
    await expect(catalogueFrom(refusing, config)).rejects.toThrow('the source was asked');
  });
});
