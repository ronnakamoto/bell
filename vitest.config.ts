import { defineConfig } from 'vitest/config';

/**
 * The test runner, and the coverage measurement.
 *
 * `include` covers all three workspaces, so one command runs everything.
 *
 * **Thresholds are deliberately not set here, and B0 did not change that.** They live in
 * `tools/check_coverage.ts`, beside the Python side's one rule and the contracts' two, for a reason
 * that outlived the port being incomplete: three of the four TypeScript rules are per-*file* rather
 * than per-run, and vitest's own `thresholds` block cannot express "every file under `domain/` is
 * perfect on all four metrics". Keeping them together also means one place to change a bar, rather
 * than two numbers that have to be kept in agreement.
 *
 * `exclude` names the generated `constants.ts`: it is emitted from `spec/constants.yaml`, so its
 * coverage would measure the generator rather than the domain, and its freshness is checked
 * separately by `check-generated`.
 */
export default defineConfig({
  test: {
    include: [
      'calibrator/tests/**/*.test.ts',
      'settlement/tests/**/*.test.ts',
      'indexer/tests/**/*.test.ts',
      'web/tests/**/*.test.ts',
      'web/tests/**/*.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'calibrator/src/**/*.ts',
        'settlement/src/**/*.ts',
        'indexer/src/**/*.ts',
        'web/src/**/*.ts',
        'web/src/**/*.tsx',
      ],
      exclude: [
        // Generated from `spec/constants.yaml`; its freshness is checked separately.
        'calibrator/src/domain/constants.ts',
        '**/*.d.ts',
      ],
      reporter: ['text', 'json-summary'],
    },
  },
});
