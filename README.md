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
| `calibrator/` | TypeScript: gap ingestion, classification, fitting, publication |
| `settlement/` | TypeScript: the five settlement routes, and the challenge adjudication |
| `indexer/` | TypeScript: fold the lifecycle's logs into a session catalogue |
| `web/` | Next.js: browse the catalogue and read honest oracle quotes (F1) |
| `spec/` | The single source of truth for every shared number and fixture |
| `GAS_REPORT.md` | Per-operation gas against the brief's §13.3 budget |
| `docs/` | The research paper this implements |

## Build, test, check

```
make ts-install  # one-off: install the TypeScript workspaces
make build       # generate spec-derived artifacts, then compile
make test        # Solidity + TypeScript suites
make check       # formatter, linters, architecture, layout, coverage, fixtures
make test-fork   # fork suite; needs BELL_RPC_URL, skipped if unset
make diagnostics # print the lattice, canonical, AMM and fee numbers from the deployed code
```

`make build` needs Foundry and Node. `make ts-install` is a one-off setup step; after it,
`make build`, `make test` and `make check` run with no further arguments. `make help` lists every
target; there are no tribal commands.

## Current status

| Suite | Tests |
|---|---|
| Solidity — unit, fuzz, invariant, differential, gas, adversarial | 365 |
| TypeScript — calibrator, settlement, indexer | 796 |
| **Total** | **1161** |

**The stack is Solidity for the contracts and TypeScript for everything around them** (ruling R5).
The Python port is complete and deleted. Phases A–C, G0 (NIG fallback), G1 (event-session
shrinkage) and G2 (BELL-IV) are done. Discovery (F0) has landed: the indexer folds the producer
corpus into a catalogue, and listing registers the session in the same transaction (F93).

`make build`, `make test` and `make check` all pass. Every coverage rule the brief states is met and
asserted by `make check-coverage` rather than eyeballed:

| Scope | Rule | Measured |
|---|---|---|
| `contracts/src/libraries/` | 100% on lines, statements, branches, functions | **100%** (5 libraries) |
| `contracts/src/**` | ≥ 95% lines | **99.48%** |
| `calibrator/src` | ≥ 95% lines and branches | **97.96% / 95.56%** |
| `settlement/src` | ≥ 95% lines and branches | **97.76% / 95.04%** |
| `indexer/src` | ≥ 95% lines and branches | **99.15% / 96.72%** |
| `web/src` | ≥ 95% lines and branches | **99.12% / 97.22%** |
| every `domain/**` file | 100% on all four metrics | **100%** (46 files) |

One brief requirement is not met as written and is recorded rather than hidden: `commit` costs
158,247 gas against the brief's §13.3 cap of 150,000. The cap was raised to 170,000 by ruling (F42)
— the record is five packed slots plus the bond transfer, and the narrowing that would meet 150,000
trades real limits for 5% of one operation's gas — see F42 in `DESIGN_NOTES.md` and `GAS_REPORT.md`.

The fork suite is the one item that cannot run here: the brief requires tests against a pinned
block on chain 4663 but supplies no RPC endpoint, so `make test-fork` skips with an explanation
(F6). Everything else in the brief is executable and executed.

`DESIGN_NOTES.md` carries the findings. Most are defects the build found in itself rather than
objections to the brief. What remains open without an input is the fork suite (F6) and G3 (a maker
for the LP cold start); the Eq (20) volatility pin (F11), the `commit` gas cap (F42), and the
trading-fee wiring (F97) are ruled (Phases 48–49). G3's preparatory work is complete: the pool
imbalance measurement (F110), the depth-gated listing — a non-zero seed below $50,000 is refused
(F111) — and the volatility-weighted fee (F97).
F84's calibrator composition root is `make calibrate-publish` (calibrate → store window → commit
intent preview); settlement's challenge-verify root landed with F2. The publisher's broadcast
surface is the same CLI with `--rpc-url`/`--private-key`/`--premium` (F108), and the session
authority ops are `make authority-expire` / `make authority-close` (F109).

F50 records the one gap that is a matter of scope rather than defect: the brief's three artifacts are
the protocol and its two services, and none of them is the surface a participant touches. The paper
justifies no-liquidation by participants who are "largely retail" and cannot monitor a margin call
over a 65-hour weekend (§4.2), which makes the interface part of the product rather than a
convenience. Discovery has landed: the factory still cannot enumerate sessions, but the indexer
folds the lifecycle's logs into a catalogue, verified against a corpus the contracts emitted.
F50 is complete: the web app carries the participant surface (browse, quote, trade/LP/claim/
withdraw intents, challenge and resolve, all broadcastable through a browser wallet — F106/F107),
the CLI carries the publisher's commit broadcast (F108) and the session authority ops (F109), and
the challenge tooling is the verify CLI plus the web's challenge page (F2). The JSON-RPC client
lives once, in the calibrator's adapters, and the indexer and the web re-export it (F112).

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
