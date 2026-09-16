// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    }),
  ),
}));

import SessionPage from '../../src/app/sessions/[address]/page.js';

afterEach(() => {
  cleanup();
});

describe('SessionPage without linked names', () => {
  it('refuses rather than inventing a premium', async () => {
    const page = await SessionPage({ params: Promise.resolve({ address: '0xabc' }) });
    render(page);
    expect(screen.getByTestId('quote-refuse')).toBeInTheDocument();
    expect(screen.queryByLabelText('Linked names')).toBeNull();
  });
});
