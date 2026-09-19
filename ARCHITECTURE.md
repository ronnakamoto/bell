# Architecture

## The protocol (paper §4.1)

Three modules and one invariant. The Solidity tree is these modules. The two service workspaces are
not a second copy of the protocol: they are the off-chain fit and the §8 route comparison.

| Module | What it does | Where it lives |
|---|---|---|
| Mint-and-redeem | One unit of collateral mints one Long and one Short; the reverse holds less a protocol fee. Enforces the sum-to-one relation. | `core/Session` |
| Constant-product AMM | Continuous pricing without an external venue. Marginal prices sum to one identically. There is no collateral/Long pair: a buy deposits collateral, mints the pair, and swaps Short for additional Long, so the collateral never leaves the settlement contract. | `core/SessionPool`, `libraries/Amm` |
| Settlement engine | Consumes only **external** prints for the GAP instrument. On-chain price manipulation is irrelevant to settlement. | `core/ReferencePrintBook`, `core/ReferenceRegistry` |
| Fee engine | Term-prorated protocol fee (Eq 17), capped at `0.05 · pL` (Eq 18), and a trading fee that rises into the open (Eq 19–20). | `libraries/FeeModel` |

**Theorem 1 (Solvency).** For any realised gap `G` and any `λ > 0`, the two legs pay
`N · [min(λ|G|, 1) + (1 − min(λ|G|, 1))] = N`, which equals the collateral held. No margin, no
maintenance threshold, no liquidation engine.

The theorem is unconditional in the prints `(C, O)` and therefore says nothing about them.
Settlement factors as

```
world state  →  (C, O)  →  G  →  ΠL
```

Theorem 1 covers only the last two arrows. The first — the map from the world to the pair of prints
— is the entire residual risk of the protocol. It is a procedure, not a mathematical object. Paper
§8 is devoted to it, which is why five settlement *architectures* are compared on cost and why R1
(void at 0.50) is excluded by test: it writes a free butterfly to the protocol's own hedgers.

**R2 is the shipped settlement architecture.** Settle on the first valid print whenever it arrives;
defer when none qualifies. R1 exists in the route registry so the exclusion is re-measurable, and
the on-chain default is off.

**R5 is not an alternative payoff.** Its settlement rule is R2's. What it adds is the bonded
dispute over the *parameter set* — commitment of the fit and its raw inputs before the session, a
staleness bound, an arbiter-only ruling by deterministic re-run, and the trailing-realised fallback
while a challenge is open (paper §7.11, Table 19). A venue choosing between R2 and R5 is choosing
whether to police the publisher, not how a session resolves. Both ship: R2 in `ReferenceRegistry`,
R5 in `PremiumRegistry`.

## Why the fit is off-chain (paper §7.11)

The Gaussian truncated moment has a closed form in `φ` and `Φ`, cheap enough to evaluate on-chain
(paper baseline 37,439 gas; this repository measures 26,911). NIG has no such closed form: a
32-term quadrature is 18× that cost, a 256-term quadrature 146×. Reading a published premium from
storage is ~260× cheaper than the cheapest credible quadrature. G0's implementation lands between
the paper's two figures — 64 nodes for a near-Gaussian window, 111 for the overnight fixture, both
set by the sample's excess kurtosis rather than chosen (F87) — so the gap is a measurement rather
than an extrapolation.

So the oracle publishes the **fitted premium**, not a volatility the contract then transforms. That
is the largest new trust assumption the pricing revision introduces, and it is why `PremiumRegistry`
exists: the publisher's discretion is bounded by a bond and a deterministic re-run, and the worst
case is a session priced on the fallback rather than a session priced wrong.

The launch pricing model (paper §5.3, Table 31 P0): the empirical truncated distribution is the
seed; a fitted fat tail (NIG) is used only where the sample cannot place the cap; Gaussian never
seeds. D1 takes the paper over the brief, which had promoted NIG to production. **All three are now
implemented**, NIG included. It is fitted by method of moments rather than §7.11's maximum
likelihood, because MLE's 2–6% variance understatement on short windows is exactly the regime the
fallback exists for, and it refuses a window whose standardised shape falls outside the family
rather than mis-fitting it (F87).

