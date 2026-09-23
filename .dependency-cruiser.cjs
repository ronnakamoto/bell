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
 *
 * **`dist` is the second spelling, and it was invisible (F96).** Each workspace's `package.json` maps
 * its `exports` onto `./dist/…`, so a cross-workspace specifier does not stay bare — it *resolves*,
 * to the target's build output. The graph therefore contains `indexer/dist/domain/log.js` where every
 * rule in this file was written about `indexer/src`. The first configuration excluded `dist`, which
 * deletes the edge along with the module, so a rule whose `to.path` names a workspace could never fire
 * on the one spelling anyone writes; the second kept the edges without widening the patterns, and the
 * `pathNot` allow-lists then fired on *permitted* edges. The resolution is to stop excluding `dist`
 * and stop following into it — `doNotFollow` keeps the edge and declines to descend — and to write
 * every layer pattern against both spellings, which `layer` and `layers` below do once.
 *
 * Three rules were probed in four spellings to establish that, and the probe is recorded in
 * `DESIGN_NOTES.md` F96 rather than described here.
 *
 * The `(src|dist)` alternation is written out at each site rather than produced by a helper: this is
 * a `.cjs` file, so a TypeScript return annotation is a syntax error and the lint rule that requires
 * one cannot be satisfied. Six repetitions of a two-word pattern are cheaper than a lint exemption.
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
      to: { pathNot: [`^calibrator/(src|dist)/domain`, 'node_modules/decimal\\.js'] },
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
        pathNot: [
          `^settlement/(src|dist)/domain`,
          `^calibrator/(src|dist)/domain`,
          'node_modules/decimal\\.js',
        ],
      },
    },
    {
      name: 'web-domain-takes-only-the-shared-core',
      comment:
        'web/src/domain may import itself, the shared calibrator domain, the indexer domain, and ' +
        'decimal.js — nothing else. The web reads the catalogue the indexer folds and the quotes ' +
        'the calibrator publishes; those are the only permitted cross-workspace edges into domain/. ' +
        'Settlement domain is not on the list: the participant surface does not adjudicate routes.',
      severity: 'error',
      from: { path: '^web/src/domain' },
      to: {
        pathNot: [
          `^web/(src|dist)/domain`,
          `^indexer/(src|dist)/domain`,
          `^calibrator/(src|dist)/domain`,
          'node_modules/decimal\\.js',
        ],
      },
    },
    {
      name: 'indexer-domain-takes-only-the-shared-core',
      comment:
        'indexer/src/domain may import itself, the shared calibrator domain, and decimal.js -- ' +
        'nothing else. **The port is the point here rather than a formality**: an indexer reads ' +
        'logs, and the way that goes wrong is a domain module that reaches an RPC client, a socket ' +
        'or `node:fs` directly. `LogSource` is the seam, and this rule is what makes it one. ' +
        'decimal.js is on the list for the same reason it is everywhere else; nothing in this ' +
        'workspace uses it yet, and the allow-list is one entry long on purpose.',
      severity: 'error',
      from: { path: '^indexer/src/domain' },
      to: {
        pathNot: [
          `^indexer/(src|dist)/domain`,
          `^calibrator/(src|dist)/domain`,
          'node_modules/decimal\\.js',
        ],
      },
    },
    {
      name: 'application-does-not-import-adapters',
      comment:
        'The high-level policy must not reach a low-level driver. THREE spellings now, and the ' +
        'third is the one F96 added: a *resolved* cross-workspace specifier lands in `dist/`, so ' +
        'the `@bell/…/adapters` pattern alone would have missed `../adapters/x.js` in the other ' +
        'workspace even though the edge is right there in the graph. The bare-specifier pattern ' +
        'guards the spelling that resolves into `dist/` — the calibrator and the indexer now ' +
        '`export` an `adapters` path (F112) — and the rule names a *target*, not a way of writing ' +
        'it, so a future workspace that adds the path is covered without a rule change.',
      severity: 'error',
      from: { path: '^(calibrator|settlement|indexer|web)/src/application' },
      to: {
        path: [
          '^@bell/(calibrator|settlement|indexer|web)/adapters',
          '^(calibrator|settlement|indexer|web)/src/adapters',
          '^(calibrator|settlement|indexer|web)/dist/adapters',
        ],
      },
    },
    {
      name: 'settlement-application-does-not-import-calibrator-application',
      comment:
        'Settlement application wraps adjudicate and must not reach calibrate. The re-fit is an ' +
        'adapter concern: `refitFromStore` imports `@bell/calibrator/application`, and the CLI ' +
        'wires it. THREE SPELLINGS, for the reason F96 records: the specifier resolves into ' +
        '`dist/` once the calibrator exports `application/`, so a bare-specifier pattern alone ' +
        'would miss the edge the graph actually contains.',
      severity: 'error',
      from: { path: '^settlement/src/application' },
      to: {
        path: [
          '^@bell/calibrator/application',
          '^calibrator/src/application',
          '^calibrator/dist/application',
        ],
      },
    },
    {
      name: 'the-calibrator-never-imports-the-settlement-service',
      comment:
        'The services share a domain core, and the direction is one-way. The settlement service ' +
        'may read bell-calibrator/domain; the calibrator may not reach back. ' +
        'TWO SPELLINGS, and the second was found by probing rather than by reading (F85): a ' +
        'package-name specifier that does not resolve stays BARE in the graph, so `to.path` sees ' +
        '`@bell/settlement/domain/x.js` and never the path it would resolve to. Until B3 this rule ' +
        'named only `^settlement/src`, which matches a relative import and nothing else -- and a ' +
        'relative import is not how this repository crosses a package boundary. ' +
        '**`@bell/settlement` is the one workspace with no `exports` map, which is why this rule ' +
        'fired while `nothing-imports-the-indexer` did not (F96)** -- and why both now name all ' +
        'three spellings rather than relying on that accident.',
      severity: 'error',
      from: { path: '^calibrator/src' },
      to: {
        path: ['^@bell/settlement', '^settlement/src', '^settlement/dist'],
      },
    },
    {
      name: 'nothing-imports-the-web',
      comment:
        'The web is a consumer at the edge: it reads the other workspaces and nothing reads it. ' +
        'A shared module the web needs belongs in the calibrator or the indexer — so an import edge ' +
        'pointing *into* the web from a service is either a misplaced module or a cycle in the making.',
      severity: 'error',
      from: { path: '^(calibrator|settlement|indexer)/src' },
      to: {
        path: ['^@bell/web', '^web/src', '^web/dist'],
      },
    },
    {
      name: 'nothing-imports-the-indexer',
      comment:
        'The indexer is a consumer at the edge: it reads the other workspaces and nothing reads it. ' +
        'A shared domain module that the indexer happened to need belongs in the calibrator, which ' +
        'is where the shared core already lives -- so an import edge pointing *into* the indexer is ' +
        'either a misplaced module or a cycle in the making, and both should be moved rather than ' +
        'allowed. All three spellings, for the reason F96 records: this rule was written first and ' +
        'fired on nothing, because the indexer *does* `export` a `domain/` path, so the specifier ' +
        'resolved into `dist/` and the edge was deleted before any pattern could see it.',
      severity: 'error',
      from: { path: '^(calibrator|settlement)/src' },
      to: {
        path: ['^@bell/indexer', '^indexer/src', '^indexer/dist'],
      },
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
    //
    // **`dist` is here rather than in `exclude`, and that is F96's fix.** `doNotFollow` keeps a
    // dependency edge and declines to descend into it; `exclude` removes the module from the graph
    // entirely, which removes the *edge* with it. Every cross-workspace specifier resolves through
    // the target's `exports` map into `dist/`, so excluding `dist` deleted exactly the edges the
    // rules about cross-workspace imports exist to see. Not descending is all that is wanted here:
    // build output is not source, and nothing in it needs a rule applied.
    doNotFollow: { path: '(node_modules|dist)' },
    // `node_modules` is deliberately **not** in this exclude list, and the distinction is the whole
    // reason the gate works. `doNotFollow` keeps a dependency edge and declines to descend into it;
    // `exclude` removes the module from the graph entirely, which removes the *edge* with it. With
    // `node_modules` excluded, a domain file importing `@noble/hashes` produced no edge and
    // therefore no violation — the gate passed while enforcing nothing, for exactly the case it
    // exists to catch. `node:fs` was caught throughout, because a core module does not live under
    // `node_modules`, which is what made the failure look like success. `dist` was in this list for
    // the same reason and with the same effect; see F96.
    exclude: { path: '(^|/)(coverage)/' },
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
