# BELL

A fully-collateralised, no-liquidation market for closed-session equity gap risk on tokenised
equities.

A session's gap is `G = O / C_prev - 1`. The protocol mints a pair of claims on it, one unit of
collateral per pair:

```
PI_L = min(lambda * |G|, 1)        PI_S = 1 - PI_L
```

Because the two legs are complementary claims on one unit of collateral, `PI_L + PI_S == 1` for
every outcome and every leverage. Full collateralisation is therefore a theorem rather than a
risk-management practice: no margin requirement, no maintenance threshold, no liquidation engine,
and no realised pair of prices at which the protocol owes more than it holds. Leverage is derived
from a stated saturation probability, `lambda* = 1 / Q_(1-alpha)(|G|)` with `alpha = 0.01`, so
saturation happens by construction rather than by accident.

## Layout

| Path | Artifact |
|---|---|
| `contracts/src/` | Solidity 0.8.26: the arithmetic libraries, the session and its pool, the factory, the two registries |
| `contracts/test/` | unit, fuzz, invariant and cross-language differential suites |
| `contracts/script/` | deployment, and the diagnostics printer |
| `calibrator/` | Python: gap ingestion, classification, fitting, publication |
| `settlement/` | Python: the five settlement routes, and the challenge adjudication |
| `spec/` | The single source of truth for every shared number and fixture |
| `GAS_REPORT.md` | Per-operation gas against the brief's §13.3 budget |
| `docs/` | The research paper this implements |

## Build, test, check

```
make venv        # create .venv and install both workspaces' dev dependencies
make build       # generate spec-derived artifacts, then compile
make test        # Solidity + Python suites
make check       # formatter, linters, mypy --strict, import-linter, layout, coverage
make test-fork   # fork suite; needs BELL_RPC_URL, skipped if unset
make diagnostics # print the lattice, canonical, AMM and fee numbers from the deployed code
```

`make build` needs Foundry and a Python 3.12+ environment. `make venv` is a one-off setup step; after
it, `make build`, `make test` and `make check` run with no further arguments. `make help` lists every
target; there are no tribal commands.

If you would rather use an interpreter you already have, name it and nothing else changes:

```
make test PYTHON=/path/to/venv/bin/python
```

The Makefile prefers a project-local `.venv`, then `python3`. If neither carries the test toolchain,
`make check` says so and tells you which of the two lines above to run, rather than failing somewhere
inside a recipe with `No module named pytest`.

## Current status

| Suite | Tests |
|---|---|
| Solidity — unit, fuzz, invariant, differential, gas, adversarial | 353 |
| Calibrator — Python | 130 |
| Settlement — Python | 77 |
| **Total** | **560** |

`make build`, `make test` and `make check` all pass. The brief's two coverage rules are met and are
asserted by `make check-coverage` rather than eyeballed: all five libraries in `contracts/src/libraries/`
are at 100% on lines, statements, branches and functions, and `src/**` is at 99.47% lines. Six of the
nine source files are at 100% on all four metrics.

One brief requirement is not met and is recorded rather than hidden: `commit` costs 158,247 gas against
a §13.3 cap of 150,000 — see F42 in `DESIGN_NOTES.md` and `GAS_REPORT.md` for the attribution and the
recommended remedy.

The fork suite is the one item that cannot run here: the brief requires tests against a pinned
block on chain 4663 but supplies no RPC endpoint, so `make test-fork` skips with an explanation
(F6). Everything else in the brief is executable and executed.

`DESIGN_NOTES.md` carries 48 findings. Most are defects the build found in itself rather than
objections to the brief, and most of those were surfaced by reading the coverage report as a
diagnostic rather than by reading code: a pool-draining swap path in `Amm` (F44), a missing depth
guard in `SessionPool` (F45), three files with no tests at all (F46), a `resolve`/`preview`
divergence that panicked and left a session permanently unsettleable (F47), and a one-pair seed that
stranded a claim and made `close()` unreachable (F48).

## Deploy

```
make deploy        # simulate locally and print the manifest; no broadcast
make deploy-fork   # broadcast to a fork; needs BELL_RPC_URL and BELL_DEPLOYER_KEY
```

The manifest prints the addresses, the parameters, the lattice diagnostics and the guard map. With
`BELL_COLLATERAL` unset the script deploys a development collateral and says so loudly in the
manifest — that deployment is a harness, not a deployment of the protocol. Set `BELL_ARBITER`,
`BELL_SESSION_AUTHORITY` and `BELL_REFERENCE_TOKEN` to override the defaults.

## Where to start reading

`DESIGN_NOTES.md` first — it records the decisions, the objections raised against the build brief,
and the rulings taken. Then `ARCHITECTURE.md` for the layering, and `SECURITY.md` for the trust
model.