## The event session (paper §7.10)

The event session is the one session where a per-name empirical quantile cannot be published: 34
observations against 7.2 expected tail draws, which the paper measures as a 13.8% one-signed bias in
`Q` with a 16.4% spread. But the two quantities a quantile conflates separate cleanly. The *shape* is
homogeneous and near-Gaussian — measured excess kurtosis −0.08 ± 0.48 against 13.24 ± 0.06 for the
non-event pool — and is pooled into a single constant `q_C = 2.294`. The *scale* is name-specific and
estimable, because the name's own level is pinned by roughly 2,479 non-event observations and only the
ratio carries event information, so `r = sigma_C / sigma_nonC` is shrunk toward the cross-section with
weight `tau^2 / (tau^2 + SE(r)^2)`.

`lambda_C = floor(1 / (q_C * r* * sigma_nonC))` is therefore the same rule `leverage.ts` already
implements, with the empirical quantile replaced by the parametric one `q_C * sigma_C*`. **G1 has landed
it** in `domain/shrinkage.ts`: all 22 of Table 17's `lambda_C` reproduce exactly from the published
two-decimal `sigma_C*`, all 22 `r*` land within a derived `1.0e-3` bound, and the interval reproduces 21
of 22 with the single miss shown to be inside the published input's own rounding. The cross-sectional
spread is carried unrounded — the column resolves the fourth digit, and the brief's `1.596` is measurably
worse than `1.596142` (F89).

`AnnouncementCalendar` is still declared and still uncalled, and G1 did not need it: the shrinkage is a
cross-sectional rule over published per-name estimates, and nothing in it fetches an announcement date.
The port that *does* need it is ingestion, which is what applies `classify` upstream of the calibrator —
see the note on that port.

## BELL-IV (paper §5.2)

Because `E[min(|G|, c)]` is strictly increasing in `σ` and maps `[0, ∞)` onto `[0, c)`, the pool
price `pL` inverts uniquely into an implied session volatility (Eq 13). The protocol therefore
publishes, continuously and permissionlessly, a closed-session implied-vol term structure — a risk
input for lending haircuts and market-maker quoting, independent of the derivative itself.

The root-find is done in the **truncation ratio** `u = c/σ` rather than in `σ`, and that is what makes
the surface's two guarantees derivable. With `g(u) = E[min(|Z|, u)]` and `λσ = 1/u`, the equation
`λ E[min(|G|, c)] = pL` becomes `g(u)/u = pL` — a function of `u` alone, with the leverage entering
only through the final `σ = 1/(λu)`. Three consequences: the map is a fixed strictly-decreasing
`h : (0, ∞) → (0, 1)`, so the root is unique and independent of the leverage; **`pL ≥ 1` has no
solution at all**, which is the saturation ceiling `λc = 1` restated and is refused rather than
inverted; and the relative error in `u` *is* the relative error in `σ`. The bracket is closed form —
`u ≥ (1 − pL)/√(2/π)` from `h(u) ≥ 1 − 2φ(0)u`, and `u ≤ √(2/π)/pL` from the Mills ratio — so no
search is needed and Newton converges inside it.

**G2 has landed it** in `domain/implied.ts`. The 112 points of the committed `moments.json` are the
corpus: inverting each `premiumWad` recovers the Python reference's `sigmaWad` with a worst relative
error of 3.195e-17 against the paper's M15 bound of 1.16e-13. The accuracy is not a number the
algorithm reaches but the input's information content — the price arrives as a `Wad`, so the root-find
stops at one wei and the bound is `quantum/(pL·|e_h|)`, which the suite checks at every point (worst
0.637 of it). Two published figures do not survive measurement and are recorded rather than smoothed
over: M14's 4.023e-01 is the moment at ratio one half, a derivative along a ray rather than the
fixed-leverage derivative its stated purpose needs, which on the same grid bottoms at 0.0938; and X8's
"unity to within 0.21% while `c/σ ≥ 3`" is 1.027% at `c/σ = 3`, reaching 0.21% at 3.4924 (F91).

