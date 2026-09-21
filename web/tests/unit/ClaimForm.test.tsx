// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaimForm } from '../../src/components/ClaimForm.js';
import { SessionSettlementIntents } from '../../src/components/SessionSettlementIntents.js';
import { WithdrawPoolForm } from '../../src/components/WithdrawPoolForm.js';

afterEach(() => {
  cleanup();
});

describe('ClaimForm', () => {
  it('previews claim steps with no amount inputs', () => {
    render(<ClaimForm sessionAddress="0x1111111111111111111111111111111111111111" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByTestId('claim-preview'));
    expect(screen.getByText('Claim settlement payout')).toBeInTheDocument();
  });
});

describe('WithdrawPoolForm', () => {
  it('previews withdrawPool steps with no amount inputs', () => {
    render(<WithdrawPoolForm sessionAddress="0x1111111111111111111111111111111111111111" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByTestId('withdraw-pool-preview'));
    expect(screen.getByText('Withdraw liquidity from pool')).toBeInTheDocument();
  });
});

describe('SessionSettlementIntents', () => {
  it('renders claim and withdrawPool forms when the session is settled', () => {
    render(
      <SessionSettlementIntents
        settled={true}
        sessionAddress="0x1111111111111111111111111111111111111111"
      />,
    );
    expect(screen.queryByTestId('claim-disabled-not-settled')).toBeNull();
    expect(screen.getByTestId('claim-preview')).toBeEnabled();
    expect(screen.getByTestId('withdraw-pool-preview')).toBeEnabled();
  });

  it('hides claim and withdrawPool forms when the session is not settled', () => {
    render(
      <SessionSettlementIntents
        settled={false}
        sessionAddress="0x1111111111111111111111111111111111111111"
      />,
    );
    expect(screen.getByTestId('claim-disabled-not-settled')).toBeInTheDocument();
    expect(screen.queryByTestId('claim-preview')).toBeNull();
    expect(screen.queryByTestId('withdraw-pool-preview')).toBeNull();
  });
});
