import { describe, expect, it } from 'vitest';

import { IV_PATH } from '../../src/adapters/corpus.js';
import { FileIvSource } from '../../src/adapters/iv_source_file.js';
import { loadPublishedIv } from '../../src/application/iv.js';
import { type IvPublishInput, type IvSource } from '../../src/domain/ports.js';

const ivSource = new FileIvSource(IV_PATH);

const CORPUS_SESSION_ADDRESS = '0x86919b9245178f2d05c3fe2ea7e117f19f3d60f3';
const TRAILING_SESSION_ADDRESS = '0x00000000000000000000000000000000000000f1';
const REFUSE_SESSION_ADDRESS = '0x00000000000000000000000000000000000000f2';

class MemoryIvSource implements IvSource {
  readonly rows: readonly IvPublishInput[];
  constructor(rows: readonly IvPublishInput[]) {
    this.rows = rows;
  }
  readings(): Promise<readonly IvPublishInput[]> {
    return Promise.resolve(this.rows);
  }
}

describe('loadPublishedIv', () => {
  it('shows a fresh pool reading for the corpus session', async () => {
    const display = await loadPublishedIv(ivSource, CORPUS_SESSION_ADDRESS);
    expect(display.kind).toBe('show');
    if (display.kind !== 'show') return;
    expect(display.sigma).toBe('0.2');
    expect(display.provenance).toBe('pool');
    expect(display.ageSessions).toBe('0');
  });

  it('shows trailing-realised provenance when the pool reading is stale', async () => {
    const display = await loadPublishedIv(ivSource, TRAILING_SESSION_ADDRESS);
    expect(display.kind).toBe('show');
    if (display.kind !== 'show') return;
    expect(display.sigma).toBe('0.15');
    expect(display.provenance).toBe('trailing-realised');
    expect(display.ageSessions).toBe('0');
  });

  it('omits rather than inventing sigma when publication refuses', async () => {
    const display = await loadPublishedIv(ivSource, REFUSE_SESSION_ADDRESS);
    expect(display.kind).toBe('omit');
    if (display.kind !== 'omit') return;
    expect(display).not.toHaveProperty('sigma');
    expect(display.message).not.toMatch(/\d+\.\d+/);
  });

  it('omits a missing session row rather than inventing sigma', async () => {
    const display = await loadPublishedIv(ivSource, '0xdead');
    expect(display.kind).toBe('omit');
    expect(display).not.toHaveProperty('sigma');
  });

  it('omits when the pool reading cannot be aged at the view session', async () => {
    const display = await loadPublishedIv(
      new MemoryIvSource([
        {
          forSessionAddress: '0xfuture',
          viewSession: 1n,
          pool: { sigmaWad: 200_000_000_000_000_000n, session: 5n, provenance: 'pool' },
          fallback: null,
        },
      ]),
      '0xfuture',
    );
    expect(display.kind).toBe('omit');
  });

  it('does not swallow unexpected errors as omit', async () => {
    const row = new Proxy(
      {
        forSessionAddress: '0xboom',
        viewSession: 0n,
        pool: { sigmaWad: 0n, session: 0n, provenance: 'pool' as const },
        fallback: null,
      },
      {
        get(target: IvPublishInput, prop: string | symbol): unknown {
          if (prop === 'forSessionAddress') return target.forSessionAddress;
          throw new Error('boom');
        },
      },
    );
    await expect(loadPublishedIv(new MemoryIvSource([row]), '0xboom')).rejects.toThrow('boom');
  });

  it('matches a mixed-case session address against the lowercased fixture key', async () => {
    const display = await loadPublishedIv(ivSource, '0x86919B9245178f2D05c3Fe2ea7E117f19F3d60F3');
    expect(display.kind).toBe('show');
  });

  it('passes boundSessions so a covered age publishes without a fallback', async () => {
    const source = new MemoryIvSource([
      {
        forSessionAddress: '0xbound',
        viewSession: 20n,
        boundSessions: 19n,
        pool: { sigmaWad: 200_000_000_000_000_000n, session: 1n, provenance: 'pool' },
        fallback: null,
      },
    ]);
    const covered = await loadPublishedIv(source, '0xbound');
    expect(covered.kind).toBe('show');
    if (covered.kind !== 'show') return;
    expect(covered.provenance).toBe('pool');
    expect(covered.ageSessions).toBe('19');

    const uncovered = await loadPublishedIv(
      new MemoryIvSource([
        {
          forSessionAddress: '0xbound',
          viewSession: 20n,
          pool: { sigmaWad: 200_000_000_000_000_000n, session: 1n, provenance: 'pool' },
          fallback: null,
        },
      ]),
      '0xbound',
    );
    expect(uncovered.kind).toBe('omit');
  });

  it('reads the committed fixture from spec/fixtures/iv.json', () => {
    expect(IV_PATH).toMatch(/spec\/fixtures\/iv\.json$/);
  });
});