BELL-IV is a function of the pool price, so a pool that has not traded reports the old volatility
exactly. The guard is provenance stamping with a freshness bound and a named trailing-realised
fallback (paper G2/T2, Table 31 P1), and it is three decisions rather than a check. The bound is
**inclusive**, because Table 19's rotation period equals the staleness bound. Past it with no fallback
the call **refuses** — Table 19's "the pool refuses to price rather than pricing on a stale fit" — and
returns a reading rather than a boolean, so a caller cannot render a refusal as a number. A reading
carries its provenance as a named union, because `trailing-realised` is a different claim from `pool`.

The web app is the publisher, through a fixture. `loadPublishedIv` looks up a session in an
`IvSource`, runs the row through `publishedVolatility`, and the session page renders the freshness
stamp or omits σ̂ — never invents a number. `impliedVolatility` still has no reader of a live pool
price: `resolveSources` may opt logs and quotes into RPC, and IV stays file-backed in both modes. A
live inversion from the pool is unbuilt — the same position `AnnouncementCalendar` is in, and
recorded for the same reason.

## The service layering

The protocol above is the Solidity. The calibrator and the settlement service are the off-chain
jobs that feed it. Their governing principle is the one the brief tests:

**The domain core is pure, and everything that touches the world is an adapter at the edge.** The
truncated moment, the leverage rule, the session classification and the AMM mathematics are all
computable with no network, no filesystem, no clock and no global state. If you cannot unit-test a
domain function by calling it with literal arguments, it is in the wrong layer.

```
        adapters  ──────►  application  ──────►  domain
     (http, rpc, db)      (use cases)          (pure)
             ▲                                      │
             └────────── implements ────────────────┘
                       (ports are declared in domain)
```

| Layer | Path | May import |
|---|---|---|
| domain | `calibrator/src/domain/` | itself, and `decimal.js` |
| application | `calibrator/src/application/` | domain |
| adapters | `calibrator/src/adapters/` | domain and application |
| domain | `settlement/src/domain/` | itself, `calibrator/src/domain`, and `decimal.js` |
| application | `settlement/src/application/` | domain |
| adapters | `settlement/src/adapters/` | domain and application; calibrator application for the challenge re-fit |
| domain | `indexer/src/domain/` | itself, `calibrator/src/domain`, and `decimal.js` |
| application | `indexer/src/application/` | domain |
| adapters | `indexer/src/adapters/` | domain and application |
| domain | `web/src/domain/` | itself, `indexer/src/domain`, `calibrator/src/domain`, and `decimal.js` — not settlement |
| application | `web/src/application/` | domain |
| adapters | `web/src/adapters/` | domain and application; settlement application and adapters for the challenge view |
| pages | `web/src/app/` | application and adapters (Next.js routes); settlement application and adapters for the challenge view |

**The port is complete and the Python it replaced is gone** (ruling R5; B1 deleted the tree). The
TypeScript paths above are the only paths. Until Phase B a second implementation sat beside each of
them — `calibrator/src/bell_calibrator/{domain,application,adapters}/`, holding the same layer rule —
and it was the oracle the port was verified *against*: never edited to agree with its successor, and
checked byte-for-byte or fixture-by-fixture before anything was removed. A reader looking for the
Python will not find it, and what the verification produced lives in `DESIGN_NOTES.md` rather than in
the tree.

**`decimal.js` is the one permitted domain dependency**, and the reason §7.4 admits it is R5.1: the
rule was always "no dependency that can reach the world", and a pure arithmetic library cannot. It is
an allow-list of one named package rather than a category, so a second package is a finding rather
than a judgement call.

