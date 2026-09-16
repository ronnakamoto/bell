// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BellIvPanel } from '../../src/components/BellIvPanel.js';

afterEach(() => {
  cleanup();
});

describe('BellIvPanel', () => {
  it('renders omit without a show element or decimal sigma text', () => {
    const { container } = render(
      <BellIvPanel iv={{ kind: 'omit', message: 'Implied volatility is not published.' }} />,
    );
    expect(screen.getByTestId('bell-iv-omit')).toBeInTheDocument();
    expect(screen.queryByTestId('bell-iv-show')).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\.\d+/);
  });

  it('shows sigma, provenance, and age for a published reading', () => {
    render(
      <BellIvPanel
        iv={{
          kind: 'show',
          sigma: '0.2',
          provenance: 'pool',
          ageSessions: '0',
        }}
      />,
    );
    const shown = screen.getByTestId('bell-iv-show');
    expect(shown).toHaveTextContent('0.2');
    expect(shown).toHaveTextContent('pool');
    expect(shown).toHaveTextContent('0');
    expect(screen.queryByTestId('bell-iv-omit')).toBeNull();
  });

  it('labels trailing-realised provenance on the show panel', () => {
    render(
      <BellIvPanel
        iv={{
          kind: 'show',
          sigma: '0.15',
          provenance: 'trailing-realised',
          ageSessions: '13',
        }}
      />,
    );
    const shown = screen.getByTestId('bell-iv-show');
    expect(shown).toHaveTextContent('0.15');
    expect(shown).toHaveTextContent('trailing-realised');
    expect(shown).toHaveTextContent('13');
  });
});
