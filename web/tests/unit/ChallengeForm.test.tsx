// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChallengeForm } from '../../src/components/ChallengeForm.js';

afterEach(() => {
  cleanup();
});

const NAME_ID = '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';

describe('ChallengeForm', () => {
  it('previews challenge steps with no amount inputs', () => {
    render(<ChallengeForm nameId={NAME_ID} forSession="12345" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByTestId('challenge-preview'));
    expect(screen.getByText('Approve premium registry to spend collateral')).toBeInTheDocument();
    expect(screen.getByText('Challenge committed premium')).toBeInTheDocument();
  });
});