**Nothing in `application/` imports `adapters/`**, which is the enforced direction. Tests still reach
both layers by relative path (`../../src/application/publish.js`) rather than through a package
`exports` map. Settlement now has two challenge composition roots. `settlement/src/cli/verify.ts` is
the CLI (`make challenge-verify`); `web/src/adapters/challenge_verify.ts` is the web view, and pages
may import the same settlement `application` and `adapters` layers. Web domain still does not. The
CLI loads a labelled case and a resolved `CommittedInputStore` (file by default, HTTP when
`BELL_INPUT_STORE_URL` is set), then `refitFromStore` re-runs
`calibrate` on `store.window` — not a stub λ/premium map on the case. The web adapter runs that same
path and maps the result onto a serialisable report view. The calibrator still has no composition
root and no entrypoint — it declares neither `main` nor `bin`, and nothing in the repository executes
that service as a process. The table above remains a rule about *permitted* imports rather than a
description of a fully running system. It was written as "nothing imports `adapters` except the
composition root"; settlement now has those roots, and `application-does-not-import-adapters` still
means a root cannot invert the stack.

**The cross-workspace direction** is settlement reading the calibrator, never the reverse. Domain
still meets domain — `settlement/domain -> calibrator/domain` — because adjudication re-runs a fit
from the calibrator's committed inputs and route outcomes are priced by the calibrator's moment
primitives. The re-fit itself is a second edge: `settlement/adapters -> calibrator/application`
(`calibrate` on a stored window), wired at the challenge-verify root. Settlement `application/`
does not import calibrator application; that is a stated constraint, not an accident of the
adapter existing. The reverse import fails `make check`.

The web is a further consumer: page and adapter may import settlement `application` and `adapters`
for the challenge view. Web domain still does not import settlement, and
`web-domain-takes-only-the-shared-core` is unchanged.

**Those edges resolve through `dist/`, not `src/`.** `@bell/calibrator/domain/*.js` is mapped by the
calibrator's `exports` field onto `./dist/domain/*.js`, so `tsc` and node both read the *compiled*
tree — which is why `ts-build` is a prerequisite of `ts-test` and `ts-check` rather than a
convenience, and why the alternative of a `paths` mapping onto `src/` was rejected: it would check one
thing and execute another. The calibrator exposes `./domain/*.js`, `./domain/families/*.js` (a second
segment the `domain/*.js` glob cannot match), and `./application/*.js` onto `dist/`. Its `adapters/`
layer stays unreachable from outside the package. `application/` is reachable so a settlement
adapter can re-run `calibrate`. Settlement exports `./domain/*.js`, `./application/*.js`, and
`./adapters/*.js` onto `dist/`, so those layers are reachable as a package after `ts-build`. The web
challenge adapter imports them as `@bell/settlement/{application,adapters}`. The verify CLI
composition root still imports settlement layers relatively inside the package.

`dist/` is a build product and gitignored, and **`tsc -b` does not prune the output of a source file
that has been deleted**, so `dist/` can hold a module `src/` no longer contains — reachable through
the very `exports` pattern above. `make check-layout`'s sixth rule fails on exactly that, one-directional
so that a *missing* output stays `tsc`'s business rather than this rule's, and `make clean` is the
remedy. See F82.

## The dependency rule, and the commands that enforce it

The rule was enforced twice until B1, once per language, because `import-linter` reads a
`pyproject.toml` and `dependency-cruiser` does not. With the Python deleted there is one tree and one
tool, and the gate keeps the name it always had — the rule it states did not change.

```
make check-architecture   # `npm run architecture` (dependency-cruiser)
make check-layout         # the structural rules that are not import edges
```

The contracts live in `.dependency-cruiser.cjs`, and there are ten:

- *`calibrator-domain-is-hermetic`* — `calibrator/src/domain` may import itself and `decimal.js` and
  nothing else. An allow-list of one named package rather than a category, which is what R5.1 narrowed
  §7.4 to.
- *`settlement-domain-takes-only-the-shared-core`* — the same, plus `calibrator/src/domain`.
- *`indexer-domain-takes-only-the-shared-core`* — the same, plus `calibrator/src/domain`. The port is
  the point: an indexer that reached `node:fs` from `domain/` would not be an indexer with a seam.
