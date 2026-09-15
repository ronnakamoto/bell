import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config, ESLint 10.
 *
 * The rule set is the TypeScript analogue of the Python side's `ruff` selection, plus one rule that
 * has no Python equivalent and matters more than the rest of them: **`domain/` may not use `Math`.**
 *
 * The domain's whole discipline is that a monetary or statistical quantity is never an IEEE-754
 * double. In Python that was enforced by the absence of `float` in any domain signature and by
 * `mypy --strict` with `disallow_any_explicit`. In TypeScript `number` *is* the double, and it cannot
 * be banned outright because it is also the type of an array index and a loop counter. So the check
 * is placed on the thing that makes a double dangerous rather than on the type: `Math` and the
 * string-to-number parsers are how a value silently becomes a double, and `domain/` may not reach for
 * either. A `Decimal` from `decimal.js` is the only numeric type the domain computes with.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      // Reconnaissance scratch. Gitignored, and the tracker's convention is that it is not
      // repository content -- but git is the only thing that enforced that, and eslint's project
      // service fails outright on a `.ts` file it cannot find in a tsconfig. A scratch probe here
      // broke `make check` from a file that was never committed.
      '.recon/**',
      // Solidity, and the vendored Forge standard library.
      'contracts/**',
      // Generated from `spec/`; checked for freshness by `make check-generated`.
      'calibrator/src/domain/constants.ts',
      'spec/**',
      'tools/**/*.generated.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Annotations on every signature, which is `ruff`'s `ANN` on the Python side. An inferred
      // return type on a domain function is a contract nobody wrote down.
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: false, allowTypedFunctionExpressions: true },
      ],
      // `disallow_any_explicit`. `strictTypeChecked` already forbids `any` in most positions; this
      // makes it unconditional outside the test suite.
      '@typescript-eslint/no-explicit-any': 'error',
      // The non-null assertion is how a numeric codebase loses a branch it needed to handle.
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Import order and type-only imports, which is `ruff`'s `I`.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // `ruff`'s `T20`: no print statements **in the services**. A service logs through its adapter
      // or not at all, because a stray `console.log` in a library is a side effect nobody declared.
      // Scoped to `src/` rather than global: a script under `tools/` exists to print, and forbidding
      // it there would be a rule that its own subject matter cannot satisfy.
      // `no-console` is set in the `src` block below.
      // `ruff`'s `B` and `SIM`, in the forms that matter here.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      // A `switch` over a union must be exhaustive, which is the TypeScript form of the paper's
      // "no default fall-through" requirement for the settlement branch set.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false },
      ],
      // An intentionally unused *parameter* is marked with a leading underscore.
      //
      // This is parity with the Python side rather than a relaxation of it: `ruff`'s `ARG` is not in
      // that workspace's selection, so an unused function argument is not flagged there at all, and
      // `settlement/tests/unit/test_ports.py` has two. The port needs the convention for a reason the
      // Python does not have to state — a port's signature is imposed by the interface it satisfies,
      // so the *smallest conforming object* necessarily ignores its arguments, and renaming them to
      // something the body reads would be a lie about what the stub is.
      //
      // The gate still catches the case it exists for: a parameter renamed in a signature but not in
      // the body is only ignored if the author prefixed it, which is a deliberate act. `varsIgnorePattern`
      // is deliberately **not** set — a local that nothing reads is a defect whatever it is called,
      // and only parameters have a reason to be unused.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    // The services: no console output. A library that prints is a library with an undeclared side
    // effect, and the adapters are where output belongs.
    files: ['calibrator/src/**/*.ts', 'settlement/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },

  {
    // The domain purity rules: mechanical statements of a design rule that is otherwise only a
    // convention.
    //
    // **What they cover, and what they do not.** They ban `Math`, `Number.parseFloat`,
    // `Number.parseInt` and the bare `parseFloat`/`parseInt` — four spellings of "a string silently
    // became a double". They do **not** ban `Number(x)` or `Decimal.toNumber()`, and both are used in
    // `domain/` today: `dates.ts` converts a year, a month, a day and a day count; `digest.ts`
    // converts a masked byte; `leverage.ts` and `families/base.ts` convert a quantile rank, which is
    // an array index. Every one of those is an exact small integer, so no current call site is wrong
    // — but the rule is narrower than the paragraph above the file used to claim, and
    // DESIGN_NOTES.md F77 records the gap rather than leaving a comment to overstate the enforcement.
    files: ['calibrator/src/domain/**/*.ts', 'settlement/src/domain/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          message:
            'domain/ may not use Math: it operates on IEEE-754 doubles. Use decimal.js, which is the only numeric type the domain computes with.',
        },
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'domain/ may not parse a string into a double. Use Decimal.',
        },
        {
          // Listed because its sibling above is. Bare `parseInt` is banned by `no-restricted-globals`
          // and `Number.parseFloat` is banned here, so omitting this one spelling was an oversight
          // rather than a judgement — and it was not hypothetical: `bytesFromHex` used it until F77.
          object: 'Number',
          property: 'parseInt',
          message: 'domain/ may not parse a string into a double. Use Decimal.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'domain/ may not produce a double. Use Decimal.' },
        { name: 'parseInt', message: 'domain/ may not produce a double. Use Decimal.' },
      ],
    },
  },

  {
    // Tests may use `any` for a fixture decode and may assert with non-null where the assertion
    // itself is the thing under test, which mirrors the Python side relaxing `disallow_any_explicit`
    // for `tests.*` only. `src` keeps every rule.
    files: ['**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    // Config files are not part of any workspace's `tsconfig`, so typed linting cannot apply to them.
    files: ['**/*.config.{js,ts}', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
