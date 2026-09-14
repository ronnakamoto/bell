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
| domain | `calibrator/src/bell_calibrator/domain/` | the standard library, and itself |
| application | `calibrator/src/bell_calibrator/application/` | domain |
| adapters | `calibrator/src/bell_calibrator/adapters/` | domain and application |
| domain | `settlement/src/bell_settlement/domain/` | the standard library, its own domain, and `bell_calibrator.domain` |
| application | `settlement/src/bell_settlement/application/` | domain |
| adapters | `settlement/src/bell_settlement/adapters/` | domain and application |

Nothing imports `adapters` except the composition root.

**The one cross-workspace edge** is `bell_settlement.domain -> bell_calibrator.domain`, and it exists
because artifacts 2 and 3 share a domain core: the settlement service's adjudication re-runs a fit
from the calibrator's committed inputs, and its route outcomes are priced by the calibrator's moment
primitives. The direction is enforced rather than agreed: the settlement workspace carries an
`import-linter` contract named *"the calibrator never imports the settlement service"*, so the reverse
import fails `make check`.

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
`WORKSPACES` in `tools/check_layout.py`.

## The ports

Declared in `bell_calibrator/domain/ports.py`; implemented in `adapters/`.

| Port | What it abstracts | Why it is a port |
|---|---|---|
| `Keccak` | the hash primitive | `domain/` may not depend on a hash library, so it owns the *preimage layout* — the part that must be identical across languages — and the adapter owns the primitive |
| `GapSource` | where daily bars come from | the gap-data source will change; the domain must not |
| `AnnouncementCalendar` | scheduled announcement dates | *scheduled*, not reported: conditioning on a scheduled release is the entire basis of the event-session calibration |
| `ParameterPublisher` | the off-chain commitment | the trust shift this creates is deliberate and is policed by a bond and a deterministic re-run, not assumed away |
| `ReferencePrintSource` | where reference prints come from | the feed will change; the domain must not. Unordered on purpose, because the selection is total and a source that reordered on a retry would look like a different input set |
| `CommittedInputStore` | where a committed fit's raw inputs are retrieved from | the adjudication re-runs a fit, and a store that could only be asked by session could return a different input set from the one committed |

The settlement service's route evaluation and adjudication are the two places the two workspaces
meet, and both go through the shared core rather than through a new port: the routes are priced by
`bell_calibrator.domain.moments`, and the adjudication's digest is
`bell_calibrator.domain.digest`.

## The cross-language contract

Two things cross the language boundary, and both are specified once and tested on both sides.

**The WAD encoding.** Solidity `uint256` at 1e18; Python `Wad`, a frozen value object. Python never
passes a `float` across this boundary — there is no `float` in any domain signature.

**The commitment digest.** Paper Appendix B. `bell_calibrator/domain/digest.py` builds the preimage;
`keccak256(abi.encode(...))` builds the same bytes on chain. The fixture is `spec/digest.json`, read
by both `contracts/test/differential/Digest.t.sol` and
`calibrator/tests/contract/test_digest_contract.py`.

The pricing primitive is checked the same way against `spec/fixtures/moments.json`: 112 points
computed by the Python side at 50 significant digits, asserted by `Stat` against a tolerance derived
from the on-chain error function's stated 1.5e-7 bound.

## Constants

`spec/constants.yaml` is the only place a domain constant is written down. `tools/gen_constants.py`
generates `contracts/src/generated/Constants.sol`, `calibrator/src/bell_calibrator/domain/
constants.py` and `spec/fixtures/canonical.json` from it. Python gets a generated module rather than
a runtime read because loading the YAML at runtime would put a filesystem read inside `domain/`,
which the layer rule forbids. `make check-generated` fails if any of the three is stale.

## Tests

| Suite | Path | Purpose |
|---|---|---|
| unit | `contracts/test/unit/`, `calibrator/tests/unit/`, `settlement/tests/unit/` | one function, literal inputs |
| fuzz | `contracts/test/fuzz/` | the §10.3 invariants over generated inputs |
| differential | `contracts/test/differential/` | Solidity agrees with the Python reference, via a shared fixture |
| contract | `calibrator/tests/contract/` | the same fixtures, from the Python side |
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