- *`web-domain-takes-only-the-shared-core`* — `web/src/domain` may import itself, `indexer/src/domain`,
  `calibrator/src/domain`, and `decimal.js`. The participant surface reads the catalogue and the
  committed quotes; settlement domain is not on the list. The challenge view's settlement composition
  lives at the page and adapter, not in domain.
- *`application-does-not-import-adapters`* — the high-level policy must not reach a low-level driver.
- *`settlement-application-does-not-import-calibrator-application`* — the re-fit is an adapter;
  settlement application wraps `adjudicate` and must not call `calibrate`.
- *`the-calibrator-never-imports-the-settlement-service`* — the cross-workspace direction.
- *`nothing-imports-the-web`* — the web is a consumer at the edge; a shared module it needs belongs
  in the calibrator or the indexer.
- *`nothing-imports-the-indexer`* — the indexer is a consumer at the edge; a shared module it needs
  belongs in the calibrator. All three spellings, because this rule was written first and fired on
  nothing (F96).
- *`no-circular`* — a cycle is how two layers become one without anybody deciding to merge them.

**The Python had a sixth contract and the ordering is covered without it.** `import-linter` declared a
`layers` contract naming `[adapters, application, domain]` in each workspace. `dependency-cruiser` has
no equivalent, and none is needed: every violation a `layers` contract can catch is `domain ->
application`, `domain -> adapters` or `application -> adapters`, and the domain allow-lists plus
`application-does-not-import-adapters` catch all three — the allow-lists being strictly the stronger
form. This section used to list *"the layer stack — the ordering itself, as a single rule"* among the
contracts. No such rule exists in the file (F85).

**The cross-workspace rules name every spelling of their target**, because a `to.path` pattern matches
what the graph resolved and a package-name specifier sometimes stays unresolved: `@bell/calibrator`
and `@bell/indexer` resolve into `dist/` (F96), and settlement now does the same for the three layers
it exports. The allow-list rules are unaffected, because `pathNot` catches everything not on the
list however it was written, which is why the `domain/` rules were never blind (F85).

`make check-layout` adds the structural rules that are not import edges, and there are seven: no
`utils.ts`/`helpers.ts`/`common.ts`, no source file above 400 lines, tests mirror source, no `require`
with a string, no untracked task marker, `dist/` mirrors `src/`, and a coverage hint only under a
`domain/` tree. The `dist/` rule is the only one that reads a build product rather than a source, and
it is why `check-layout` now depends on `ts-build`: an absent `dist/` passes, so without the
prerequisite the rule examined nothing on a tree that had never been built — and `make check` lists
`check-layout` before the two targets that build. See F82.

**The seven rules read three different scopes, and C0 is why that is written down rather than
assumed.** The Python checker this replaced declared one `WORKSPACES` tuple and read every rule through
it, which made three separate questions look like one. The 400-line rule reads the two `src/` trees
only: the brief says *source*, and extending it to `tools/` would fail on `check_coverage.ts` (604
lines, 205 of them comment) and `gen_constants.ts` (590 lines, 445 of them a row table `prettier`
expands) — a rule whose remedy is deleting an audit tool's reasoning, or splitting a table renderer, is
worse than the length it objects to (F56). The banned-name and marker rules read every TypeScript file
the repository owns, the test trees and `tools/` included, because neither rule is about source. And
the hint rule reads all of them while permitting only `domain/`, which is the shape §7.4's own rule
takes: the per-file 100% rule under `domain/` is the only bar a hint is ever needed for, so the
exceptions are bounded by an allow-list rather than by a list of the files that may carry one (F80,
F86).

The Python half of that gate
walked Python's `ast` to prove `domain/` imported nothing but the standard library; TypeScript cannot
parse Python, so that check was never ported and died with the tree it guarded. `tools/check_layout.ts`
states that in its header rather than leaving it as a silent omission.

