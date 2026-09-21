// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CORPUS_SESSION_ADDRESS } from '../../src/adapters/corpus.js';
import ChallengeCasePage from '../../src/app/challenge/[label]/page.js';
import ChallengeListPage from '../../src/app/challenge/page.js';
import RootLayout from '../../src/app/layout.js';
import HomePage from '../../src/app/page.js';
import SessionPage from '../../src/app/sessions/[address]/page.js';
import { ELIGIBILITY_STORAGE_KEY } from '../../src/components/eligibilityStorage.js';

beforeEach(() => {
  vi.stubEnv('BELL_RPC_URL', '');
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllEnvs();
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

  it('links to the challenge list', async () => {
    const page = await HomePage();
    render(page);
    expect(screen.getByRole('link', { name: 'Challenge' })).toHaveAttribute('href', '/challenge');
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
    const shownIv = screen.getByTestId('bell-iv-show');
    expect(shownIv).toHaveTextContent('0.2');
    expect(shownIv).toHaveTextContent('pool');
    expect(shownIv).toHaveTextContent('0');
    expect(screen.queryByTestId('bell-iv-omit')).toBeNull();
    expect(screen.getByLabelText('Linked names')).toBeInTheDocument();
    const pool = screen.getByLabelText('Pool');
    expect(within(pool).getByText('Long in')).toBeInTheDocument();
    expect(within(pool).getByText('Short in')).toBeInTheDocument();
    expect(screen.getByLabelText('Last trade')).toBeInTheDocument();
    expect(screen.getByLabelText('Settlement')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    expect(screen.getByTestId('eligibility-required')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-preview')).toBeNull();
    expect(screen.queryByTestId('claim-preview')).toBeNull();
    fireEvent.click(screen.getByTestId('eligibility-not-us'));
    fireEvent.click(screen.getByTestId('eligibility-tos-reset'));
    fireEvent.click(screen.getByTestId('eligibility-accept'));
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

const FIXTURE_LABELS = [
  'upheld-store',
  'digest-mismatch',
  'inputs-unavailable',
  'slashed-premium',
] as const;

describe('ChallengeListPage', () => {
  it('lists fixture labels with a link each and a pre-bond note', async () => {
    const page = await ChallengeListPage();
    render(page);
    expect(screen.getByRole('heading', { level: 2, name: 'Challenge' })).toBeInTheDocument();
    expect(screen.getByText(/pre-bond/i)).toBeInTheDocument();
    expect(screen.getByText(/intent preview/i)).toBeInTheDocument();
    expect(screen.queryByText(/no on-chain challenge/i)).toBeNull();
    for (const label of FIXTURE_LABELS) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute(
        'href',
        `/challenge/${label}`,
      );
    }
  });
});

describe('ChallengeCasePage', () => {
  /** Accept the first remaining eligibility gate, which disappears once accepted. */
  function acceptGate(): void {
    const notUs = screen.getAllByTestId('eligibility-not-us').at(0);
    const tosReset = screen.getAllByTestId('eligibility-tos-reset').at(0);
    const accept = screen.getAllByTestId('eligibility-accept').at(0);
    if (notUs === undefined || tosReset === undefined || accept === undefined) {
      throw new Error('expected an eligibility gate');
    }
    fireEvent.click(notUs);
    fireEvent.click(tosReset);
    fireEvent.click(accept);
  }

  it('renders an upheld report from a real store re-fit', async () => {
    const page = await ChallengeCasePage({
      params: Promise.resolve({ label: 'upheld-store' }),
    });
    render(page);
    expect(screen.getByRole('heading', { level: 2, name: 'upheld-store' })).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('kind=upheld');
    expect(screen.getByTestId('challenge-premium-delta')).toHaveTextContent('0');
    expect(screen.getByText(/no wallet/i)).toBeInTheDocument();
    expect(screen.getByTestId('challenge-intent-disabled-upheld')).toBeInTheDocument();
    expect(screen.queryByTestId('challenge-preview')).toBeNull();
    // The upheld report carries the arbiter's ruling surface, behind eligibility.
    expect(screen.getByTestId('eligibility-required')).toBeInTheDocument();
    expect(screen.queryByTestId('resolve-submit')).toBeNull();
    fireEvent.click(screen.getByTestId('eligibility-not-us'));
    fireEvent.click(screen.getByTestId('eligibility-tos-reset'));
    fireEvent.click(screen.getByTestId('eligibility-accept'));
    expect(screen.getByTestId('resolve-submit')).toBeEnabled();
  });

  it('renders the three negative fixture kinds', async () => {
    const expected = [
      ['digest-mismatch', 'kind=digest-mismatch'],
      ['inputs-unavailable', 'kind=inputs-unavailable'],
      ['slashed-premium', 'kind=slashed'],
    ] as const;
    for (const [label, kind] of expected) {
      const page = await ChallengeCasePage({
        params: Promise.resolve({ label }),
      });
      render(page);
      expect(screen.getByRole('heading', { level: 2, name: label })).toBeInTheDocument();
      expect(screen.getByTestId('challenge-kind')).toHaveTextContent(kind);
      cleanup();
    }
  });

  it('shows a disabled notice for digest-mismatch and inputs-unavailable', async () => {
    const expected = [
      ['digest-mismatch', 'challenge-intent-disabled-digest-mismatch'],
      ['inputs-unavailable', 'challenge-intent-disabled-inputs-unavailable'],
    ] as const;
    for (const [label, testId] of expected) {
      const page = await ChallengeCasePage({
        params: Promise.resolve({ label }),
      });
      render(page);
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      expect(screen.queryByTestId('challenge-preview')).toBeNull();
      expect(screen.queryByTestId('eligibility-required')).toBeNull();
      cleanup();
    }
  });

  it('gates the slashed preview and the ruling behind eligibility and then shows both', async () => {
    const page = await ChallengeCasePage({
      params: Promise.resolve({ label: 'slashed-premium' }),
    });
    render(page);
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('kind=slashed');
    // Both the challenger's form and the arbiter's ruling surface are gated.
    expect(screen.getAllByTestId('eligibility-required')).toHaveLength(2);
    expect(screen.queryByTestId('challenge-preview')).toBeNull();
    expect(screen.queryByTestId('resolve-submit')).toBeNull();
    acceptGate();
    // The first gate is now gone; the remaining one is the ruling's.
    acceptGate();
    expect(screen.getByTestId('challenge-preview')).toBeEnabled();
    expect(screen.getByTestId('resolve-submit')).toBeEnabled();
    fireEvent.click(screen.getByTestId('challenge-preview'));
    expect(screen.getByText('Approve premium registry to spend collateral')).toBeInTheDocument();
    expect(screen.getByText('Challenge committed premium')).toBeInTheDocument();
  });

  it('shows the slashed preview when sessionStorage already holds a valid attestation', async () => {
    sessionStorage.setItem(
      ELIGIBILITY_STORAGE_KEY,
      '{"notUsPerson":true,"tosResetAcknowledged":true}',
    );
    const page = await ChallengeCasePage({
      params: Promise.resolve({ label: 'slashed-premium' }),
    });
    render(page);
    expect(screen.getByTestId('challenge-preview')).toBeEnabled();
    expect(screen.queryByTestId('eligibility-required')).toBeNull();
  });

  it('calls notFound for an unknown label', async () => {
    await expect(
      ChallengeCasePage({
        params: Promise.resolve({ label: 'no-such-case' }),
      }),
    ).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
