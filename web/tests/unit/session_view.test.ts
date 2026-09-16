import {
  type Catalogue,
  type NameRecord,
  type SessionRecord,
} from '@bell/indexer/domain/catalogue.js';
import { describe, expect, it } from 'vitest';

import { toCatalogueView, toSessionDetail } from '../../src/domain/session_view.js';

const baseSession: SessionRecord = {
  address: '0xabc',
  referenceToken: '0xref',
  lamWad: 10n ** 18n,
  expiryTimestamp: 1_800_000_000n,
  capWad: 2n * 10n ** 18n,
  notionalCapWad: 3n * 10n ** 18n,
  salt: '0xsalt',
  registered: true,
  multiplier: undefined,
  pool: undefined,
  shares: undefined,
  lastTrade: undefined,
  settlement: undefined,
  resolution: undefined,
};

const settledSession: SessionRecord = {
  ...baseSession,
  resolution: {
    branch: 'LivePrint',
    gapWad: 0n,
    payoffWad: 0n,
    settled: true,
  },
};

const baseName: NameRecord = {
  nameId: '0xname',
  forSession: 1n,
  lambdaWad: 15n * 10n ** 16n,
  premiumWad: 174n * 10n ** 15n,
  inputsHash: '0xhash',
  digest: '0xdigest',
  bond: 0n,
  challenger: undefined,
  publisherCorrect: undefined,
  transferred: undefined,
};

describe('toCatalogueView', () => {
  it('maps sessions and names to string-only rows', () => {
    const catalogue: Catalogue = {
      sessions: [settledSession],
      names: [baseName],
      prints: [],
    };
    const view = toCatalogueView(catalogue);
    expect(view.sessions[0]?.settled).toBe(true);
    expect(view.sessions[0]?.lam).toBe('1');
    expect(view.names[0]?.lambda).toBe('0.15');
    expect(view.names[0]?.premium).toBe('0.174');
  });

  it('treats a session without resolution as unsettled', () => {
    const view = toCatalogueView({ sessions: [baseSession], names: [], prints: [] });
    expect(view.sessions[0]?.settled).toBe(false);
  });

  it('formats negative and fractional WAD values', () => {
    const session: SessionRecord = {
      ...baseSession,
      lamWad: -1_500_000_000_000_000_000n,
    };
    const name: NameRecord = {
      ...baseName,
      lambdaWad: -2n * 10n ** 17n,
      premiumWad: 123_456_789_000_000_000n,
    };
    const view = toCatalogueView({ sessions: [session], names: [name], prints: [] });
    expect(view.sessions[0]?.lam).toBe('-1.5');
    expect(view.names[0]?.lambda).toBe('-0.2');
    expect(view.names[0]?.premium).toBe('0.123456789');
  });

  it('formats a negative whole WAD without a fractional part', () => {
    const session: SessionRecord = {
      ...baseSession,
      lamWad: -(10n ** 18n),
    };
    const view = toCatalogueView({ sessions: [session], names: [], prints: [] });
    expect(view.sessions[0]?.lam).toBe('-1');
  });
});

describe('toSessionDetail', () => {
  it('includes session fields and linked names', () => {
    const detail = toSessionDetail(settledSession, [baseName]);
    expect(detail.referenceToken).toBe('0xref');
    expect(detail.notionalCap).toBe('3');
    expect(detail.cap).toBe('2');
    expect(detail.expiryTimestamp).toBe('1800000000');
    expect(detail.names).toHaveLength(1);
    expect(detail.names[0]?.forSession).toBe('1');
    expect(detail.pool).toBeUndefined();
    expect(detail.lastTrade).toBeUndefined();
    expect(detail.settlement).toBeUndefined();
    expect(detail.resolution?.branch).toBe('LivePrint');
    expect(detail.resolution?.settled).toBe(true);
  });

  it('omits resolution when the fold has none', () => {
    const detail = toSessionDetail(baseSession, []);
    expect(detail.resolution).toBeUndefined();
    expect(detail.settled).toBe(false);
  });

  it('maps pool, trade, and settlement snapshots when present', () => {
    const session: SessionRecord = {
      ...settledSession,
      pool: {
        longIn: 1_000_000_000_000n,
        shortIn: 200_000_000_000n,
        longReserve: 1_000_000_000_000n,
        shortReserve: 200_000_000_000n,
      },
      lastTrade: {
        trader: '0xtrader',
        boughtLong: true,
        collateralIn: 50_000_000_000n,
        claimOut: 40_000_000_000n,
      },
      settlement: {
        payoffLongWad: 300_000_000_000_000_000n,
        staleReference: false,
      },
      resolution: {
        branch: 'LivePrint',
        gapWad: 20_000_000_000_000_000n,
        payoffWad: 300_000_000_000_000_000n,
        settled: true,
      },
    };
    const detail = toSessionDetail(session, []);
    expect(detail.pool).toEqual({
      longIn: '1000000000000',
      shortIn: '200000000000',
      longReserve: '1000000000000',
      shortReserve: '200000000000',
    });
    expect(detail.lastTrade).toEqual({
      trader: '0xtrader',
      boughtLong: true,
      collateralIn: '50000000000',
      claimOut: '40000000000',
    });
    expect(detail.settlement).toEqual({
      payoffLongWad: '0.3',
      staleReference: false,
    });
    expect(detail.resolution).toEqual({
      branch: 'LivePrint',
      gapWad: '0.02',
      payoffWad: '0.3',
      settled: true,
    });
  });
});