`make check-fixtures` is the newest gate and the one three defects argued for: it walks every `.json`
and `.yaml` under `spec/` and fails if any unquoted integer literal does not survive a round trip
through a double. The rule is exact representability rather than a threshold, because a double holds
some integers above 2^53 exactly — a rule written as "above `MAX_SAFE_INTEGER`" would fail on values
that are fine and pass silently over the ones that are not. Until F92 it walked `.json` only, so
`spec/constants.yaml` — the single source — sat outside the guard. See F52, F54 and F92.

`make check-coverage` asserts every coverage rule the brief states. For the contracts: 100% on every
metric for `contracts/src/libraries/`, and at least 95% lines for `src/**`. For each TypeScript
workspace: at least 95% on lines **and** branches, asserted separately rather than pooled, plus 100% on
all four metrics for every file under either `domain/` tree — the analogue of the libraries rule at the
layer R5.1 draws as "no dependency that can reach the world".

For the contracts it parses `forge coverage`'s per-file rows rather than its `Total` row, and the
reason is worth knowing before reading any coverage number in this repository: `Total` sums every
instrumented contract including the test helpers and mocks, so it reports **81.07%** on a source tree
that is at **99.46%**. Both figures are accurate; only one answers the brief.

`tools/check_coverage.ts` applies every rule and exits non-zero on any of them. It was checked against
a known-failing report before being trusted. The per-*file* `domain/` rule is the one that closes what
the per-workspace rule leaves open by construction: `calibrator/src/domain/models.ts` read 78.57% of
its branches inside a workspace reading 91.46%, and an aggregate cannot see that. Five sites are
unreached by construction and carry a `v8 ignore` in the source rather than an exemption list in the
tool — a list would be remote from the code it excuses and would fail open the moment the code moved.
See F80.

Until B1 there was a third rule here: each service workspace at least 95% on `coverage.py`'s combined
line-and-branch measure, run through `pytest-cov`. The Python is deleted, so the rule is unmeasurable,
and a rule that cannot be measured is not asserted. The argument it rested on did not go with it — a
`Protocol` body is a declaration, and a declaration nothing imports is a boundary nobody has checked —
and that argument is now the per-file `domain/` rule.

**The TypeScript thresholds are set, and B0 set them from measurement rather than choosing a number.**
They live in `tools/check_coverage.ts` beside the contracts' two rules and the per-file `domain/` rule,
rather than in `vitest.config.ts`, which cannot express a per-file requirement. `vitest.config.ts`
says so where a reader would look for them.

## The ports

Declared in the domain, implemented in `adapters/`. `calibrator/src/domain/ports.ts`.

| Port | What it abstracts | Why it is a port |
|---|---|---|
| `Keccak` | the hash primitive | `domain/` may not depend on a hash library, so it owns the *preimage layout* — the part that must be identical across languages — and the adapter owns the primitive |
| `GapSource` | where daily bars come from | the gap-data source will change; the domain must not |
| `AnnouncementCalendar` | scheduled announcement dates | *scheduled*, not reported: conditioning on a scheduled release is the entire basis of the event-session calibration |
| `ParameterPublisher` | the off-chain commitment | the trust shift this creates is deliberate and is policed by a bond and a deterministic re-run, not assumed away |
| `ReferencePrintSource` | where reference prints come from | the feed will change; the domain must not. Unordered on purpose, because the selection is total and a source that reordered on a retry would look like a different input set |
| `CommittedInputStore` | where a committed fit's raw inputs are retrieved from (`window` by `inputsHash`; `rowsDigest` derived from that window) | the adjudication re-runs a fit, and a store that could only be asked by session could return a different input set from the one committed |
| `LogSource` | where raw event logs come from | an indexer reads logs, and the way that goes wrong is a domain module that reaches an RPC client, a socket or `node:fs` directly. `LogSource` is the seam; the fold is a pure function of the stream it yields |

The settlement service's route evaluation and adjudication still meet the calibrator through the
shared core: the routes are priced by the calibrator's `moments`, and the adjudication's digest is
the calibrator's `digest`. The challenge-verify re-fit is the exception that is not the shared
core: `refitFromStore` calls `calibrate` in an adapter, from a `CommittedInputStore.window`, and
settlement application never sees that import.

