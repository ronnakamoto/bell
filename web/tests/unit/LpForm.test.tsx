// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LpForm } from '../../src/components/LpForm.js';

afterEach(() => {
  cleanup();
});

describe('LpForm', () => {
  it('starts with empty amount inputs', () => {
    render(<LpForm sessionAddress="0x1111111111111111111111111111111111111111" />);
    expect(screen.getByLabelText('Mint amount')).toHaveValue('');
    expect(screen.getByLabelText('Long in')).toHaveValue('');
    expect(screen.getByLabelText('Short in')).toHaveValue('');
  });

  it('previews mint-then-seed steps for integer amounts', () => {
    render(<LpForm sessionAddress="0x1111111111111111111111111111111111111111" />);
    fireEvent.change(screen.getByLabelText('Mint amount'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Long in'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Short in'), { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('lp-preview'));
    expect(screen.getByText('Mint long and short claim pair')).toBeInTheDocument();
    expect(screen.getByText('Approve session to spend long claims')).toBeInTheDocument();
    expect(screen.getByText('Approve session to spend short claims')).toBeInTheDocument();
    expect(screen.getByText('Seed liquidity pool')).toBeInTheDocument();
  });

  it('shows an error for empty amounts', () => {
    render(<LpForm sessionAddress="0x1111111111111111111111111111111111111111" />);
    fireEvent.click(screen.getByTestId('lp-preview'));
    expect(screen.getByText(/integer|digits|empty/i)).toBeInTheDocument();
    expect(screen.queryByText('Seed liquidity pool')).toBeNull();
  });

  it('shows the domain error when an amount is zero', () => {
    render(<LpForm sessionAddress="0x1111111111111111111111111111111111111111" />);
    fireEvent.change(screen.getByLabelText('Mint amount'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Long in'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Short in'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('lp-preview'));
    expect(screen.getByText(/must be positive/i)).toBeInTheDocument();
    expect(screen.queryByText('Seed liquidity pool')).toBeNull();
  });
});
