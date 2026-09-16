// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EligibilityGate } from '../../src/components/EligibilityGate.js';
import { ELIGIBILITY_STORAGE_KEY } from '../../src/components/eligibilityStorage.js';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

function renderGate(): void {
  render(
    <EligibilityGate>
      <div data-testid="intent-child" />
    </EligibilityGate>,
  );
}

describe('EligibilityGate', () => {
  it('hides children and shows the disclosure when sessionStorage is empty', () => {
    renderGate();
    const disclosure = screen.getByTestId('eligibility-required');
    expect(disclosure).toBeInTheDocument();
    expect(disclosure).toHaveTextContent(/US person/i);
    expect(disclosure).toHaveTextContent(/ToS reset|terms of service/i);
    expect(screen.queryByTestId('intent-child')).toBeNull();
    expect(screen.getByTestId('eligibility-accept')).toBeDisabled();
  });

  it('keeps accept disabled until both checkboxes are checked', () => {
    renderGate();
    const accept = screen.getByTestId('eligibility-accept');
    fireEvent.click(screen.getByTestId('eligibility-not-us'));
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByTestId('eligibility-tos-reset'));
    expect(accept).toBeEnabled();
    fireEvent.click(screen.getByTestId('eligibility-not-us'));
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByTestId('eligibility-not-us'));
    expect(accept).toBeEnabled();
    fireEvent.click(screen.getByTestId('eligibility-tos-reset'));
    expect(accept).toBeDisabled();
  });

  it('reveals children and writes sessionStorage after both boxes are accepted', () => {
    renderGate();
    fireEvent.click(screen.getByTestId('eligibility-not-us'));
    fireEvent.click(screen.getByTestId('eligibility-tos-reset'));
    fireEvent.click(screen.getByTestId('eligibility-accept'));
    expect(screen.getByTestId('intent-child')).toBeInTheDocument();
    expect(screen.queryByTestId('eligibility-required')).toBeNull();
    expect(sessionStorage.getItem(ELIGIBILITY_STORAGE_KEY)).toBe(
      '{"notUsPerson":true,"tosResetAcknowledged":true}',
    );
  });

  it('shows children when sessionStorage already holds a valid attestation', () => {
    sessionStorage.setItem(
      ELIGIBILITY_STORAGE_KEY,
      '{"notUsPerson":true,"tosResetAcknowledged":true}',
    );
    renderGate();
    expect(screen.getByTestId('intent-child')).toBeInTheDocument();
    expect(screen.queryByTestId('eligibility-required')).toBeNull();
  });

  it('stays gated when sessionStorage holds invalid JSON', () => {
    sessionStorage.setItem(ELIGIBILITY_STORAGE_KEY, '{');
    renderGate();
    expect(screen.getByTestId('eligibility-required')).toBeInTheDocument();
    expect(screen.queryByTestId('intent-child')).toBeNull();
  });

  it('stays gated when sessionStorage holds only one flag', () => {
    sessionStorage.setItem(ELIGIBILITY_STORAGE_KEY, '{"notUsPerson":true}');
    renderGate();
    expect(screen.getByTestId('eligibility-required')).toBeInTheDocument();
    expect(screen.queryByTestId('intent-child')).toBeNull();
  });
});
