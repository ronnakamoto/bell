// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/application/catalogue.js', () => ({
  loadCatalogue: vi.fn(() => Promise.resolve({ sessions: [], names: [] })),
}));

import HomePage from '../../src/app/page.js';

afterEach(() => {
  cleanup();
});

describe('HomePage with an empty catalogue', () => {
  it('states that no sessions were found', async () => {
    const page = await HomePage();
    render(page);
    expect(screen.getByText('No sessions in the catalogue.')).toBeInTheDocument();
  });
});
