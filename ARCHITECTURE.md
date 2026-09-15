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
storage is ~260× cheaper than the cheapest credible quadrature.

So the oracle publishes the **fitted premium**, not a volatility the contract then transforms. That
is the largest new trust assumption the pricing revision introduces, and it is why `PremiumRegistry`
exists: the publisher's discretion is bounded by a bond and a deterministic re-run, and the worst
case is a session priced on the fallback rather than a session priced wrong.

The launch pricing model (paper §5.3, Table 31 P0): the empirical truncated distribution is the
seed; a fitted fat tail (NIG) is used only where the sample cannot place the cap; Gaussian never
seeds. D1 takes the paper over the brief, which had promoted NIG to production.

## BELL-IV (paper §5.2)

Because `E[min(|G|, c)]` is strictly increasing in `σ` and maps `[0, ∞)` onto `[0, c)`, the pool
price `pL` inverts uniquely into an implied session volatility (Eq 13). The protocol therefore
publishes, continuously and permissionlessly, a closed-session implied-vol term structure — a risk
input for lending haircuts and market-maker quoting, independent of the derivative itself.

BELL-IV is a function of the pool price, so a pool that has not traded reports the old volatility
exactly. The guard is provenance stamping with a freshness bound and a named trailing-realised
fallback (paper G2/T2, Table 31 P1). **This surface is not built yet.** The truncated moment is
on-chain; the inversion and the freshness stamp are not. See `.workbuddy-ai/TODO.md` Phase G.

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
| adapters | `settlement/src/adapters/` | domain and application |

**The port is in progress** (ruling R5), so both languages are present and both are checked. The
TypeScript paths above are the target; the Python paths beside them
(`calibrator/src/bell_calibrator/{domain,application,adapters}/`) are the implementation being ported
*from*, and they hold the same layer rule. A reader who sees two files named `digest` — one `.py`, one
`.ts` — is looking at exactly that: the source of the port and its result, with the TypeScript verified
against the committed fixtures rather than against the Python.

**`decimal.js` is the one permitted domain dependency**, and the reason §7.4 admits it is R5.1: the
rule was always "no dependency that can reach the world", and a pure arithmetic library cannot. It is
an allow-list of one named package rather than a category, so a second package is a finding rather
than a judgement call.

Nothing imports `adapters` except the composition root.

**The one cross-workspace edge** is `settlement/domain -> calibrator/domain`, and it exists because
the settlement service's adjudication re-runs a fit from the calibrator's committed inputs, and its
route outcomes are priced by the calibrator's moment primitives. The direction is enforced in both
languages, so the reverse import fails `make check` whichever language it is written in.

## The dependency rule, and the commands that enforce it

The rule is enforced twice because the languages need different tools for it. Both run under
`make check`.

```
make check-architecture   # Python: lint-imports in each workspace
make ts-check             # TypeScript: includes `npm run architecture` (dependency-cruiser)
```

`make check` runs both. Copying only the Python target is the retired half of the stack.

The Python contracts live in each workspace's `pyproject.toml` under `[tool.importlinter]`:

- *domain depends on nothing but the standard library and itself* — forbids the sibling layers and an
  explicit list of third-party packages, so "no dependency may be added to domain" is checked rather
  than trusted. `include_external_packages = true` is what makes the external half work.
- *application does not import adapters* — the high-level policy must not reach a low-level driver.
- *the layer stack* — the ordering itself, as a single contract.
- *the calibrator never imports the settlement service* — the cross-workspace direction.

The TypeScript counterparts are in `.dependency-cruiser.cjs`, including the same named rule
*"the calibrator never imports the settlement service"*, and `decimal.js` as the only permitted
domain package.

`make check-layout` adds the structural rules that are not import edges: no `utils.py`/`helpers.py`/
`common.py`, no source file above 400 lines, tests mirror source, no `require` with a string, no
untracked `TODO`. It walks every Python workspace, so a new one is covered by adding a row to
`WORKSPACES` in `tools/check_layout.py`. It has not yet been extended to the TypeScript tree, which is
an open item rather than an oversight: the 400-line rule and the banned-module-name rule both apply
there and nothing enforces them yet.

`make check-fixtures` is the newest gate and the one three defects argued for: it walks every `.json`
under `spec/` and fails if any integer literal does not survive a round trip through a double. The rule
is exact representability rather than a threshold, because a double holds some integers above 2^53
exactly — a rule written as "above `MAX_SAFE_INTEGER`" would fail on values that are fine and pass
silently over the ones that are not. See F52 and F54.

`make check-coverage` asserts every coverage rule the brief states. For the contracts: 100% on every
metric for `contracts/src/libraries/`, and at least 95% lines for `src/**`. For the services: at
least 95% each on `coverage.py`'s combined line-and-branch measure, run through `pytest-cov` so the
measurement is the one `make coverage` prints rather than a second opinion that could disagree with it.

For the contracts it parses `forge coverage`'s per-file rows rather than its `Total` row, and the
reason is worth knowing before reading any coverage number in this repository: `Total` sums every
instrumented contract including the test helpers and mocks, so it reports **81.07%** on a source tree
that is at **99.46%**. Both figures are accurate; only one answers the brief.

