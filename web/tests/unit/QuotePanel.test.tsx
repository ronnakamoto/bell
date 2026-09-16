// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { QuotePanel } from '../../src/components/QuotePanel.js';

afterEach(() => {
  cleanup();
});

describe('QuotePanel', () => {
  it('renders refuse without a premium element or decimal price text', () => {
    const { container } = render(<QuotePanel quote={{ verdict: 'Refuse' }} />);
    expect(screen.getByTestId('quote-refuse')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-premium')).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\.\d+/);
  });

  it('renders premium for Usable quotes', () => {
    render(
      <QuotePanel
        quote={{
          verdict: 'Usable',
          lambdaWad: 15_000_000_000_000_000_000n,
          premiumWad: 174_000_000_000_000_000n,
        }}
      />,
    );
    expect(screen.queryByTestId('quote-refuse')).toBeNull();
    expect(screen.getByTestId('quote-premium')).toHaveTextContent('0.174');
  });
});
