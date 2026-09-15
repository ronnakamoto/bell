# Architecture

## The governing principle

**The domain core is pure, and everything that touches the world is an adapter at the edge.** The
truncated moment, the leverage rule, the session classification and the AMM mathematics are all
computable with no network, no filesystem, no clock and no global state. The test the brief applies
is the right one: if you cannot unit-test a domain function by calling it with literal arguments, it
is in the wrong layer.

## The layer diagram

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

The rule is enforced twice because the languages need different tools for it: `import-linter` for
Python, `dependency-cruiser` for TypeScript. Both are in `make check`.

**`decimal.js` is the one permitted domain dependency**, and the reason §7.4 admits it is R5.1: the
rule was always "no dependency that can reach the world", and a pure arithmetic library cannot. It is
an allow-list of one named package rather than a category, so a second package is a finding rather
than a judgement call.

Nothing imports `adapters` except the composition root.

**The one cross-workspace edge** is `settlement/domain -> calibrator/domain`, and it exists because
artifacts 2 and 3 share a domain core: the settlement service's adjudication re-runs a fit from the
calibrator's committed inputs, and its route outcomes are priced by the calibrator's moment
primitives. The direction is enforced rather than agreed, and enforced in both languages — an
`import-linter` contract named *"the calibrator never imports the settlement service"* for Python, and
a `dependency-cruiser` rule of the same name for TypeScript — so the reverse import fails `make check`
whichever language it is written in.

## The dependency rule, and the command that enforces it

```
make check-architecture      # lint-imports, in each Python workspace
```

The contracts live in each workspace's `pyproject.toml` under `[tool.importlinter]`:

- *domain depends on nothing but the standard library and itself* — forbids the sibling layers and an
  explicit list of third-party packages, so "no dependency may be added to domain" is checked rather
  than trusted. `include_external_packages = true` is what makes the external half work.
- *application does not import adapters* — the high-level policy must not reach a low-level driver.
- *the layer stack* — the ordering itself, as a single contract.
- *the calibrator never imports the settlement service* — the cross-workspace direction.

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

`spec/constants.yaml` is the only place a domain constant is written down. `tools/gen_constants.py`
generates `contracts/src/generated/Constants.sol`, `calibrator/src/bell_calibrator/domain/
constants.py` and `spec/fixtures/canonical.json` from it. Each side gets a generated module rather than
a runtime read, because loading the YAML at runtime would put a filesystem read inside `domain/`, which
the layer rule forbids. `make check-generated` fails if any of the three is stale.

**The TypeScript constants module is the next thing the port needs**, and it is the one place where the
TypeScript currently departs from the rule: `models.ts` declares `WAD = 10n ** 18n` inline rather than
importing it from a generated `constants.ts`. That is a transitional state with a real cost — the value
is written down twice — and it is listed as an open item rather than left to be noticed. The generator
itself is also still Python; it moves with the rest of `tools/`.

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
Strategy rather than a branch inside one function because the set is open, and because the paper
compares all five on cost — an `if`-chain would make adding a route a change to the settlement path,
which is the last place a change should be.

Each route declares `expected_cost_bp`, `monotone` and `free_option` alongside its behaviour. Those
three are load-bearing for the comparison: a non-monotone payoff admits a strategy that extracts value
from settlement rather than from the gap, and a route that pays on an absent print writes an option to
its own hedgers at no premium. `cost_report()` is the brief's §4.3 item 4, and it reports R3 as
unquotable rather than as zero — a number no name experiences is worse than an absent one.