Two exclusions are configured in each workspace's `pyproject.toml`, and both are declarations rather
than behaviour: `...` (a `Protocol` method body, which is never instantiated or called) and
`if TYPE_CHECKING:`. Counting a declaration as behaviour makes every ports module read as uncovered
and hides the modules that are not.

`tools/check_coverage.py` applies all three rules and exits non-zero on any of them. It was checked
against a known-failing report before being trusted.

**The TypeScript coverage thresholds are deliberately not set yet.** The port is incomplete, and a
threshold written now would either be a number chosen to pass on a partial tree — which teaches
nothing and hides the rest of the port — or a number that fails continuously. They go in when the port
is complete, and `vitest.config.ts` says so where a reader would look for them.

## The ports

Declared in the domain, implemented in `adapters/`. TypeScript: `calibrator/src/domain/ports.ts`.
Python (being ported from): `bell_calibrator/domain/ports.py`.

| Port | What it abstracts | Why it is a port |
|---|---|---|
| `Keccak` | the hash primitive | `domain/` may not depend on a hash library, so it owns the *preimage layout* — the part that must be identical across languages — and the adapter owns the primitive |
| `GapSource` | where daily bars come from | the gap-data source will change; the domain must not |
| `AnnouncementCalendar` | scheduled announcement dates | *scheduled*, not reported: conditioning on a scheduled release is the entire basis of the event-session calibration |
| `ParameterPublisher` | the off-chain commitment | the trust shift this creates is deliberate and is policed by a bond and a deterministic re-run, not assumed away |
| `ReferencePrintSource` | where reference prints come from | the feed will change; the domain must not. Unordered on purpose, because the selection is total and a source that reordered on a retry would look like a different input set |
| `CommittedInputStore` | where a committed fit's raw inputs are retrieved from | the adjudication re-runs a fit, and a store that could only be asked by session could return a different input set from the one committed |

The settlement service's route evaluation and adjudication are the two places the two workspaces
meet, and both go through the shared core rather than through a new port: the routes are priced by the
calibrator's `moments`, and the adjudication's digest is the calibrator's `digest`.

BELL-IV, when it exists, is not a new port. It is a pure function of `(λ, pL)` plus a freshness
stamp on the pool price. The fallback when the stamp is stale is the same trailing-realised
estimator the premium publisher already names.

## The cross-language contract

Two things cross the language boundary, and both are specified once and tested on both sides.

**The WAD encoding.** Solidity `uint256` at 1e18; a `Wad` value object off chain. Neither side passes
a `float` across this boundary — there is no `float` in any Python domain signature, and no `number`
in any TypeScript one, where `Wad` holds a `bigint` and the type is the double's only representation
that is exact at 19 digits.

**The commitment digest.** Paper Appendix B. `digest.ts` (and `digest.py`) builds the preimage;
`keccak256(abi.encode(...))` builds the same bytes on chain. The fixture is `spec/digest.json`, read by
`contracts/test/differential/Digest.t.sol`, `calibrator/tests/contract/digest.test.ts` and
`calibrator/tests/contract/test_digest_contract.py`.

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
generates four files from it: `contracts/src/generated/Constants.sol`,
`calibrator/src/bell_calibrator/domain/constants.py`, `calibrator/src/domain/constants.ts` and
`spec/fixtures/canonical.json`. Each side gets a generated module rather than a runtime read, because
loading the YAML at runtime would put a filesystem read inside `domain/`, which the layer rule forbids.
`make check-generated` fails if any of them is stale.

**The generator was the last thing in `tools/` written in Python, and it moved with the rest of them.**
The port is verified the way it was specified — by byte-identity. `tools/gen_constants.ts` reproduces
`Constants.sol`, `constants.py` and `canonical.json` exactly, and `make check-generated` runs **both**
generators, so the pair keeps asserting that two independent renderings of one YAML agree. The Python
half is the oracle rather than a copy and is deliberately not edited to match its successor; it goes
when the Python does (Phase B), and the two banners that still name `tools/gen_constants.py` go with it.
See `DESIGN_NOTES.md` F55.

`constants.ts` emits every value as a `bigint`. The Python counterpart declares `int`, which is
arbitrary precision, and `bigint` is the only TypeScript type that is the same thing; a `number` would
be the IEEE-754 double the domain's whole discipline exists to keep out. `models.ts` imports `WAD` from
it rather than declaring it, which was the one place the port departed from the single-source rule.

## Tests

| Suite | Path | Purpose |
|---|---|---|
| unit | `contracts/test/unit/`, `calibrator/tests/unit/`, `settlement/tests/unit/` | one function, literal inputs |
| fuzz | `contracts/test/fuzz/` | the §10.3 invariants over generated inputs |
| differential | `contracts/test/differential/` | Solidity agrees with the off-chain reference, via a shared fixture |
| contract | `calibrator/tests/contract/` | the same fixtures, from the off-chain side — `*.test.ts` and `test_*.py` |
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

The Solidity is layered by *what each file is for*, and the same rule as the Python side applies: if
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

Five routes behind one `SettlementRoute` protocol, in `settlement/.../domain/routes/`. The route is a
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
