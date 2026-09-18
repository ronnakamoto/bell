// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChallengeReport } from '../../src/components/ChallengeReport.js';
import { type ChallengeReportView } from '../../src/domain/challenge.js';

afterEach(() => {
  cleanup();
});

describe('ChallengeReport', () => {
  it('renders upheld with kind, premium delta, and digest — never a slash reason', () => {
    const report: ChallengeReportView = {
      kind: 'upheld',
      premiumDeltaWad: '0',
      digest: '0xabc',
    };
    render(<ChallengeReport report={report} />);
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('upheld');
    expect(screen.getByTestId('challenge-premium-delta')).toHaveTextContent('0');
    expect(screen.getByTestId('challenge-digest')).toHaveTextContent('0xabc');
    expect(screen.queryByTestId('challenge-reason')).toBeNull();
    expect(screen.queryByTestId('challenge-expected')).toBeNull();
    expect(screen.queryByTestId('challenge-computed')).toBeNull();
  });

  it('renders slashed with kind, reason, and digest — never a premium delta', () => {
    const report: ChallengeReportView = {
      kind: 'slashed',
      reason: 'premium outside tolerance',
      digest: '0xdef',
    };
    render(<ChallengeReport report={report} />);
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('slashed');
    expect(screen.getByTestId('challenge-reason')).toHaveTextContent('premium outside tolerance');
    expect(screen.getByTestId('challenge-digest')).toHaveTextContent('0xdef');
    expect(screen.queryByTestId('challenge-premium-delta')).toBeNull();
    expect(screen.queryByTestId('challenge-expected')).toBeNull();
  });

  it('renders inputs-unavailable with kind and reason — never digest or premium', () => {
    const report: ChallengeReportView = {
      kind: 'inputs-unavailable',
      reason: 'committed inputs missing',
    };
    render(<ChallengeReport report={report} />);
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('inputs-unavailable');
    expect(screen.getByTestId('challenge-reason')).toHaveTextContent('committed inputs missing');
    expect(screen.queryByTestId('challenge-digest')).toBeNull();
    expect(screen.queryByTestId('challenge-premium-delta')).toBeNull();
    expect(screen.queryByTestId('challenge-expected')).toBeNull();
  });

  it('renders digest-mismatch with kind, expected, and computed — never a reason', () => {
    const report: ChallengeReportView = {
      kind: 'digest-mismatch',
      expected: '0x111',
      computed: '0x222',
    };
    render(<ChallengeReport report={report} />);
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('digest-mismatch');
    expect(screen.getByTestId('challenge-expected')).toHaveTextContent('0x111');
    expect(screen.getByTestId('challenge-computed')).toHaveTextContent('0x222');
    expect(screen.queryByTestId('challenge-reason')).toBeNull();
    expect(screen.queryByTestId('challenge-digest')).toBeNull();
    expect(screen.queryByTestId('challenge-premium-delta')).toBeNull();
  });
});
