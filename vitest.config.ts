import { defineConfig } from 'vitest/config';

/**
 * The test runner, and the coverage measurement.
 *
 * `include` covers both workspaces, so one command runs everything — the same shape as the Python
 * side's `make test`. Coverage thresholds are deliberately **not** set here yet: the TypeScript port
 * is in progress, and a threshold that fails on an incomplete port teaches nobody anything. They are
 * asserted by `tools/check_coverage.ts`, which is where the Python side's rules live too, and they go
 * in once the port is complete rather than being written at a value that happens to pass today.
 */
export default defineConfig({
  test: {
    include: ['calibrator/tests/**/*.test.ts', 'settlement/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['calibrator/src/**/*.ts', 'settlement/src/**/*.ts'],
      exclude: [
        // Generated from `spec/constants.yaml`; its freshness is checked separately.
        'calibrator/src/domain/constants.ts',
        '**/*.d.ts',
      ],
      reporter: ['text', 'json-summary'],
    },
  },
});
