/**
 * The §5.3 dependency rule, mechanically — the TypeScript counterpart of the Python side's
 * `import-linter` contracts, and the reason the narrowing of §7.4 is checkable rather than asserted.
 *
 * §7.4 said `domain/` may take no dependency at all. Ruling R5.1 narrows that to *no dependency that
 * can reach the world*, and admits exactly one exception: `decimal.js`, a pure arithmetic library.
 * That narrowing is only honest if something enforces it, which is what the first rule below does —
 * an allow-list of one named package, not a category called "pure libraries".
 *
 * **A `to.path` pattern matches what the graph resolved, and a package-name specifier resolves to
 * nothing.** `@bell/settlement/domain/routes/settle.js` stays a bare specifier in the graph, so a rule
 * written as `^settlement/src` sees a relative import and only a relative import — and a relative
 * import is not how this repository crosses a package boundary. Two rules below therefore name both
 * spellings. The allow-list rules are unaffected, because `pathNot` catches everything not on the list
 * however it was written, which is why the two `domain/` rules were never blind (F85).
 */
module.exports = {
  forbidden: [
    {
      name: 'calibrator-domain-is-hermetic',
      comment:
        'calibrator/src/domain may import only itself and decimal.js. An ALLOW-list, not a list of ' +
        'forbidden dependency types — and that distinction was found the hard way. The first ' +
        'version of this rule named the npm dependency types and therefore admitted `node:fs`, ' +
        'which dependency-cruiser classifies as `core`. The probe that caught it was a two-line ' +
        'file importing node:fs; without it the gate would have passed silently while enforcing ' +
        'nothing. A deny-list of categories fails open on the category nobody thought of.',
      severity: 'error',
      from: { path: '^calibrator/src/domain' },
      to: { pathNot: ['^calibrator/src/domain', 'node_modules/decimal\\.js'] },
    },
    {
      name: 'settlement-domain-takes-only-the-shared-core',
      comment:
        'settlement/src/domain may import itself, the shared calibrator domain, and decimal.js — ' +
        'nothing else. The shared core is the one permitted cross-workspace edge, and it is ' +
        'one-way: the rule below forbids the reverse.',
      severity: 'error',
      from: { path: '^settlement/src/domain' },
      to: {
        pathNot: ['^settlement/src/domain', '^calibrator/src/domain', 'node_modules/decimal\\.js'],
      },
    },
    {
      name: 'application-does-not-import-adapters',
      comment:
        'The high-level policy must not reach a low-level driver. Two spellings for the same reason ' +
        'as the rule below: a package-name specifier is left unresolved, so the relative form alone ' +
        'would not name the target. `@bell/calibrator/adapters/*` is unreachable at run time -- the ' +
        "calibrator's `exports` map exposes `./domain/*.js` and nothing else -- and the settlement " +
        'has no `adapters/` layer at all, so the second pattern guards a spelling that does not ' +
        'resolve today. It is here because the rule names a *target*, not a way of writing it.',
      severity: 'error',
      from: { path: '^(calibrator|settlement)/src/application' },
      to: {
        path: ['^@bell/(calibrator|settlement)/adapters', '^(calibrator|settlement)/src/adapters'],
      },
    },
    {
      name: 'the-calibrator-never-imports-the-settlement-service',
      comment:
        'The two services share a domain core, and the direction is one-way. The settlement service ' +
        'may read bell-calibrator/domain; the calibrator may not reach back. ' +
        'TWO SPELLINGS, and the second was found by probing rather than by reading (F85): a ' +
        'package-name specifier stays UNRESOLVED in the graph, so `to.path` sees the bare ' +
        '`@bell/settlement/domain/x.js` and never the path it would resolve to. Until B3 this rule ' +
        'named only `^settlement/src`, which matches a relative import and nothing else -- and a ' +
        'relative import is not how this repository crosses a package boundary. The rule passed ' +
        'every check while missing the only spelling anyone would write.',
      severity: 'error',
      from: { path: '^calibrator/src' },
      to: { path: ['^@bell/settlement', '^settlement/src'] },
    },
    {
      name: 'no-circular',
      comment:
        'A cycle in a numeric or routing module is how two layers become one layer without anybody ' +
        'deciding to merge them.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],

  options: {
    // `.js` specifiers resolve to `.ts` sources under NodeNext, which is what the compiler does and
    // therefore what this check has to do as well.
    tsPreCompilationDeps: true,
    // **No `tsConfig` option, and its absence is deliberate.** Pointing it at `tsconfig.base.json`
    // — which is an `extends`-only base with no `include` — made dependency-cruiser extract *no*
    // dependencies at all from a domain file: an npm import produced zero edges and therefore zero
    // violations, so the gate passed while enforcing nothing. Found by probing the gate with a
    // two-line file rather than by reading it. Its own resolver handles the `.js` → `.ts` mapping
    // correctly, so the option is not needed for that either.
    doNotFollow: { path: 'node_modules' },
    // `node_modules` is deliberately **not** in this exclude list, and the distinction is the whole
    // reason the gate works. `doNotFollow` keeps a dependency edge and declines to descend into it;
    // `exclude` removes the module from the graph entirely, which removes the *edge* with it. With
    // `node_modules` excluded, a domain file importing `@noble/hashes` produced no edge and
    // therefore no violation — the gate passed while enforcing nothing, for exactly the case it
    // exists to catch. `node:fs` was caught throughout, because a core module does not live under
    // `node_modules`, which is what made the failure look like success.
    exclude: { path: '(^|/)(dist|coverage)/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