The web composes the same seams at the page edge. `resolveSources` is opt-in RPC: `BELL_RPC_URL`
unset replays the committed log and quote fixtures; set, it is `RpcLogSource` and `RpcQuoteSource`
against the factory, registry and premium addresses. Construction is not a call — a missing companion
address is refused before a socket could open — so `make check` stays hermetic. IV is not on that
switch.

The challenge view is another composition at that edge. `/challenge` lists fixture labels and
`/challenge/[label]` renders the report. `FileChallengeSource` wires settlement's file adapters,
`verifyChallenge`, and `refitFromStore` — the same store re-fit as `make challenge-verify` — and
maps the result onto `ChallengeReportView`. When the report is `slashed`, the page wraps
`ChallengeForm` in `EligibilityGate`; the form previews `buildChallenge` (`collateral.approve` then
`premium.challenge`) from the case identity. Other kinds explain why the intent is disabled. Web
domain holds the view model and the intent builder; it still does not import settlement. No wallet,
no broadcast, no `resolve`. The committed-input store is file-backed by default;
`BELL_INPUT_STORE_URL` opts the CLI and web into `HttpCommittedInputStore`
(`GET {base}/{inputsHash}` → one window JSON). Explicit CLI `--store` forces the file. Construction
does not fetch; a missing URL keeps `make check` hermetic. Challenge **cases** stay file-backed.

BELL-IV is not a new port. It is a pure function of `(λ, pL)` plus a freshness stamp on the pool
price. The fallback when the stamp is stale is the same trailing-realised estimator the premium
publisher already names. The web's `IvSource` feeds that function; it does not invert a live pool.

## The cross-language contract

Two things cross the language boundary, and both are specified once and tested on both sides.

**The WAD encoding.** Solidity `uint256` at 1e18; a `Wad` value object off chain. Neither side passes
a `float` across this boundary — there is no `number` in any TypeScript domain signature, where `Wad`
holds a `bigint` and the type is the double's only representation that is exact at 19 digits. The
Python signatures carried an arbitrary-precision `int` and were held to the same rule; that is what
the `Wad` type inherited.

**The commitment digest.** Paper Appendix B. `calibrator/src/domain/digest.ts` builds the preimage;
`keccak256(abi.encode(...))` builds the same bytes on chain. The fixture is `spec/digest.json`, read by
`contracts/test/differential/Digest.t.sol` and `calibrator/tests/contract/digest.test.ts`.

The pricing primitive is checked the same way against `spec/fixtures/moments.json`: 112 points
computed at 50 significant digits, asserted by `Stat` against a tolerance derived from the on-chain
error function's stated 1.5e-7 bound, and asserted *exactly* by `moments.test.ts` against the committed
values — which is what makes the port a port rather than a re-derivation.

**Fixtures are readable by every consumer or they are not a contract.** Every integer in every fixture
is a JSON string, because a JSON number is exact only where a double is, and three of these fixtures
were found carrying values a JavaScript reader silently rounds (F52, F54). `make check-fixtures`
enforces it.

## Constants

`spec/constants.yaml` is the only place a domain constant is written down. `tools/gen_constants.ts`
generates three files from it: `contracts/src/generated/Constants.sol`,
`calibrator/src/domain/constants.ts` and `spec/fixtures/canonical.json`. Each side gets a generated
module rather than a runtime read, because loading the YAML at runtime would put a filesystem read
inside `domain/`, which the layer rule forbids. `make check-generated` fails if any of them is stale.

**The generator was the last thing in `tools/` written in Python, and byte-identity is how the port was
accepted.** `tools/gen_constants.ts` reproduces `Constants.sol` and `canonical.json` exactly, and until
B1 `make check-generated` ran **both** generators in `--check` mode, so the pair kept asserting that two
independent renderings of one YAML agreed. Neither was edited to agree with the other, because an
oracle adjusted to match its subject proves nothing. The Python is deleted, so there is one rendering
now — and the Solidity banner it used to emit, which named `tools/gen_constants.py` in both because
byte-identity was the test and correcting one side would have destroyed the diff that proved it, names
the tool that actually writes the file. See `DESIGN_NOTES.md` F55 and F72.

