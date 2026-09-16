// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CORPUS_SESSION_ADDRESS } from '../../src/adapters/corpus.js';
import RootLayout from '../../src/app/layout.js';
import HomePage from '../../src/app/page.js';
import SessionPage from '../../src/app/sessions/[address]/page.js';

afterEach(() => {
  cleanup();
});

describe('RootLayout', () => {
  it('renders the site header and main landmark', () => {
    render(<RootLayout>{<p>child</p>}</RootLayout>);
    expect(screen.getByRole('heading', { level: 1, name: 'BELL' })).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();
  });
});

describe('HomePage', () => {
  it('lists sessions from the producer corpus', async () => {
    const page = await HomePage();
    render(page);
    expect(screen.getByRole('heading', { level: 2, name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: CORPUS_SESSION_ADDRESS })).toBeInTheDocument();
    expect(screen.getByText(/expiry 1800063000/)).toBeInTheDocument();
  });
});

describe('SessionPage', () => {
  it('renders session detail and an honest quote for the corpus session', async () => {
    const page = await SessionPage({
      params: Promise.resolve({ address: CORPUS_SESSION_ADDRESS }),
    });
    render(page);
    expect(
      screen.getByRole('heading', { level: 2, name: CORPUS_SESSION_ADDRESS }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('quote-premium')).toBeInTheDocument();
    expect(screen.getByLabelText('Linked names')).toBeInTheDocument();
    const pool = screen.getByLabelText('Pool');
    expect(within(pool).getByText('Long in')).toBeInTheDocument();
    expect(within(pool).getByText('Short in')).toBeInTheDocument();
    expect(screen.getByLabelText('Last trade')).toBeInTheDocument();
    expect(screen.getByLabelText('Settlement')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    expect(screen.getByTestId('trade-preview')).toBeEnabled();
    expect(screen.getByTestId('lp-preview')).toBeEnabled();
    expect(screen.getByTestId('claim-preview')).toBeEnabled();
    expect(screen.getByTestId('withdraw-pool-preview')).toBeEnabled();
  });

  it('calls notFound for an unknown address', async () => {
    await expect(
      SessionPage({
        params: Promise.resolve({ address: '0x0000000000000000000000000000000000000001' }),
      }),
    ).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
