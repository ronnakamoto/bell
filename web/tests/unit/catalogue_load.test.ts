import { FileLogSource } from '@bell/indexer/adapters/log_source_file.js';
import { describe, expect, it } from 'vitest';

import { CORPUS_SESSION_ADDRESS, INDEXER_CONFIG, LOGS_PATH } from '../../src/adapters/corpus.js';
import { loadCatalogue, loadSession } from '../../src/application/catalogue.js';

const logSource = new FileLogSource(LOGS_PATH);

const CORPUS_NAME_ID = '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';

describe('loadCatalogue', () => {
  it('recovers one settled session and one name from the producer corpus', async () => {
    const catalogue = await loadCatalogue(logSource, INDEXER_CONFIG);
    expect(catalogue.sessions).toHaveLength(1);
    const session = catalogue.sessions[0];
    expect(session?.address).toBe(CORPUS_SESSION_ADDRESS);
    expect(session?.address).toBe(session?.address.toLowerCase());
    expect(session?.settled).toBe(true);
    expect(session?.registered).toBe(true);
    expect(session?.lam).toBe('15');
    expect(session?.expiryTimestamp).toBe('1800063000');

    expect(catalogue.names).toHaveLength(1);
    const name = catalogue.names[0];
    expect(name?.nameId).toBe(CORPUS_NAME_ID);
    expect(name?.forSession).toBe('1');
    expect(name?.lambda).toBe('15');
    expect(name?.premium).toBe('0.174');
  });
});

describe('loadSession', () => {
  it('returns detail for the corpus session address', async () => {
    const detail = await loadSession(logSource, INDEXER_CONFIG, CORPUS_SESSION_ADDRESS);
    expect(detail?.address).toBe(CORPUS_SESSION_ADDRESS);
    expect(detail?.settled).toBe(true);
    expect(detail?.names).toHaveLength(1);
    expect(detail?.names[0]?.forSession).toBe('1');
  });

  it('returns undefined for an address the corpus does not hold', async () => {
    expect(
      await loadSession(logSource, INDEXER_CONFIG, '0x0000000000000000000000000000000000000001'),
    ).toBeUndefined();
  });
});
