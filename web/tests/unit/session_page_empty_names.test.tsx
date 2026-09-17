// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/application/catalogue.js', () => ({
  loadSession: vi.fn(() =>
    Promise.resolve({
      address: '0xabc',
      lam: '1',
      expiryTimestamp: '1',
      registered: true,
      settled: false,
      referenceToken: '0xref',
      notionalCap: '1',
      cap: '1',
      salt: '0xsalt',
      names: [],
      pool: undefined,
      lastTrade: undefined,
      settlement: undefined,
      resolution: undefined,
    }),
  ),
}));

import SessionPage from '../../src/app/sessions/[address]/page.js';

beforeEach(() => {
  vi.stubEnv('BELL_RPC_URL', '');
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllEnvs();
});

describe('SessionPage without linked names', () => {
  it('refuses rather than inventing a premium', async () => {
    const page = await SessionPage({ params: Promise.resolve({ address: '0xabc' }) });
    render(page);
    expect(screen.getByTestId('quote-refuse')).toBeInTheDocument();
    expect(screen.getByTestId('bell-iv-omit')).toBeInTheDocument();
    expect(screen.queryByTestId('bell-iv-show')).toBeNull();
    expect(screen.getByTestId('eligibility-required')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-disabled-refuse')).toBeNull();
    fireEvent.click(screen.getByTestId('eligibility-not-us'));
    fireEvent.click(screen.getByTestId('eligibility-tos-reset'));
    fireEvent.click(screen.getByTestId('eligibility-accept'));
    expect(screen.getByTestId('trade-disabled-refuse')).toBeInTheDocument();
    expect(screen.getByTestId('claim-disabled-not-settled')).toBeInTheDocument();
    expect(screen.queryByTestId('claim-preview')).toBeNull();
    expect(screen.queryByLabelText('Linked names')).toBeNull();
  });
});
