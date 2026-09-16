// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionIntents } from '../../src/components/SessionIntents.js';
import { TradeForm } from '../../src/components/TradeForm.js';

afterEach(() => {
  cleanup();
});

describe('TradeForm', () => {
  it('starts with an empty minOut input', () => {
    render(<TradeForm />);
    expect(screen.getByTestId('trade-min-out')).toHaveValue('');
  });

  it('previews buy-long steps for integer amounts', () => {
    render(<TradeForm />);
    fireEvent.change(screen.getByLabelText('Collateral in'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('trade-min-out'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('trade-preview'));
    expect(screen.getByText('Approve session to spend collateral')).toBeInTheDocument();
    expect(screen.getByText('Buy long claims')).toBeInTheDocument();
  });

  it('previews buy-short steps when short is selected', () => {
    render(<TradeForm />);
    fireEvent.change(screen.getByLabelText('Side'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Collateral in'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('trade-min-out'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('trade-preview'));
    expect(screen.getByText('Buy short claims')).toBeInTheDocument();
  });

  it('shows an error for non-digit amounts', () => {
    render(<TradeForm />);
    fireEvent.change(screen.getByLabelText('Collateral in'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByTestId('trade-min-out'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('trade-preview'));
    expect(screen.getByText(/integer|digits|empty/i)).toBeInTheDocument();
    expect(screen.queryByText('Buy long claims')).toBeNull();
  });

  it('shows the domain error when minOut is zero', () => {
    render(<TradeForm />);
    fireEvent.change(screen.getByLabelText('Collateral in'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('trade-min-out'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('trade-preview'));
    expect(screen.getByText(/minOut|slippage/i)).toBeInTheDocument();
  });
});

describe('SessionIntents', () => {
  it('hides trade and LP forms when the quote is Refuse', () => {
    render(<SessionIntents quote={{ verdict: 'Refuse' }} />);
    expect(screen.getByTestId('trade-disabled-refuse')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-preview')).toBeNull();
    expect(screen.queryByTestId('lp-preview')).toBeNull();
  });

  it('renders trade and LP forms when the quote is Usable', () => {
    render(
      <SessionIntents
        quote={{
          verdict: 'Usable',
          lambdaWad: 10n ** 18n,
          premiumWad: 10n ** 17n,
        }}
      />,
    );
    expect(screen.queryByTestId('trade-disabled-refuse')).toBeNull();
    expect(screen.getByTestId('trade-preview')).toBeEnabled();
    expect(screen.getByTestId('lp-preview')).toBeEnabled();
  });
});