`constants.ts` emits every value as a `bigint`: arbitrary precision, where a `number` would be the
IEEE-754 double the domain's whole discipline exists to keep out. `models.ts` imports `WAD` from it
rather than declaring it, which was the one place the port departed from the single-source rule.

## Tests

| Suite | Path | Purpose |
|---|---|---|
| unit | `contracts/test/unit/`, `calibrator/tests/unit/`, `settlement/tests/unit/` | one function, literal inputs |
| fuzz | `contracts/test/fuzz/` | the §10.3 invariants over generated inputs |
| differential | `contracts/test/differential/` | Solidity agrees with the off-chain reference, via a shared fixture |
| contract | `calibrator/tests/contract/` | the same fixtures, from the off-chain side — `*.test.ts` |
| invariant | `contracts/test/invariant/` | the `Session` lifecycle and the pool, over generated call sequences |
| gas | `contracts/test/gas/` | the §13.3 budget, measured as a `gasleft()` delta around a real call |
| adversarial | `contracts/test/adversarial/` | a genuinely malicious collateral token, re-entering from inside `transferFrom` |
| fork | `contracts/test/fork/` | **not yet built** — needs `BELL_RPC_URL`; see F6 |

The adversarial suite is worth a note because it is the only place a *hostile* contract appears. The
malicious token re-enters the session from inside `transferFrom`, armed with an enum of the three
entry points worth attacking, and it records the revert data it receives rather than merely
observing that it was refused. That distinction is the test: a re-entrant call that reverts for any
reason at all would satisfy "it was refused", so the assertion is that the revert data is the
re-entrancy guard's *own* error. It also asserts the guard is secondary — the ordering is what
refuses the call, and the guard is there for the site someone adds later.

## The contract-side seams

The Solidity is layered by *what each file is for*, and the same rule as the off-chain side applies: if
you cannot say in one sentence what a file is for, the seam is in the wrong place.

| Contract | One sentence |
|---|---|
| `libraries/WadMath`, `Stat`, `Amm`, `FeeModel`, `Payoff` | the arithmetic, and nothing else |
| `core/Session` | the lifecycle and the collateral ledger |
| `core/SessionPool` | the claims, the reserves and the liquidity shares |
| `core/SessionFactory`, `ReferencePrintBook`, `ReferenceRegistry` | session creation, print selection, and resolution |
| `pricing/PremiumStore` | **what the protocol remembers about a publisher** |
| `pricing/PremiumRegistry` | **what it does about one** |

The last two are one contract split at the 400-line limit (F43), and the seam is deliberately the
question each half answers rather than the line count. `PremiumStore` holds every `internal` path to
the bond token, so a transfer can only originate in a decision made in `PremiumRegistry`. Both were
also split for the same reason as `Session`/`SessionPool` (F22), and in both cases the split improved
the code rather than merely shortening it.

## The settlement routes

Five routes behind one `SettlementRoute` protocol, in `settlement/src/domain/routes/`. The route is a
Strategy rather than a branch inside one function because the set is open, and because paper Table 22
compares all five on cost — an `if`-chain would make adding a route a change to the settlement path,
which is the last place a change should be.

Each route declares `expected_cost_bp`, `monotone` and `free_option` alongside its behaviour. Those
three are load-bearing for the comparison: a non-monotone payoff admits a strategy that extracts value
from settlement rather than from the gap, and a route that pays on an absent print writes an option to
its own hedgers at no premium. `cost_report()` is the brief's §4.3 item 4, and it reports R3 as
unquotable rather than as zero — a number no name experiences is worse than an absent one.

The comparison is a cost table, not a menu of shipped payoffs. **R2 is what `ReferenceRegistry`
does.** R1 is implemented so the 29.7 bp free-option cost stays re-measurable and stays off. R5 in
this registry reports the challenge state on top of R2's settlement rule (F38); the mechanism it
needs already lives in `PremiumRegistry`.
