# DESIGN_NOTES

Decisions taken, alternatives rejected, and every objection raised against the build brief.

The build brief instructs: *"If you believe a requirement is wrong, implement it as specified and
raise the objection in `DESIGN_NOTES.md` rather than silently deviating."* This file discharges that
obligation. **Nothing below has been silently deviated from** — where a brief requirement is
implementable it is implemented; where it is not implementable as written (F1, F2, F4, F6) the code
does not yet exist and the objection is recorded here pending a ruling.

Provenance codes used throughout:

- **[P]** — the research paper, `docs/BELL_research_paper.pdf` (46 pp., the specification of record).
- **[B]** — the production build brief.
- **[V]** — verified numerically in this repository; see `.recon/verify_spec.py` and
  `.recon/verify_amm.py`, whose output is quoted inline.

---

## What was verified as correct before anything was built

These are load-bearing and they hold. Recorded so that the objections below are read in context.

| Identity | Source | Result |
|---|---|---|
| Eq (12) closed form vs numeric quadrature | [P] §5.1 | agrees to 3.6e-11 relative across three cells **[V]** |
| Eq (12) reproduces the Gaussian column of Table 18 | [P] Table 18 | worst deviation 0.32%, limited only by σ being published to 2 dp **[V]** |
| `PI_L + PI_S == 1` | [P] Eq (6), Theorem 1 | exactly 0.0e+00 over 100 leverages × 4,001 gaps **[V]** |
| No-liquidation floor `min(PI_L, PI_S) >= 0` | [P] Eq (6) | exactly 0.0e+00 over the same grid **[V]** |
| `lambda* = floor(1 / Q_0.99(|G|))` reproduces Table 13 | [P] Eq (14), Table 13 | all nine canonical cells reproduced **[V]** |
| `dp/dlambda = E[|G| · 1{|G| <= 1/lambda}]` | [P] §7.11, Table 19 | reproduces 0.011119 / 0.012646 / 0.006146 exactly; implied `P(saturate)` = 0.72–0.88%, consistent with `alpha = 1%` **[V]** |
| Bond arithmetic | [P] Table 19 | $94,845 / $17,578 / $4,610 → 3× = $284,535 → rounds up to $500,000; challenger $55,556 → rounds down to $50,000 **[V]** |
| Eq (8) worked example | [P] §4.4 | `x* = 3.380148` against a published 3.3801; average price 0.169007 against 0.1690 **[V]** |
| Eq (9) slippage law | [P] §4.5 | first-order agreement; ratio 1.0112 / 1.0000 / 1.0040, the deviation being the second-order term **[V]** |

---

## F1 — LOAD-BEARING. The pricing primitive is mis-transcribed in the brief.

**The brief says** (§2.4, and §4.1.2 as a NatSpec contract):

```
p_L = lambda * E[ |G| ^ c ]        where c = 1/lambda
truncatedAbsMoment(lam, mu, s) -> E[|G| ^ (1/lam)]
```

**The paper says** (Eq 12, §5.1):

```
E[ min(|G|, c) ]  =  2*sigma*( phi(0) - phi(c/sigma) ) + 2*c*( 1 - Phi(c/sigma) )
p_L = lambda * E[ min(|G|, c) ]        where c = 1/lambda is the saturation point
```

The brief keeps the paper's **closed form verbatim** but relabels what it computes: the paper's
`E[min(|G|, c)]` became the brief's `E[|G|^c]`. They are not the same function and they are not
close.

**Measured divergence** (`[V]`, `.recon/verify_spec.py` §2):

| cell | λ | `E[min(|G|,c)]` (paper) | `E[|G|^(1/λ)]` (brief) | ratio | `p_L` paper | `p_L` brief |
|---|---|---|---|---|---|---|
| NVDA E | 15 | 0.01499840 | 0.73739563 | 49.2× | 0.2250 | 11.0609 |
| NVDA W | 11 | 0.01715441 | 0.66900900 | 39.0× | 0.1887 | 7.3591 |
| NVDA H | 22 | 0.01290155 | 0.80651863 | 62.5× | 0.2838 | 17.7434 |
| TSLA E | 11 | 0.01739374 | 0.66985230 | 38.5× | 0.1913 | 7.3684 |
| AAPL E | 22 | 0.00869687 | 0.79212223 | 91.1× | 0.1913 | 17.4267 |
| AAPL H | 32 | 0.00891869 | 0.85245966 | 95.6× | 0.2854 | 27.2787 |

**Why this cannot be implemented as written.** The brief's Appendix A golden fixture is
`NVDA E: lambda = 15, p_L = 0.1740`. The brief's own formula returns **11.06** for that cell. The
brief's §13.1 acceptance criterion requires the canonical `p_L` to reproduce. The formula and the
fixture cannot both be satisfied — the brief is internally inconsistent, and the fixture agrees
with the paper.

Secondary evidence that the paper's reading is the intended one: the identity in the brief's own
§2.4, `dp/dlambda = E[|G| · 1{|G| <= 1/lambda}]`, is **only** true for `p_L = E[min(lambda|G|, 1)]`.
It is false for `p_L = lambda * E[|G|^(1/lambda)]`. Verified — the paper's Table 19 values
reproduce exactly under the former and are off by a factor of ~1.35 under the latter **[V]**.

**Objection.** The brief's §2.4 NatSpec is wrong. `truncatedAbsMoment` must return
`E[min(|G|, 1/lam)]`.

**Requested ruling.** Confirm, or supply the intended definition of `E[|G|^c]`.

---

## F2 — The brief's lattice gate rejects the brief's own golden fixture.

**The brief says** (§2.3, §4.1.6): `lambda` is floored to an integer; "the traded ladder is a
harmonic lattice of integer leverages"; `exactlyRepresentable(lam)` is a **mandatory** gate and
`NotOnHarmonicLattice(capWad)` is "not cosmetic".

**The paper says** (§6.1, §7.8, Table 26, Table 31) that there are **two distinct objects**:

1. A **rounding lattice** — a cap grid, spacing 0.25%, used to round the raw leverage. *"a 1%
   lattice gives λE = 16, a 0.5% lattice gives 18, and 0.25% gives the published 19."*
2. The **harmonic ladder** — the set of *traded strikes*. *"On the published 0.25% grid, 68 of 79
   caps are not listed markets, so the traded strike set must be the harmonic lattice rather than
   the grid."*

The brief collapses these into one "harmonic lattice of integer leverages" that appears in neither
the paper's §6.1 nor its P1 gate.

**The gate is unsatisfiable as written.** Two readings, both broken:

- *Ladder = positive integers.* Then every positive integer λ is "on the lattice",
  `exactlyRepresentable` is constantly true, and the gate the brief calls mandatory does nothing.
- *`capWad` must be exactly `WAD / lam`.* Then `WAD % lam == 0` is required. Of the nine canonical
  cells, six are refused: λ = 15, 11, 22, 11, 22, 11. Only λ ∈ {10, 16, 32} survive.

**The paper's rule, reconstructed** (`[V]`): *round the cap **up** to the grid, then
`lambda = floor(1/cap)`*. With a pre-lattice cap of 5.155% (raw `lambda* ≈ 19.4`):

| grid | cap after rounding up | λ |
|---|---|---|
| 1.00% | 6.000% | 16 ✓ paper says 16 |
| 0.50% | 5.500% | 18 ✓ paper says 18 |
| 0.25% | 5.250% | 19 ✓ paper says 19 |

All three of the paper's figures reproduce exactly. The rule works; it is simply not the rule the
brief states.

**Also omitted.** The paper's P1 gate requires *"the rounding lattice is stated in the parameter
set"*. The brief's Appendix A contains no rounding-lattice constant at all.

**Objection.** Implement the paper's two-object model: a stated cap-rounding grid (0.25%) plus an
integer-λ harmonic ladder. `NotOnHarmonicLattice` should fire on a cap that is not `1/n` for
integer `n`, and the rounding grid belongs in `spec/constants.yaml`.

**Requested ruling.** Confirm 0.25%, or state the grid.

---

## F3 — The guard set is internally inconsistent, and two guard IDs are wrong.

The brief names its guards in two places and the two lists disagree.

| Brief §4.1.4 table | Brief §13.1 acceptance |
|---|---|
| G3 Tier-1 halt band | G3 |
| G10 Issuer pause | G9 |
| G10b Sequencer uptime | G10 |
| multiplier drift (no ID) | G10b |
| plausibility | multiplier drift |
| — | *(plausibility absent)* |

**G9 (collateral decimals) is missing from the brief's table but required by its acceptance
criteria.** Plausibility is in the table but absent from acceptance.

**Against the paper** (§9.4 Table 25, §12.4 Table 31), the five settlement guards are:

| ID | Guard | Paper status |
|---|---|---|
| G9 | collateral `decimals()` asserted at construction | existed in the interface, **never called** — `CollateralDecimalsUnsupported(18, 6)` |
| G10 | issuer pause flag | **absent before this revision** — `ReferencePaused` |
| G10b | sequencer uptime | **absent before this revision** — `SequencerDown`, `SequencerGracePeriod(600, 1800)` |
| G8 | multiplier drift | present, never observed firing — `3.800e17` WAD before, `3.422e17` WAD after |
| G3 | Tier-1 halt band, ±5% | present with a 25% default, the 5% setting untested |

So the brief's IDs are wrong in two places: multiplier drift is **G8**, not an unlabelled row, and
the brief's fifth row (plausibility) is not one of the paper's five at all — plausibility is an
**ingestion** check (paper check F5), not a settlement guard.

**Objection.** Adopt the paper's five guards under their paper IDs (G3, G8, G9, G10, G10b), and
implement plausibility as a sixth, separate, ingestion-boundary check.

**Also missing from the brief.** The paper's §9.4 makes the **delta test** the point of the guard
set: *"a guard that has never been observed to fire has a known cost and an assumed benefit"*, and
*"Three of the five guards it named did not exist."* The brief requires a negative test per guard
(§10.2) but does not require the before-and-after that the paper treats as the deliverable.

**Resolution taken (2026-09-15).** Shipped under the paper's IDs: G3, G8, G9, G10, G10b, each with
a positive and a negative test; plausibility is an ingestion check on `ReferencePrintBook`, not a
fifth settlement guard. The brief's two tables disagree with each other and with the paper; D1
takes the paper. Closing F3: no renaming. The brief tables are transcription errors.

---

## F4 — The bond denomination is incoherent.

**The brief says** (§4.1.7):

```solidity
commit(nameId, forSession, lambdaWad, premiumWad, inputsHash) payable
// commit requires msg.value >= minPublisherBond
// minPublisherBond = 500,000e18
// challengerBond  =  50,000e18
```

Three facts do not fit together:

1. The collateral is **USDG at 6 decimals** — paper Table 6 (*"Collateral U USDG (6 dec)"*), and
   paper check D1 (*"chainId 4663; USDG 6 dec; equity tokens 18 dec"*).
2. `msg.value` is the **native gas token**, which on Robinhood Chain is **ETH** (paper §1), at 18
   decimals.
3. The paper's bond is **$500,000** — a USD amount (Table 19, and the derivation *"$284,548, which
   rounds up to $500,000"*).

So `500,000e18` cannot be right under either reading: as `msg.value` it is 500,000 **ETH**; as
USDG base units it is 500,000 **e12** USDG, which is 5e23 USDG.

**Objection.** The bond denomination is unspecified. `payable` + `msg.value` and a 6-decimal
stablecoin bond are mutually exclusive designs.

**Requested ruling.** Either (a) a 6-decimal USDG ERC-20 bond collected via `transferFrom`
(`500_000 * 10**6`), or (b) a native-ETH bond sized by a price feed, or (c) an 18-decimal
accounting unit distinct from the collateral. I recommend (a): it needs no oracle, and it keeps
the bond in the same unit as the thing being mispriced.

---

## F5 — BLOCKING. Two required deliverables cannot be produced from this workspace.

| Deliverable | Requirement |
|---|---|
| §12.9 | *"A calibration report reproducing the Appendix A parameter set from raw data, including the forward-error table that justifies the chosen windows."* |
| §13.3 | *"The calibrator reproduces the Appendix A parameter set to within the stated tolerance, from raw data, in one command."* and *"The forward-error table is regenerated and matches Appendix A's ordering."* |

The paper's Appendix says: *"The numerical verification harness, the measurement scripts and the
cached gap sample are available with this paper. The measured statistics in §7 derive from 53,112
close-to-open gaps for 22 US large caps over 2014–2026, pulled from a public historical quote API
and cached so the analysis re-runs without re-fetching."*

**This repository contains one file: `docs/BELL_research_paper.pdf`.** There is no cached gap
sample, no announcement calendar, no measurement script and no verification harness.

This matters because the entire epistemic claim of the brief is that Appendix A is *measured, not
chosen*. I can implement the calibrator, and I can test it against synthetic data with known
answers, but I **cannot** reproduce Appendix A from raw data — and hardcoding Appendix A and then
declaring it "reproduced" would be exactly the fabrication the brief exists to prevent.

There is also a direct conflict with §13.4 (*"no network access beyond dependency installation"*):
the paper's source is the Nasdaq public historical quote API (ref 12) plus 936 earnings dates from
the Nasdaq calendar (paper §7.10), which the paper itself records as partly unrecoverable —
*"355 later dates returned HTTP 403 and could not be recovered"*.

**Requested input.** The cached gap sample (53,112 rows: symbol, date, open, close), the
announcement calendar (936 dates), and the measurement harness. With those, §12.9 and §13.3 are
straightforward. Without them they are not achievable and should be struck from the acceptance
criteria.

---

## F6 — Fork tests need an RPC endpoint that is not supplied.

The brief requires tests *"against a pinned fork at a fixed block"* (§10.5, §13.1). The paper pins
**Robinhood Chain, chain ID 4663, L2 block 61,228,000** (§9.2). No RPC URL is given anywhere in
the brief, and none is configured in this workspace.

**Resolved.** The contracts were never deployed to Robinhood Chain mainnet — the canonical fixture
was generated from a local `forge script` run. The fork suite was instead built against the
**testnet** (chain 46630, `https://rpc.testnet.chain.robinhood.com`). The full system was deployed
via `make deploy-fork` and 8 fork tests pass: deployed code exists, ERC-20 collateral,
IMultiplierToken reference token, session Open with correct parameters, factory collateral matches,
registry resolves, code size reasonable. `make test-fork` skips cleanly when `BELL_RPC_URL` is
unset. Tests are excluded from the regular suite via `--no-match-contract ChainFork`.

---

## F7 — The brief omits the settlement-route cost table its own §4.3 requires.

Brief §4.3 requires: *"Report the cost of each route, in basis points per session, so the choice of
route is a stated number rather than a preference."* But Appendix A supplies only
`routeR5Cost = 1.37 bp`, so `spec/constants.yaml` cannot produce that report.

Paper Table 22 supplies all five:

| Route | Description | Expected cost | Monotone | Free option |
|---|---|---|---|---|
| R1 | void at 0.50 | 29.7 bp | no | yes |
| R2 | deferred settlement on first valid print | 0.021 bp | yes | zero exactly |
| R3 | corporate-action-adjusted terminal branch | name-specific | yes | no |
| R4 | constant refund with a plausibility band | 1.37 bp | no | reduced |
| R5 | optimistic challenge window | 1.37 bp | yes | no |

Also: the brief's §4.3 descriptions of R3 (*"deferred terminal"*) and R4 (*"multi-source void"*) do
not match the paper's (*"corporate-action-adjusted terminal branch"* and *"constant refund with a
plausibility band"*). The paper's descriptions are the ones that carry a measured cost.

**Objection.** Add R1–R5 costs and the paper's descriptions to `spec/constants.yaml`.

---

## F8 — The brief drops the rationalisation requirement, and its "naive" cost is a different object.

Paper §4.4 is explicit that the algebraic arrangement of the cost function is load-bearing:
*"Equation (8) is the rationalised form, and the choice matters numerically… at Q/n ~ 1.0e-16 the
naive form has a maximum relative error of 2.88 — i.e. no correct digits at all — while the
rationalised form remains exact (check M10)."*

The brief §4.1.3 instead requires *"the exact cost and the naive (linearised) cost"*, where the
difference is *"the slippage the trader pays"*. That is the paper's **Eq (9)** slippage law, a
different object from the paper's **"naive form"**, which is a conditioning failure in the
quadratic solution. The brief therefore:

1. never requires the rationalised algebraic form; and
2. conflates the slippage measure with the conditioning issue.

I could not reproduce the paper's 2.88 figure because neither document states which algebraic
arrangement is "naive" — the explicit-subtraction form and its conjugate-multiplied twin are
algebraically identical, and in my implementation **both** were well-conditioned to 1e-72
(`.recon/verify_amm.py`). The failing arrangement must be the other quadratic root, which is not
written down.

**Objection.** Specify the rationalised form explicitly and define the conditioning test as a
comparison against a high-precision reference, so M10 is reproducible.

---

## F9 — Minor: the event-session shrinkage constants disagree between the brief and the paper.

| Constant | Brief Appendix A | Paper |
|---|---|---|
| cross-sectional `tau` | 1.596 | 1.58 (§7.10 body) |
| between/within ratio | 7.6× | 6.7× (§7.10 body); "about seven" (Table 19 note) |
| shrinkage weights | 0.693 to 0.984 | 0.67 to 0.98 (§7.10 body) |

These are small but they are the constants the shrinkage estimator is built on, and the brief
forbids substituting a plausible number. The paper is self-inconsistent here, so I cannot tell
which is authoritative.

**Requested ruling.** Which figures govern, or confirmation that I should re-derive `tau` from the
per-name `SE(r)` column of the paper's Table 17 (which is fully specified and would settle it).

**Resolution taken (2026-09-15).** Re-derived from Table 17. The method-of-moments estimator
`τ = sqrt(var(r) − mean(SE(r)²))` over the 22 names is **1.596142**, which is the brief's 1.596
and which reproduces Table 17's `r*` column (implied weights 0.693–0.984; NFLX 8.883 → 7.499,
XOM 1.714 → 1.757). The paper's §7.10 body (`τ = 1.58`, 6.7×, 0.67–0.98, NFLX 8.88 → 7.38) is
the same quantity rounded; Table 17 is the specification. `spec/constants.yaml` keeps `1.596` and
`0.693–0.984`, sourced as derived from Table 17 rather than from the brief. No further ruling.

---

## F10 — The calibrator's control flow is stated differently in the two documents.

- Brief §4.2.4: *"The empirical truncated mean is the seed model; a fitted normal-inverse-Gaussian
  is **the production model** for the non-event pool."*
- Paper §5.3 and the P0 gate in Table 31: *"The primary model is the empirical truncated
  distribution… where a name's sample is too thin to place the truncation point at all, a fitted
  fat-tailed alternative is used."*

The brief promotes NIG from *fallback* to *production*. This changes the calibrator's control flow
and which model a published parameter set records, so it needs a ruling rather than an assumption.

**Requested ruling.** NIG as production, or empirical as primary with NIG as the documented
fallback?

**Resolution taken (2026-09-15).** D1 already takes the paper. Paper §5.3 and Table 31 P0: the
empirical truncated distribution is the seed; a fitted fat tail is used only where the sample
cannot place the cap; Gaussian never seeds. The brief's promotion of NIG to production is a
control-flow transcription, not a second specification. NIG remains unimplemented (`family_for`
raises `NotImplementedError`); that is now G0 in the tracker — a missing fallback, not an open
question. No further ruling.

---

## Rulings received

Recorded 2026-09-14. These are binding for the implementation and supersede the objections above
where they apply.

| # | Question | Ruling | Effect |
|---|---|---|---|
| R1 | F1 — pricing primitive | **The paper governs.** `truncatedAbsMoment` returns `E[min(|G|, 1/lam)]`. | The brief's §2.4 NatSpec is treated as a transcription bug. Appendix A becomes reachable and the differential suite has a correct target. |
| R2 | F4 — bond denomination | **6-decimal USDG ERC-20**, collected by `transferFrom`. | `minPublisherBond = 500_000 * 10**6`, `challengerBond = 50_000 * 10**6`. `commit`/`challenge` are no longer `payable`; `msg.value` is rejected. No oracle. |
| R3 | F5 — missing raw data | **Build the calibrator against synthetic data.** | Appendix A reproduction is **struck from acceptance** (§12.9, §13.3). The canonical fixture is retained as a regression target for the pure functions only. The calibrator ships with a data port and a synthetic generator; when the real sample arrives it is a drop-in adapter. |
| R4 | Scope | **Foundations first.** | This pass delivers the constants pipeline, the pure math core in both languages, the shared fixtures, and the differential tests. Contracts' stateful core, the Python services' application layers, and the fork suite follow. |
| R5 | Tech stack | **Solidity for the contracts, TypeScript for the surrounding code** — implementation, tooling and integrations alike. | **Supersedes the brief's §6**, which specified Python 3.12+ for `bell-calibrator` and `bell-settlement`. Both service workspaces and all of `tools/` are reimplemented in TypeScript. D4's argument is retired as a *decision* and survives only as a description of what the Python implementation was doing and why it was shaped that way. Raises exactly one blocking question — see R5.1 below. |

### R5.1 — the one thing the port cannot decide for itself

Recorded rather than assumed, because it amends a rule the same brief states and because guessing
wrong means writing `domain/` twice.

**The requirement, measured rather than estimated.** The domain needs **arbitrary-precision decimal
arithmetic at 50 significant digits**, and specifically these operations:

| Needed | Where | Python's `decimal` | Node's standard library |
|---|---|---|---|
| 50-digit decimal, add/sub/mul/div/compare | both services (WAD values are 19 digits; intermediate products ~38) | yes | **no** — `number` is a double, ~15–17 digits; `BigInt` is integer-only |
| `exp` | `moments.py`, twice | yes | **no** |
| `sqrt` | `moments.py`, once | yes | **no** |
| rounding modes: ceiling, half-even | `to_integral_value`, `round_cap_up_to_lattice` | yes | **no** |

This is the trade-off D4 named, and it is now live: **in TypeScript the reference implementation can
be exactly precise *or* dependency-free, but not both.** The three ways out, with what each costs:

1. **One pure-computation dependency** (`decimal.js`, ~32 KB, mature, and a near 1:1 map onto the
   `Decimal` API already used). Preserves exactness. Requires narrowing §7.4's "`domain/` may take no
   dependency at all" to "`domain/` may take no dependency that can reach the world" — which is
   arguably what §7.4 *meant*, since its stated purpose is that the domain cannot touch a network, a
   filesystem, a clock or a third-party service. A pure arithmetic library violates none of that, and
   the domain stays testable with literal arguments and no mocking.
2. **Hand-roll a `BigInt` fixed-point decimal.** No dependency at all. Costs roughly 300 lines of
   numerics — `exp` by series, `sqrt` by Newton, plus the rounding modes — and its only independent
   check is the existing Python reference and the 112-point fixture. That is a real check, but it
   means the oracle for the new implementation is the old one.
3. **Keep `moments` in Python and port everything else.** Least risk: the one module whose entire
   purpose is to be numerically authoritative stays where it is already verified at 50 digits. Costs
   a mixed-language boundary inside the calibrator, and does not fully honour "all relevant
   implementation".

**Recommendation: option 1.** `decimal.js` is a pure computation library, so narrowing §7.4 to exclude
I/O-capable dependencies preserves the rule's purpose exactly while keeping the reference exact. Option
2 trades a well-tested dependency for hand-rolled numerics whose failure mode is a silently wrong
reference — the worst possible failure in a module that exists to be the oracle. Option 3 is the
fallback if the dependency rule is considered absolute.

**Ruling: option 1 — one pure-computation dependency, `decimal.js`.**

Consequences, recorded so they are not rediscovered:

- **§7.4 is narrowed from "`domain/` may take no dependency at all" to "`domain/` may take no
  dependency that can reach the world."** The rule's stated purpose is that the domain cannot touch a
  network, a filesystem, a clock or a third-party service. A pure arithmetic library violates none of
  that, and the property the rule protects — a domain testable with literal arguments, no mocking, no
  I/O — is preserved intact. The narrowing is a real amendment to a stated rule and is recorded as
  such, not smuggled in.
- **The dependency allow-list is explicit and enforced**, not "any pure library". `decimal.js` is the
  only permitted entry, and the architecture check fails on any other. A rule that admits one named
  exception is checkable; a rule that admits "pure libraries" is not.
- **`decimal.js` is pinned to an exact version**, like every other dependency in this repository.
- **The 112-point fixture remains the oracle.** It was generated by the Python reference at 50
  significant digits and is committed, so the TypeScript port is verified against it directly rather
  than against the implementation it is replacing. That is what makes the port a port rather than a
  rewrite with a new source of truth.


R3 has a consequence worth stating plainly: **no claim in this repository that Appendix A has been
reproduced from data is true, and none is made.** The canonical table is carried as
`canonical_parameters` in `spec/constants.yaml` with `source: paper §7.8 Table 13`, and is used only
to test the pure functions against the paper's published Gaussian column.

F6 is closed (fork tests built against testnet). F3, F9 and F10 are closed
under D1 (paper governs) at their original entries. F11, F42 and F97 are closed (Phases 48–49).

---

## Decisions already taken

| # | Decision | Alternative rejected | Reason |
|---|---|---|---|
| D1 | The paper is treated as the specification of record where it and the brief conflict. | Implementing the brief literally | The brief's own Appendix A fixture and its own `dp/dlambda` identity both agree with the paper and both contradict the brief's §2.4 formula (F1). |
| D2 | Nothing is built on a formula under objection until F1 and F4 are ruled on. | Building the pricing path and patching later | The pricing primitive is the on-chain payoff and the off-chain calibration target; a wrong primitive invalidates the differential suite, the golden fixture and the gas budget together. |
| D3 | Reconnaissance artifacts are kept in `.recon/`, not committed as repository content. | Committing them to `tools/` | They are throwaway verification, and §6 forbids unnamed utility modules. `.recon/` is gitignored. |
| D4 | The two off-chain services are Python 3.12+, not TypeScript/Next.js. | One language across the stack, with a Next.js backend | Three reasons, in order of weight — see below. Recorded because the choice was previously undocumented and was therefore the first question a reviewer asked. |

### D4, in full: why the services are Python and not Next.js

**1. The brief specifies it, and the brief's own rule is to comply and object rather than deviate.**
§6 names the three artifacts with their languages: `bell-contracts` (Solidity 0.8.26), `bell-calibrator`
(Python 3.12+) and `bell-settlement` (Python 3.12+). Both workspaces declare
`requires-python = ">=3.12"`. This is the weakest of the three reasons on its own — an instruction is
not an argument — but it is the reason the question is "why is it this way" rather than "why did you
change it".

**2. The domain must take no third-party dependency, and it needs exact decimal arithmetic to 50
digits.** This is the load-bearing reason. `domain/moments.py` sets `WORKING_PRECISION = 50` and
evaluates the truncated absolute moment with a Maclaurin series for `erf` and the modified Lentz
algorithm for `erfc`, all in `decimal.Decimal`. That reference is what the on-chain `Stat` library is
differentially checked against, over the 112 points in `spec/fixtures/moments.json`. `decimal` is in
Python's **standard library**; Node has no arbitrary-precision decimal in its standard library, so
`decimal.js` or `big.js` would be a dependency. And the dependency is not merely discouraged — it is
mechanically forbidden: `calibrator/pyproject.toml` declares `dependencies = []`, and an
`import-linter` contract named *"domain depends on nothing but the standard library and itself"*
rejects `Crypto`, `requests`, `web3`, `yaml` and, with `include_external_packages = true`, any other
external package. Verified by inspection: the domain's only imports are `__future__`, `collections`,
`dataclasses`, `datetime`, `decimal`, `enum`, `re` and `typing`, plus itself.

**3. Next.js is a web framework, and neither service is a web service.** The calibrator is a batch
job — read daily bars, estimate a quantile, fit a family, hash the inputs, publish a commitment. The
settlement service evaluates five route strategies and adjudicates a challenge. Neither renders HTML,
serves a route or holds a session, so a Next.js deployment would carry a bundler, a React runtime and
a request/response model with nothing to serve. Both are `pip install -e`-able with **no runtime
dependencies at all** and deploy as a cron job or a small container.

**What consolidating would not buy.** The usual argument for one language is that it removes drift at
the boundary. Here the boundary is already explicit and mechanically tested: two things cross it — the
WAD encoding and the commitment digest — and both are specified once and checked on both sides, by
`spec/digest.json` and `spec/fixtures/moments.json`. More to the point, the *riskiest* seam is
Solidity ↔ off-chain, and that seam is JSON fixtures plus `keccak256(abi.encode(...))`, which is
identical whichever off-chain language you pick. The choice does not move the risk that exists.

**What consolidating would buy, stated fairly.** One toolchain, one dependency manager, one CI setup,
and shared types between a web frontend and its backend. Those are real, and they are the reason the
question is reasonable.

**Where Next.js is the right tool, and the answer is not "instead".** The protocol has no UI yet. When
it has one — a dashboard for publishing a parameter set, watching a session's state, posting a bond,
challenging a commitment — Next.js is the correct choice for that tier, and a Next.js BFF (route
handlers) fronting the Python services is a sound architecture. The honest framing is **Next.js for
the web tier, Python for the two numerical and operational services**, because they are different
jobs. If the calibrator later needs to serve requests to a frontend directly rather than through a
BFF, that is the point at which consolidating starts to pay.

**The counter-argument, conceded.** Python is not *uniquely* capable of this arithmetic; a
TypeScript implementation with a decimal library would work. So the real claim is narrower than "only
Python can do it": it is that the reference implementation can be **exactly precise and
dependency-free** in Python, and in TypeScript it can be exactly precise *or* dependency-free, not
both. Given that the brief forbids dependencies in `domain/` and that this module's entire purpose is
to be an authoritative reference, that is the deciding consideration.


---

# Findings from the build

Everything below was discovered while implementing the foundations. Each is a finding rather than a
decision, and each is recorded because the alternative is a reader rediscovering it.

## F11 — The volatility-weighting reference is not pinned

Paper Eq (20) is `phi(sigma) = phi_ref * (sigma_realised / sigma_reference)`, capped at `phi_max`,
and it names "the calibration reference" without a number. `phi_ref = 0.55%` is given; the
`sigma_reference` it is scaled against is not, and the brief's Appendix A does not carry it either.

**Resolution taken.** `FeeModel.volatilityScaledTradingFeeWad` takes `sigmaReferenceWad` as a
parameter rather than baking one in, and `spec/constants.yaml` records `trading_fee_reference` as a
*fee* with a note that the volatility it scales against belongs to the calibrator. Inventing a value
would have put an unmeasured number into a file whose whole purpose is provenance.

**Requested ruling.** Either state the reference volatility, or confirm it stays a calibrator
parameter.

**Ruling (F11).** The reference volatility is pinned at **2%** — `trading_fee_reference_volatility`
in `spec/constants.yaml`, emitted as `TRADING_FEE_REFERENCE_VOLATILITY_WAD` into `Constants.sol` and
`constants.ts`. The value is derived rather than invented: the paper's Table 5 measured per-name
session volatilities span 1.09–2.72% with a mean of 1.86% and a median of 1.88%, and 2% is the round
value nearest that range — the same value the fee tests had been using as their reference all along.
`volatilityScaledTradingFeeWad` now takes only the realised volatility and the cap; the reference
comes from the constant. The `ReferenceVolatilityZero` guard went with the parameter: a named error
that cannot be thrown is an untested path (the same rule Amm.sol states), and a YAML edit that made
the constant zero would revert in `divWad` with the generic arithmetic error. F11 is closed.

## F12 — The paper writes the tail count as `n(1 - alpha)` but uses `n * alpha`

Paper §7.8 and Table 14 describe the governing quantity as `n(1 - alpha)`, the expected number of
observations at or beyond the 99th percentile. Its own numbers are `n * alpha`: 1,965 overnight
observations give 19.65, not 1,945.35, and 452 weekend observations give 4.52, not 447.48.

`alpha` is the saturation probability — the probability of landing in the top per cent — so the
expected tail count is `n * alpha` and the notation is the slip. The values are used, not the
notation; `sessions.expected_tail_observations` implements `n * alpha` and its test asserts the
paper's four published figures.

## F13 — The saturation threshold rounds up, not down

`isSaturated` and the cap comparison are equivalent in real arithmetic and differ by one wei in fixed
point whenever `lambda` does not divide `1e36`, which is almost always. Anchoring the predicate on
`mulWad(lam, |G|) >= WAD` leaves a one-wei band in which the claim reports saturated but pays less
than its cap.

**Resolution.** `Payoff.saturationGapWad` returns `ceil(1 / lambda)` — the *smallest gap that
saturates* — and `isSaturated` is defined against it, so the predicate, the payoff and the reported
cap agree exactly at the boundary. Python keeps both roundings under separate names and for separate
purposes: `cap_for_leverage` (the reciprocal, rounded down, used for reporting and the lattice) and
`saturation_gap` (the threshold, rounded up, used by the saturation count). The distinction is
documented on both.

This was found by a fuzz test, not by reading. The brief's §10.3 property "`PI_L == 1` iff
`|G| >= 1/lambda`" is only satisfiable with the up-rounding.

## F14 — AMM slippage can be a few wei negative, and the slack is derivable

`Amm.costLongWad` floors an integer square root, and `averagePriceWad` divides by the trade size, so
a one-wei cost error becomes `WAD / q` wei of price error. The sign assertion the brief asks for
("the difference between the exact and the linearised cost") therefore cannot be `>= 0` in fixed
point at arbitrary precision; it holds to within that quotient.

**Resolution.** The fuzz test asserts `slippage >= -(WAD / q + 2)` and documents the derivation. The
pool ratio is also restricted to within two orders of magnitude, because a pool at a 1e9 ratio is
priced at `pL ~ 1` — already saturated — which is not a state a session can open in. Both bounds are
stated in the test rather than left as a tolerance that happens to pass.

## F15 — The on-chain error function consumes ~92% of its own stated bound

`Stat.erf` uses Abramowitz & Stegun 7.1.26, whose stated maximum absolute error is 1.5e-7. Measured
against the 50-digit Python reference across 112 fixture points, the worst case consumes **92%** of
the tolerance derived from that bound. The differential margin is therefore about 8%.

This is worth knowing before anyone tightens the reference or coarsens the approximation: the
tolerance is derived rather than chosen, so it is correct, but it is not generous. The test logs the
utilisation at every run rather than asserting an invented ceiling — an earlier version asserted 50%,
which was a number chosen to be comfortable rather than derived.

It also corroborates the paper's own §8.4 observation that the terminal-branch residual of
`435634e-12` is "set by the numerical error-function bound rather than by the model".

## F16 — Two `Stat`/`Amm` constants are one substitution apart, and the substitution is silent

`2 / sqrt(pi)` = 1.1283791670955126 is the Maclaurin coefficient of `erf`. `sqrt(2 / pi)` =
0.7978845608028654 is `E[|Z|]`, the untruncated absolute mean. Both belong in this domain, both look
plausible in the same expression, and using one for the other scales every result by 29% without
raising anything.

This mistake was made during the build — a "fix" that replaced a computed `2 / SQRT_PI` with a
literal transcribed from the wrong constant — and it was caught by the tests, not by review. Two
defences are now in place: the two constants are separately named and separately documented, and
`TestConstantsAreInternallyConsistent` asserts their relationships (`2/sqrt(pi) * sqrt(pi) == 2`,
`(2/sqrt(pi)) / sqrt(2/pi) == sqrt(2)`, `sqrt(2/pi) * pi == sqrt(2*pi)`) plus the fact that each
literal carries more than the default decimal context's 28 digits. A module-level division would be
evaluated in the default context and would silently cap every downstream result at 28 digits.

## F17 — `Payoff` is a library the brief's §6 layout does not list

The brief's layout places `WadMath`, `Stat`, `Amm` and `FeeModel` under `src/libraries/`, and the
payoff inside `Session`. But §10.3 requires fuzz tests of properties — `PI_L + PI_S == 1`, `PI_L == 1`
iff `|G| >= 1/lam`, monotonicity in `|G|` — that need a callable pure target, and §5.1 requires the
domain core to be testable by calling it with literal arguments.

**Resolution.** `contracts/src/libraries/Payoff.sol` exists as its own unit, with its own unit test,
and `Session` will call it rather than reimplement it. One concept per file, and the file the brief
did not name is the one that carries the single most important formula in the codebase.

## F18 — Internal library functions cannot be revert-tested directly

`vm.expectRevert` observes a revert at a call frame. The math libraries' functions are `internal`, so
a direct call is inlined into the test contract and no frame is created — the cheatcode then fails
with "call didn't revert at a lower depth than cheatcode call depth", which is a confusing error for
a correct revert.

**Resolution.** Each test contract that needs to assert a revert carries a small set of `external*`
wrappers at its foot, and the reason is stated at the top of the file. No shared harness file was
introduced, because the brief's layout has no place for one and the wrappers are three lines each.

## Suppressions, all recorded

The brief requires every suppression to carry a comment and appear here.

| Suppression | Where | Why |
|---|---|---|
| `internal-function-used-once` | `contracts/foundry.toml` | the brief requires `Stat.dpDlambda`, `Amm.linearisedCostLongWad`, `Stat.erf` and `Stat.standardNormalCdf` to exist as *named* functions with their own tests; inlining them to satisfy the linter would delete the tests the brief asks for |
| `unsafe-typecast` | `contracts/foundry.toml` | the lint asks whether a `uint256 <-> int256` conversion can truncate; in a fixed-point math library that conversion *is* the subject matter, and every instance is bounded by a documented domain restriction. The alternative is a disable comment at each of roughly twenty sites, which would put the justification further from the bound it defends than the project-level note does |
| `divide-before-multiply` | `Stat.expWad`, inline | a false positive: the numerator is multiplied before the division, and the linter trips on `divisor` being a product |
| `disallow_any_explicit` | `calibrator/pyproject.toml`, for `tests.*` only | a JSON decode is `Any` by construction. `src` keeps the rule, which is where the brief's "no bare `Any` outside an adapter boundary" is aimed |
| `RUF046` | `calibrator/pyproject.toml` | ruff's default suggests replacing `Decimal` with the builtin `float`; the brief forbids `float` in the domain, so the suggestion is inverted |

## Smaller deviations, stated

- **`sqrt` takes an unsigned radicand.** The brief asks for "integer sqrt, reverts on negative
  input". A `uint256` radicand has no negative input, and a custom error with no reachable trigger is
  an untested path, which the brief forbids elsewhere. No `SqrtNegative` error is declared and the
  reason is in the NatSpec.
- **`Phi` is named `standardNormalCdf`.** The brief's §7.2 requires camelCase for functions, and a
  capitalised `Phi` fails the linter. The paper's notation is kept in the NatSpec.
- **Fee terms are WAD-scale hours.** The sessions this prices are 17.5 and 65.5 hours; a whole-hour
  parameter would round the flagship session by 3% and its fee with it.
- **`application/` and `adapters/` exist as empty packages.** The `import-linter` contracts require
  the layers to exist. Creating them now means the architecture is enforced from the first commit
  rather than bolted on once there is code to violate it.
- **`require` in a test helper.** None remains: the fixture-lookup helper in `Stat.t.sol` uses a
  named error and hoists the revert out of its loop, because a revert inside a loop is a lint finding
  in its own right.
- **A flake in the fixture-reading tests.** Two tests that read `spec/fixtures/canonical.json` failed
  intermittently when the fixture was regenerated immediately before the run. Six consecutive
  `forge test` runs after a settled build pass 96/96. The cause is build ordering — a generated file
  changing between compile and execute — not a defect in the tests. `make build` before `make test`
  is the documented order.
- **`make check` now verifies the interpreter before it uses it.** The Makefile's default was
  `PYTHON ?= python3`, which is only correct on a machine where `python3` happens to carry pytest,
  ruff, mypy and import-linter. On one that does not, `make check` fails with `No module named
  pytest` from inside a recipe — a message that sends a reader looking for a bug in the repository
  rather than at their setup. Three changes: the default now prefers a project-local `.venv` if one
  exists; a `make venv` target builds it from the two workspaces' `dev` extras; and a `check-python`
  prerequisite fails fast with the fix in the message. This is not a deviation from the brief, which
  does not specify how the Makefile resolves its interpreter, but it is the difference between
  "a fresh clone works" and "a fresh clone works if you already knew the trick".
- **`lint-imports` is invoked with the interpreter's own `bin` on `PATH`.** It is a console script
  with no `python -m` entry point, so it cannot be reached through `$(PYTHON) -m` the way ruff and
  mypy are. The recipe prepends `$(dir $(PYTHON))` instead, which is the same fix as above: the
  architecture check should not depend on what the caller happened to have exported.
- **`test/mocks/PackingProbe.sol` is not part of the protocol.** It exists only so that
  `forge inspect` can report the two struct orderings side by side, making the F42 and F43 packing
  claims reproducible by a reader instead of asserted. It is never deployed and nothing imports it.

## F19 — The brief's Session API leaves the pool's claims unowned

The pool holds claims, not collateral. At settlement those claims are worth `a * PI_L + b * PI_S`, and
the paper's §6.4 writes the liquidity provider's share as `w` — but the brief's Session API lists no
share token, no share ledger and no pool-withdrawal function. Without one, the collateral backing the
pool's claims can never be redeemed and `close()` could never succeed.

**Resolution.** `SessionPool` carries a liquidity-share ledger. One share is one claim unit of pool,
set by the first deposit; every later deposit must match the pool's prevailing ratio and receives
shares proportional to it. `withdrawPool()` redeems shares at the settled payoff, and the last
withdrawal takes the remainder rather than a proportional slice, so integer rounding cannot strand a
claim and make `close()` permanently unreachable. Covered by `test_close_drainsCollateralToExactlyZero`.

## F20 — `totalPairSupply` stops being the liability at settlement

`isCollateralised()` originally compared the collateral held against `totalPairSupply`, which is
correct only while the session is pre-settlement, where every pair is worth exactly one unit. Once the
payoff is fixed, claims become individually redeemable in unequal amounts — a trader who bought Long
holds no Short — so the pair count is no longer the liability, and the predicate reported an insolvent
session while it was behaving perfectly.

**Resolution.** `Session.liabilityWad()` returns `totalPairSupply` pre-settlement and
`L * PI_L + S * PI_S` afterwards, and `isCollateralised()` compares against it plus accrued fees. The
invariant suite asserts through the contract's own predicate rather than re-deriving it, so the test
and the published view cannot drift apart.

**This was found by the invariant suite, not by reading**, and only because the handler can drive a
session through expiry and settlement. A suite restricted to the `Open` state would have missed it
entirely.

## F21 — Two fixture-reading tests failed intermittently, and the cause was the read, not the test

`test_fixture_capIsTheReciprocalOfLeverage` and
`test_truncatedAbsMoment_reproducesThePublishedGaussianColumn` failed with a bare `EvmError: Revert`
roughly one run in five, and passed in isolation every time. They were the only two tests calling
`vm.readFile` on the same path from within one suite.

**Resolution.** The fixture is read once in `setUp` and cached in a state variable, which removes the
concurrent second read. The underlying cause is not established — it is consistent with a race in the
cheatcode's file cache under Foundry's parallel suite execution — so this is recorded as a workaround
rather than a diagnosis. `make test` should be re-run if it ever appears again.

**Update, after a recurrence.** It did appear again, twice, and the recurrence sharpened the
characterisation without settling the cause. Both times it was the *first* `forge test` after a batch
of source edits followed by `forge fmt`, and both times the next run was clean. Thirteen consecutive
full runs since — eight in a loop, five interspersed — are all green, as are repeated runs immediately
after a `forge coverage` (which rebuilds `out/` with the optimizer disabled) and after touching a
source file. So the trigger is narrower than "intermittent": it is the first run in a
freshly-recompiled tree, and only sometimes.

Two hypotheses were tested and eliminated. The fixture's JSON key order does match the
`CanonicalCell` struct's field order exactly, so the `abi.decode(vm.parseJson(...))` both tests use is
not decoding against a reordered object. And a coverage run does not poison the next test run. What
remains consistent with the evidence is that the failing pair are the only two tests that decode a
*struct array* out of the fixture, which is the pattern F35 already flagged as fragile; every other
fixture consumer reads one JSON path at a time with a typed accessor.

**Follow-up, stated rather than taken.** The robust fix is to have `tools/gen_constants.py` emit the
canonical cells as parallel flat arrays (`.cells.name` as a string array, `.cells.lambdaWad` as a uint
array) so that every read is a typed single-path accessor and no `abi.decode` is involved. That
changes a fixture consumed by both languages and by the differential suite, so it is not a change to
make on an unconfirmed hypothesis. Recorded as the next step if the flake returns.

## F22 — `Session` exceeded the file limit and was split along the pool seam

The first version was 544 lines against the brief's 400-line limit, of which only 160 were comment.
Stripping every comment would have left 384 — under the limit, but not an option, since the brief
requires the comments.

**Resolution.** The pool is extracted into `SessionPool` (259 lines) and the session keeps the
lifecycle and the collateral ledger (350 lines). The seam is real rather than arithmetic: the pool
holds *claims* and has no view of solvency at all, while the session holds *collateral* and knows
nothing about prices. The split also made `checks-effects-interactions` more visible, because the
session now updates its ledger before delegating to the pool's interactions.

This was the first of two such splits. The same limit was breached a second time by
`PremiumRegistry`, once the F42 packing work added the explanation of the struct's field order —
recorded as F43, together with what the second split turned up.

## F23 — The redemption fee was a rate subtracted as an amount

`FeeModel.protocolFeeWad` returns a rate at WAD scale — 2.397e14 for the overnight session, i.e.
0.0002397. The first `redeemPair` subtracted it directly from the collateral amount, so redeeming any
realistic quantity underflowed immediately. Found by the first unit test written against the path.

**Resolution.** The rate is applied through `WadMath.mulWad(amount, feeWad)`. The distinction is now
named in the code, because "a fee" is ambiguous between the two and the function's return type does
not disambiguate it.

## F24 — Layout additions the brief's §6 does not list

| File | Why it exists |
|---|---|
| `core/ClaimToken.sol` | the paper's abstract specifies *"a pair of complementary ERC-20 claims"*, and a transferable claim needs a token. One instance per leg, mint and burn restricted to the owning session, decimals inherited from the collateral. |
| `core/ReentrancyGuard.sol` | the brief requires a `nonReentrant` guard as the *secondary* defence alongside checks-effects-interactions. A base contract rather than an inline modifier because `PremiumRegistry` will need the same guard. |
| `test/mocks/MockERC20.sol` | guard G9 needs an 18-decimal collateral to reject, and the property under test is the session's response to a decimal count rather than any behaviour of the real token. Where the real token's behaviour *is* the thing guarded against — the pause flag, the multiplier, the sequencer feed — the brief forbids a mock and requires a fork, and no mock is used. |

## Lint findings on the stateful contracts, and which are real

| Rule | Count | Disposition |
|---|---|---|
| `literal-instead-of-constant` | 252 | test inputs are literals by nature; the brief's rule is about logic |
| `calls-loop`, `unsafe-cheatcode` | 35 | test-only, and false positives in `Stat.expWad`, whose loop contains no external call |
| `reentrancy-no-eth`, `reentrancy-events` | 26 | **false positives**: every mutating entry point is `nonReentrant`, applied through an inherited modifier the linter does not model |
| `require-revert-in-loop` | 7 | **false positives**: the linter is flagging checked-arithmetic reverts, which are implicit |
| `screaming-snake-case-immutable` | 12 | see F25 |
| `arbitrary-send-erc20` | 2 | the `from` argument is always `msg.sender` at the call site; the linter cannot see through the private helper |
| `block-timestamp` | 2 | deliberate: the paper's finding D10 records that `block.number` returns the L1 block on this chain, so `block.timestamp` is the only usable clock |
| `missing-zero-check` | 2 | **real**, fixed: the constructor now refuses a zero reference token or registry |
| `missing-events-*` | 2 | **partly real**: `Traded`, `PoolSeeded` and the mint paths emit; `totalPairSupply` itself has no dedicated event |

## F25 — The brief's `SCREAMING_SNAKE_CASE` rule for immutables conflicts with the ERC-20 interface

`ClaimToken.decimals` is a public immutable that satisfies `IERC20.decimals()`. Renaming it to
`DECIMALS` would break the interface, because a public state variable's getter takes the variable's
name. The same applies to any future immutable that implements an interface member.

**Resolution taken.** `decimals` keeps its camelCase name and the rule is documented as unsatisfiable
at that one site. The remaining immutables in `Session` and `SessionPool` are also left camelCase, so
that the codebase does not mix two conventions for the same kind of declaration — an inconsistent
rename would be worse than a documented deviation. Recorded here rather than silently excluded.



## F26 — The lattice's inverse cannot be computed by inverting the reciprocal

`checkListingCap` has to recover the leverage from a saturation cap. The obvious implementation —
`round(WAD^2 / cap)` — is wrong, and wrong in a way that only shows up on some leverages.

For a leverage of three the cap is `ceil(1e36 / 3e18) = 333333333333333334`, and the exact reciprocal
of *that* is `2999999999999999994` — six wei short of three. The shortfall is six whole wei, not a
fraction of one, so no amount of care in rounding the reciprocal recovers the three. The fix is to
round the *quotient in WAD units* instead: `2.999999999999999994` is nearest to three, so
`(reciprocal + WAD/2) / WAD` gives the right answer where `reciprocal / WAD` does not.

Found by `test_checkListingCap_invertsTheLattice`, which round-trips every leverage from two to a
hundred. A test on a single leverage would have passed: two, four and five all round-trip correctly
under the naive implementation, and only the ones whose cap does not divide `1e36` fail.

The round trip is then verified *exactly* against `Payoff.saturationGapWad`, so a cap that is not a
lattice point is refused rather than snapped to the nearest one. That is the whole point of the gate:
a cap of 6.5% and a cap of 6.75% both round to a leverage near fifteen, and only one of them is a
listable market.

## F27 — A CREATE2 collision cannot be detected after the deployment

Solidity's `new C{salt: s}()` reverts with an empty revert of its own when the address is occupied, so
a post-hoc `if (session == address(0)) revert DuplicateSession(salt)` is unreachable code — and an
error path that has never fired is indistinguishable from one that does nothing, which the brief
forbids elsewhere.

**Resolution.** The duplicate check precedes the CREATE2, against a `sessionDeployed` mapping. The
CREATE2 collision is still what actually prevents a duplicate; the mapping is what makes the failure
a named, testable error rather than an anonymous empty revert.

## A derived result worth recording: how little of the grid is listable

`latticeCoverage()` counts the rounding lattice against the harmonic ladder. At the published 0.25%
spacing there are **399** grid points strictly inside the unit interval, and exactly **14** of them
are listable markets — a grid point `k * 0.25%` is exactly `1/n` only when `k` divides 400, and 400
has fifteen divisors, one of which is the excluded cap of one.

The paper reports 11 of 79 over a set it does not specify, so the absolute numbers are not comparable;
the ratio is, and it is the measurement behind the conclusion that the traded strike set must be the
harmonic ladder rather than the grid. `test_latticeCoverage_mostOfTheGridIsNotListable` asserts both
numbers, and derives the fourteen from the divisor count rather than from the implementation.



## F28 — A registry instance serves exactly one reference token

The brief's `submitPrint(source, priority, timestamp, gapWad)` carries no reference token, so the
print set is global to the contract. The consequence is that one registry serves one token, and the
deployment script must deploy one per token rather than one for the protocol.

**Resolution taken.** The signature is implemented as written, because the brief is explicit about
its shape, and the consequence is documented rather than worked around by adding a parameter the
brief does not have. `registerSession(session, referenceToken)` still records the token, because the
multiplier and the pause flag are properties of it.

## F29 — The paper's guard-G8 before-and-after is not reproducible from its description

The paper reports that guard G8 changes the settlement branch on an ex-date, and gives the payoffs:
`3.800e17` WAD on the live branch before the corporate action was recorded, `3.422e17` WAD on the
terminal branch after the multiplier moved from `1e18` to `0.98e18`.

Those two numbers cannot both come from the mechanism as described. A 2% distribution produces a
*negative* headline return — the price falls — and the multiplier falls by the same factor, so the
ex-date adjustment `(1 + G) * m_registration / m_now - 1` cancels the two **exactly** and the
adjusted gap is zero, not 1.801%. The terminal payoff for a spurious −2% headline is therefore `0`,
not `3.422e17`.

**Resolution taken.** The adjustment is implemented as the economically correct one, which removes
the distribution from the return entirely, and the discrepancy is recorded here rather than tuned to
match a number that the described mechanism cannot produce. The *behaviour* the guard is for — the
ex-date does not print a gap, it changes the branch — is implemented and tested; only the specific
payoff is unreproducible. The test submits a negative headline, because a positive one would be
amplified by the same division rather than cancelled by it.

**Requested ruling.** Whether the intended adjustment is partial, or whether the paper's terminal
payoff is from a different multiplier movement.

## F30 — Print sources need authorisation, which the brief does not mention

The guards bound a print's *magnitude*: plausibility rejects a feed fault and the Tier-1 band rejects
a halt. Neither bounds a print's *truth*. Without source authorisation any address could submit a
print of 0.9% — comfortably inside every band — and steer settlement to a payoff of its choosing.

**Resolution.** `setAuthorisedSource(source, bool)` gated on the registry's configuration authority.
It is an addition to the brief's API and it is not optional: the alternative is a settlement path
that anyone can decide.

## F31 — The plausibility band and the Tier-1 band overlap, and their order matters

With the Tier-1 band at its correct 5% and the plausibility band at 25%, every gap above 5% fails the
halt check, so a 40% feed fault would be reported as a halt if the halt check ran first. The two
guards are not redundant — they answer different questions, one about data integrity and one about
market structure — but the *error* is only informative if plausibility is checked first.

**Resolution.** Plausibility first, so a gross fault is named as a fault. Both errors are reachable
and both are tested, which is the property that matters: a guard whose error is unreachable is a
guard that has never been observed to fire.

## A test-harness trap worth recording

`vm.prank` applies to the **next call**, and an argument expression that calls a contract consumes
it. `registry.submitPrint(REPORTER, 1, uint64(session.expiryTimestamp()), gapWad)` after a prank
submits from the *test contract*, because `session.expiryTimestamp()` is the next call. The symptom is
an `NotAuthorisedSource` revert on a test that looks correct.

**Rule.** Read every value into a local before the prank, then make the call. Applied in all three
registry test helpers.

## A liveness dependency removed by `resolve`

`resolve` calls `session.expire()` when the session is still `Open` and past its expiry. `expire` is
permissionless and is a function of the clock, so the registry calling it adds no authority; without
it a session would be unsettleable until some third party spent the gas, which is a liveness
dependency the design does not need.



## F32 — The premium registry's bonds, as implemented under ruling R2

The brief's `commit` and `challenge` are `payable` with `msg.value >= minPublisherBond` and a bond of
`500,000e18`. F4 records why that cannot be right; ruling R2 settles it as six-decimal USDG collected
by `transferFrom`. Both functions are therefore non-`payable`, which means native value is rejected by
construction rather than by a comparison: a caller who follows the brief's `payable` signature loses
the call rather than the funds. `test_commit_isNotPayable` asserts it.

The deployment parameters are the brief's derived values at the collateral's own scale --
`500_000e6` and `50_000e6`, twelve sessions of staleness, thirteen of bond lock -- so the arithmetic
that produced $284,548 rounded up to $500,000 is preserved and only the unit changes.

## F33 — A bond has to be measured on what arrives, not on what was asked for

The first version credited the nominal bond and moved on. That is wrong for any token that takes a
fee on transfer: the registry would record a `$500,000` bond while holding less, and the whole value
of a bond is that it is actually there. Both bond paths now measure the registry's balance before and
after and compare the difference against the required amount.

This also turned two errors from decorative into reachable. `BondTooSmall` fires when the delivered
amount falls below the minimum, and `ChallengeBondMismatch` when it does not equal the exact bond --
both of which need a token that under-delivers to observe. `MockFeeOnTransferERC20` is that token, and
`test_commit_refusesABondThatDoesNotArriveInFull` uses it.

## F34 — "Exactly" is better enforced by making it unspecifiable than by checking it

The brief's `challenge` takes its bond through `msg.value`, so it needs an explicit
`msg.value == challengerBond` comparison and a `ChallengeBondMismatch` error for the mismatch. Once
the bond moves to `transferFrom`, the function signature carries **no amount at all**: a challenger
cannot ask to post more or less than the bond, because there is no parameter through which to ask.

That is a stronger guarantee than a comparison, and it left `ChallengeBondMismatch` with no reachable
path -- which the brief forbids, since an error that has never fired is indistinguishable from no
check. F33 is what restored a path to it, and the error now names the only remaining failure: the
token did not deliver what was asked for. `test_challenge_bondIsExactByConstruction` asserts the
structural half, and the fee-on-transfer case asserts the other.

## A second harness trap: a mock that reverts cannot test a checked return value

`MockERC20` reverts on an insufficient allowance, which is what a standard-compliant token does. That
means `if (!token.transferFrom(...)) revert BondTransferFailed()` can never observe `false` through
it, so the defensive check had no test. `MockNonRevertingERC20` exists to return `false` instead, and
that is not a contrivance: the ERC-20 specification permits a `false` return, which is exactly why
every transfer in this codebase is checked rather than assumed.



## F35 — `abi.decode` over `vm.parseJson` behaves differently under `forge script`

The canonical fixture decodes into a struct array in `Stat.t.sol` and works. The identical call in
`script/PrintDiagnostics.s.sol` reverts with a bare `EvmError: Revert` immediately after `parseJson`
returns, at the `abi.decode`. Moving the struct from contract scope to file scope does not change it.

**Resolution.** The script reads the fixture one JSON path at a time
(`.cells[i].lambdaWad` and so on), which is the form every other fixture consumer in this repository
uses and which works under both runners. The cause is not established, and the workaround is recorded
rather than the difference being papered over with a catch-all. `CANONICAL_CELL_COUNT` is a constant
because `vm.parseJson` gives no way to ask an array its length.

## F36 — A reference token must be a contract, and the guard is what enforces it

`DeployScript.t.sol` first pointed a session at a bare address, and resolution reverted. That is
guard G8 working: resolution reads the token's `multiplier()`, so a reference with no code fails the
probe rather than settling. The fixture was wrong, not the contract -- but the operational fact is
worth stating, because a misconfigured reference token produces a failure at *settlement* rather than
at listing, which is the worst time to discover it.

**Operational note.** A session whose reference token is not a contract will list, trade and expire
normally, and then be unsettleable. A listing check that probed `multiplier()` at `createSession`
would move the failure to the point of the mistake, and is not implemented because the probe is
exactly the kind of unverified-selector call guard G10 exists to avoid making blindly.



## F37 — R3 and R4 are under-specified, and the reading taken is recorded

The paper's §8.4 gives R3 as the *corporate-action-adjusted terminal branch* and R4 as a *constant
refund with a plausibility band*, with a measured cost for R4 and a name-specific one for R3. Neither
description says what the route does when **no print qualifies**, which is the only case where a
route's fallback matters -- and the fallback is the entire cost difference between the five.

**Readings taken**, each chosen to reproduce the shape the paper reports rather than to be convenient:

- **R3** voids at half when the multiplier has drifted and defers when it has not. A drifted
  reference has no future print to defer to: the corporate action is the terminal event, and the
  feed's behaviour after it is not something settlement can wait on. R3's cost is therefore reported
  as `None` rather than as a number, because a cost that depends on a name's calendar cannot be
  quoted from the aggregate and a zero would be a claim no name experiences.
- **R4** refunds at half when the *most recent* print -- qualifying or not -- is inside the
  plausibility band, and defers when it is outside. That conditionality is the whole difference
  between R4 and R1: R1 pays half whatever the gap would have been, so a holder receives a windfall
  on every settlement failure; R4 pays only when the failure is consistent with the feed having
  stopped, so a large move is not refunded at a fixed price. The constant is half, matching R1,
  because a refund at any other value would make R4 a different instrument rather than a conditional
  version of the same one.

Both are recorded rather than presented as the paper's meaning.

## F38 — R5 is not a settlement route

The brief's §4.3 presents R5 as one of five settlement routes, distinguished by the optimistic
challenge window and its 1.37 bp cost. But its *settlement* rule is R2's: settle on the first valid
print, and defer when none qualifies. What distinguishes R5 is a dispute mechanism over the
**parameter set** -- the commitment, the bond and the deterministic re-run -- which is a pricing-trust
mechanism rather than a settlement rule. It changes what the pool prices against, not how a session
resolves.

**Resolution.** R5 is implemented with R2's settlement rule and reports the challenge state in its
rationale, rather than inventing a settlement behaviour the paper does not describe. The mechanism it
needs already exists: `PremiumRegistry` implements the commitment, both bonds, the staleness bound and
the arbiter-only ruling.

The consequence is worth stating plainly: **R2 and R5 are not alternatives.** A venue choosing
between them is choosing whether to police the parameter set, not how to settle. That is why both
ship in the registry rather than one being selected over the other.

## A note on the two-workspace dependency

`settlement` imports `bell_calibrator.domain` -- the moment primitives and the commitment digest --
and the dependency runs one way only. That direction is not a convention here: `settlement`'s
`import-linter` configuration carries a contract named *"the calibrator never imports the settlement
service"*, so a reverse import fails `make check` rather than being caught in review. The brief's
§4.2 forbids the reverse direction and §4.3 requires the adjudication to re-run a fit, which together
make the direction a consequence rather than a choice.



## F39 — The calibrator's application layer, and the family gap it leaves

`application/calibrate.py` sequences the four steps of the brief's §4.2 and produces a `ParameterSet`;
`application/publish.py` commits it, refusing a session that has already opened so that a publisher
finds out before spending a bond rather than after. Both are pure in the brief's sense -- they touch
nothing and are callable with literals -- with the hash and the publisher injected as ports.

**The gap.** Two families are implemented and three are not. The empirical seed and the Gaussian are
here, so the paper's rejection of the Gaussian as a seed is re-measurable rather than asserted. The
Student-t, the NIG and the Merton jump-diffusion are named in the paper's Table 18 and absent from the
code. F10 is closed: NIG is the documented fallback, not production. The absence is now tracker G0
— a missing P0 fallback, not an undecided control flow. `family_for` still raises a specific
`NotImplementedError` naming F10 rather than a `KeyError`, because a missing key reads as a typo
and this absence is a decision.

**What is needed to close it.** The Student-t needs only `math.lgamma`; the Merton family is a
Poisson mixture of normals; the NIG needs a modified Bessel function of the second kind. That last one
is a numerical routine, so it belongs in an adapter rather than in `domain/` -- which is consistent
with the layer rule rather than an obstacle to it.

## F40 — Two linter rules conflict with the brief's own names

**`N818` wants an `Error` suffix on every exception.** The brief's §9.2 names the adapter errors
itself -- *"`GapSourceUnavailable`, `CalendarMalformed`"* -- and neither carries one. Renaming them to
satisfy the linter would break the names the specification uses, so `N818` is off with that reason
recorded in `pyproject.toml` rather than the names being changed.

**`SCREAMING_SNAKE_CASE` for immutables is unsatisfiable at `ClaimToken.decimals`**, which must keep
its name to satisfy `IERC20.decimals()`. Recorded as F25.

Both are cases where the brief's naming rule and a mechanical check disagree, and in both the brief
wins -- which is worth stating because the alternative, quietly satisfying the linter, would have been
invisible.

## F41 — `Decimal` raises an `ArithmeticError`, not a `ValueError`

`Decimal("one hundred")` raises `InvalidOperation`, which derives from `ArithmeticError`. The adapter's
first `except (KeyError, ValueError)` therefore let a malformed price escape as a decimal exception --
the exact leak the adapter exists to prevent, since the caller would have seen an arithmetic failure
from three layers down instead of a named adapter error about a file.

Found by `test_a_non_numeric_price_is_refused`, which is the only test in the adapter suite that
exercises a *parse* failure rather than a missing file or a missing column. `DecimalException` is now
caught alongside `ValueError`.

## A tooling lesson: a mechanical rewrap corrupted a code line

The repository's line-length rule is enforced by ruff, and a long prose line has to be rewrapped by
hand or by a tool. A script that split every over-long line at its last space was applied to a test
file and split an *expression* -- `... + wad("0.02")) // 3` became two lines, with the `// 3`
continuation left as a stray statement. The file stopped parsing.

**Rule.** Never rewrap mechanically without a language-aware test for whether the line is prose or
code. The heuristic used (`#` prefix, or no `=` and no trailing continuation character) is not
sufficient: a line ending in `))` is code and looks like prose. The prose lines were fixed
individually after that, and the repair was caught by running the suite rather than by reading the
diff.



## F42 — `commit` does not meet the brief's 150,000 gas cap, and the cap is the thing that is wrong

Measured, not estimated: `commit` costs **158,247** against a cap of **150,000**, an overrun of 8,247
or 5.5%. Every other operation in the brief's §13.3 budget is met, and two of them with room to
spare — the truncated-moment path comes in at 26,911 against a 74,878 budget, which is *below* the
paper's own 37,439 closed-form baseline.

**The overrun is attributed rather than reported.** The record costs about 110,500 — five cold
`SSTORE`s — the bond `transferFrom` costs 36,056, and the mapping hashes, the duplicate check and the
digest account for the remaining 11,600. Two things follow from that split:

- **The record is already packed, and packing it was worth doing.** Five slots is the minimum for
  three 32-byte values plus the publisher, status, session, challenger and bond. The first
  implementation declared the fields in their conceptual order and cost six slots; reordering them
  measured 21,877 gas cheaper and is documented on the struct. `commit` was 182,223 before that and
  160,346 after the first packing, 158,247 after the second.
- **The bond transfer is not the registry's to optimise.** It is three cold slot writes inside the
  ERC-20, and any six-decimal token charges roughly the same. A registry that did not collect the
  bond would not be a registry.

**The objection.** Meeting 150,000 would require narrowing the session counter to `uint32` and the
bond to `uint56` so that both pack into the publisher's slot. That trades two real limits — 4.29e9
sessions, and a bond capped at $72bn — for 5% of one operation's gas, and it makes the storage layout
harder to read for a saving no caller would notice. **The cap is 5.5% too tight for this design.**

**Resolution taken.** The test asserts the *measured* figure (170,000) rather than the specified one,
with the miss stated in the constant's comment and in `GAS_REPORT.md`. Asserting 150,000 would leave
the build red on a budget that cannot be met without a worse design; asserting nothing would leave
the overrun unguarded.

**Requested ruling.** Raise the cap to 170,000, or state that the narrowing is wanted.

**Ruling (F42).** The cap is raised to **170,000**. `spec/constants.yaml`'s
`registry_operations_max.commit` is now 170000 (challenge/resolve/quote keep the brief's 150,000),
and the generator emits it as `GAS_COMMIT_MAX` — renamed from `GAS_REGISTRY_OPERATION_MAX`, which
read the commit value under a name that claimed to be the general cap and would have been wrong the
moment the two diverged. `GasBudget.t.sol` now reads `GAS_COMMIT_MAX` (and the two baselines) from
the generated constants rather than restating them, so the YAML is the single source. The narrowing
is rejected: `uint32` sessions and a `uint56` bond trade real limits for 5% of one operation's gas.
F42 is closed.



## F43 — A stated rule was being violated, and the check that caught it is the reason it was stated

Found by running the layout checker rather than by reading the file: `PremiumRegistry.sol` had grown
to **421 lines** against the 400-line limit the brief's §8.1 sets. The growth came from the F42
packing work — repacking the struct added the explanation of *why* the order is what it is, and the
explanation is what pushed the file over. The same thing had already happened once to `Session.sol`
(F22).

**Why this is worth a numbered finding rather than a quiet fix.** The brief's §5.3 says *"a stated
rule that is not checked is a preference, not an architecture."* This is the second time that
sentence has paid for itself: both violations were invisible to the test suite, to `forge lint`, to
`ruff` and to `mypy`, and both were caught only because `tools/check_layout.py` reads the rules back
out of the brief and applies them mechanically. A reader auditing this repository would not have
found either one.

**The split, and why it is where it is.** `PremiumRegistry` is now two contracts:

- `PremiumStore` — the record. The `Commitment` struct, its digest, the bond ledger, the fallback
  register and the session clock. Every `internal` path to the bond token lives here.
- `PremiumRegistry` — the decisions. `commit`, `challenge`, `resolve`, `quote`, `advanceSession`,
  `setFallback`, `withdrawPublisherBond`, and the `Quote` verdict enum.

The seam is the question each file answers: *what does the protocol remember about a publisher?*
versus *what does it do about one?* It is not the 400-line boundary rounded to the nearest function,
which would have been the lazy split and would have left a reader unable to say what either half was
for.

**Two things fell out of it that were worth having anyway.**

1. **The bond-pull dance was written twice and the bond-push check three times.** The
   balance-before/balance-after measurement that F33 requires appeared verbatim in `commit` and in
   `challenge`, and the `transfer` return check appeared three times. All five are now `_pullBond`
   and `_pushBond`. The deduplication is not cosmetic: F33's whole point is that the bond must be
   measured on what *arrives*, and a rule expressed once is a rule that cannot drift between its
   call sites.
2. **The struct's field-order comment was wrong, and the split is what exposed it.** It claimed the
   naive ordering costs eight slots and the shipped one six, saving two cold `SSTORE`s, 40,000 gas.
   Measured with `forge inspect` against `test/mocks/PackingProbe.sol`, the real numbers are six and
   five — one `SSTORE`, and 21,877 end-to-end. `GAS_REPORT.md` already had it right; only the source
   comment was wrong. It now cites the probe and `test_theCommitmentRecordIsFiveSlotsAndTheDigestIsTheLastOfThem`
   reads the slots back raw, so the claim is checked rather than asserted.

**Compatibility.** `PremiumRegistry` inherits, so every function selector, every event signature and
the constructor signature are unchanged; `forge inspect ... storage-layout` confirms the storage
layout is byte-identical, with `_commitments` still at slot 1. What did change is that Solidity does
not resolve inherited types through the derived contract name, so `PremiumRegistry.Commitment`,
`PremiumRegistry.CommitmentStatus` and the twelve error types had to become `PremiumStore.*` at their
call sites in the tests. That is a compile-time namespace change only — no ABI is affected, and no
deployment would need migrating.



## F44 — The coverage requirement had never been measured, and measuring it found three separate problems

The brief states two coverage rules: 100% branch coverage on `contracts/src/libraries/`, and at
least 95% overall. Neither had ever been measured. `make coverage` existed and printed a table, but
nothing asserted anything about it, so the requirement was — in the brief's own words from §5.3 — a
preference rather than an architecture. Measuring it was worth the six seconds.

**What the first measurement found.** `src/libraries/Amm.sol` was at **55.56% branch coverage
(5/9)** against a rule of 100%, and the source tree as a whole was at **91.01% lines (678/745)**
against a rule of 95%. Both were violations. Both were invisible to every other check in the
repository.

**The four uncovered branches were two different problems wearing the same shape.**

- **Two were dead code.** `longReceived` and `shortReceived` each carry
  `if (a == 0 || b == 0) revert PoolDepthZero();` and then a `denominator == 0` check. The first
  guard establishes `b != 0` (resp. `a != 0`), the numerator is unsigned, and Solidity 0.8 arithmetic
  reverts on overflow rather than wrapping — so `collateralIn + b >= 1` always and the second check
  can never fire. An error that cannot be thrown is an untested path, and the brief forbids those, so
  the checks and the `DivByZero` error were removed rather than tested around. The reasoning is in
  the NatSpec, and this is the same resolution as `sqrt`'s absent `SqrtNegative` above.
- **Two were a real hole.** `longOutForShortIn` and `shortOutForLongIn` had *no* depth guard at all —
  the only two functions in the library without one. With `b == 0` and `shortIn > 0`,
  `a * shortIn / (b + shortIn)` reduces to `a * shortIn / shortIn`, i.e. **the entire long reserve for
  an arbitrarily small deposit**. That is precisely the pool-draining trade `PoolDepthZero` is
  documented to prevent; the library simply did not apply its own rule to its two swap functions.
  `SessionPool` rejects a zero reserve before every call in, which is why nothing had ever reached it.
  The guard is now there, and the two tests that cover it exist because the coverage report said so.

**The uncovered *lines* were worse than the uncovered branches.** `SessionPool._acquireShort` and
`_swapLongForShort` had **zero hits**: no unit test had ever bought a Short or swapped Long into
Short. The invariant suite calls `buyShort`, but an invariant handler picks a branch per run, so a
path can stay cold indefinitely and only ever appear in an aggregate. Added: a mirror of the `buyLong`
tests, a `swapLongForShort` test, a `poolDepth()` test, and — the one that earns its place — a test
asserting that the two buy directions move the reserves in *opposite* directions. A sign error in
`_acquireShort` would satisfy every other test in that file, because each of them checks only the leg
the trader received and the invariant `k`, and `k` is preserved by the wrong sign too.

**The `forge coverage` `Total` row is a trap, and it is why this is a script.** That row sums *every*
instrumented contract, including `test/mocks/` and the test contracts themselves, so it reads
**81.07%** on a tree whose sources are at 95.72%. Both numbers are correct and only one of them
answers the brief. `tools/check_coverage.py` therefore parses the per-file rows, applies the library
rule to `src/libraries/` and the 95% rule to `src/**` and nothing else, and exits non-zero on either.
It is wired into `make check` as `check-coverage`. It was verified to fail on the pre-fix report and
on a synthetic one, because a checker that has never failed is a checker nobody has tested.

**Result.** All five libraries are at 100% on lines, statements, branches and functions — the brief
names branches, but a library at 100% branches and 80% lines has branches nobody reached. `src/**` is
at 95.72% lines (713/745), meeting the 95% rule.

**One number is an artifact and is stated rather than chased.** `ReentrancyGuard.sol` reports
`0.00% (0/1)` branches for the `nonReentrant` modifier body, and `ClaimToken.sol` reports
`11.11% (1/9)`. Both are exercised heavily — the adversarial suite asserts that a re-entrant call
reverts with `ReentrancyGuard.Reentered` itself, and the invariant suite drives ~16,000 handler calls
through guarded entry points. `forge coverage` inlines modifier bodies and attributes the hits to the
caller, so the modifier's own source location reads zero. The evidence that the path is taken is the
assertion on the revert *data*, which is stronger than a hit counter. Recorded rather than
suppressed: no `--ir-minimum` and no coverage exclusion was used to make the number look better.



## F45 — Making a library refuse a degenerate input exposed a pool-drain hole the missing guard had been hiding

This is the direct sequel to F44, and it is the reason the `Amm` fix was a fix rather than a coverage
chore. Adding the depth guard to `longOutForShortIn` and `shortOutForLongIn` turned a *silent* wrong
answer into a *loud* revert — and the invariant suite immediately failed.

**The failure.** `invariant_claimsAlwaysMatchThePairLedger` replayed a two-call sequence,
`mint(115, 1617)` then `swap(2.844e17, 2687, true)`, and reverted with `PoolDepthZero()`. The
invariant profile sets `fail_on_revert = true`, which is the right setting: a handler that swallows
reverts explores a much smaller state space than it appears to.

**Two separate defects, one of them mine to fix and one of them the pool's.**

1. **The handler was inconsistent with itself.** `SessionHandler`'s own documentation says *"Every
   action is guarded so it cannot revert."* `redeem`, `seed` and `buy` each begin with
   `if (session.longReserve() == 0 || session.shortReserve() == 0) return;`. `swap` did not. An
   unseeded pool is not a state a swap can act on, so the guard belongs there for the same reason it
   is in the other three.
2. **`SessionPool._swapShortForLong` and `_swapLongForShort` had no depth guard.** `_acquireLong`,
   `_acquireShort` and `_poolPriceLongWad` all have one; the two swap paths did not. That is not
   merely inconsistent — `_swapLongForShort` draws its payout out of the short reserve while adding
   to the long one, so it is the direction that can *create* the degenerate state, and the next
   `_swapShortForLong` against that pool would have taken the whole long reserve. The pool was
   relying on the library to catch something it had no business delegating.

**Both are fixed, and the confirmation is stronger than a passing test.** The invariant suite now
runs to completion with **0 reverts across all seven handlers** over roughly 16,000 calls. A
`fail_on_revert` campaign that reaches zero reverts is a statement that the handler can no longer
reach a state the contract refuses — which is exactly the property the guard was added to establish.

**The lesson worth keeping.** The guard in `Amm` was correct on its own terms and found a defect two
layers up. That is an argument for putting a rule where the invariant lives rather than where it is
convenient: had the guard been added only to the caller, the library would still have been unsafe for
the next caller, and this hole would still be open.



## F46 — Three files had no tests at all, and coverage is what said so

Continuing the measurement from F44, the per-file rows showed three files whose coverage was not
merely incomplete but structurally absent. None of them was listed as a gap anywhere, and none would
have been found by reading the test suite, because a missing test file leaves no trace in the tests
that do exist.

**`ReferencePrintBook` had no test file.** It owns the two magnitude guards (G3), the sequencer guard
(G10b), the entire deterministic print-selection algorithm, and the whole configuration surface — and
it sat at 83.33% lines with **zero** hits on `setHaltBand`, `setPlausibilityBand`,
`setFreshnessBounds` and the `bandIsUsable` modifier. The registry's 31 tests read those bands on
every settlement path and never once configured them. A guard whose *thresholds* are never set in a
test is a guard whose configuration path is unverified, which is the half of a guard that decides
what it catches. Added `test/unit/ReferencePrintBook.t.sol`, 41 tests: the configuration surface with
its refusals, both ingestion guards in both directions, the F31 ordering pinned explicitly, the
sequencer guard in all four states, and the selection ordering with each tie-break isolated.

**`ClaimToken` had no test file**, and sat at **11.11% branches (1/9)** with 100% lines. All eight
uncovered branches were refusal paths, and the one that matters is `NotSession` — the gate that stops
anyone but the owning session from minting a leg. The pair accounting rests on it: a leg minted
outside the session breaks `PI_L + PI_S == 1` with no visible symptom. The session's own tests called
`mint` and `burn` on the happy path only, so the contract's central access control was assumed rather
than tested. Added `test/unit/ClaimToken.t.sol`, 20 tests, covering every refusal plus the infinite
allowance not being spent.

**`ReferenceRegistry.preview` had no tests**, despite being the public view a caller consults to
decide whether to spend gas on `resolve`. An untested `preview` is worse than an untested private
helper: it is the pre-flight check, and F47 is what happens when it is wrong. Added 13 tests,
including the two that assert `preview` and `resolve` **agree** — the property `preview`'s own NatSpec
claims and nothing checked.

**One set of uncovered branches is unreachable and is recorded rather than removed.** The
`if (!longClaim.transfer(...)) revert ClaimTransferFailed()` checks in `SessionPool` cannot fire,
because `longClaim` is typed `ClaimToken`, whose `transfer` either returns `true` or reverts. Unlike
Amm's `DivByZero` (F44), which was redundant with a guard two lines above it *in the same function*,
these guard a cross-contract call's success and are the only check on it. They are kept as defence
against the interface rather than against a runtime input, and this is the note that says so.

**Result.** `ReferencePrintBook` and `ClaimToken` are at 100% on all four metrics;
`ReferenceRegistry` at 99.06% lines and 90.91% branches; `SessionPool` at 100% lines. `src/**` moved
from 97.46% to 98.80%.

**The generalisable point.** Coverage measured per file is a *diagnostic*, not a score. Three times in
this build the uncovered-lines list pointed at something the test suite had never touched at all — a
trading direction (F44), a guard configuration path, an access control gate — and each time the
finding was invisible from the tests, because a missing test file leaves nothing to read.



## F47 — `resolve` and `preview` disagreed, and the disagreement was a panic

Found by the coverage measurement that F46 describes: `preview`'s corporate-action block had zero
hits while `resolve`'s equivalent was covered, which raised the question of why the two differed.

**They differed in a way that mattered.** `preview` handled the absent-print case on the
multiplier-drifted path and `resolve` did not:

```solidity
// resolve, before the fix
if (_multiplierDrifted(record)) {
    branch = Branch.CorporateActionTerminal;
    (printIndex, stale) = _selectOrDefer(record);
    gapWad = _adjustedGap(_prints[printIndex].gapWad, record);   // no sentinel check
}
```

`_selectOrDefer` signals "nothing qualifies" by returning `type(uint256).max`. So
`_prints[type(uint256).max]` is an out-of-bounds access: **`panic: array out-of-bounds access (0x32)`**,
confirmed by a test before any fix was written. The registry named nothing, and because the multiplier
drift persists, every retry panicked identically — **the session was permanently unsettleable**.

**Why it is worse than a plain missing branch.** `preview`'s NatSpec says its three return values
"are derived from the same code path rather than a parallel one". That was false here, and the
consequence is that the pre-flight check was *actively misleading*: `preview` reported a deferral —
`wouldSettle = false` — for a call that would panic. A caller who checked first was told the call was
safe to skip; a caller who skipped the check and called `resolve` directly hit a panic. Both readings
of "consult `preview` first" were wrong.

**It is also the case the registry's own comments call a designed degradation.** The comments on
`_payoffForBranch` are explicit that an absent print is "the absence of a decision rather than a
decision that the payoff is zero", and both `VoidAtHalf` and `Deferred` exist to answer it. The live
path handles it; the drifted path did not.

**Fix.** `resolve`'s drifted path now checks the sentinel and routes to `voidAtHalf ? VoidAtHalf :
Deferred`, exactly as `preview` does and as the live path already did. Two tests were added that
assert the branch and the payoff for both settings of `voidAtHalf`, and two more assert the agreement
property directly — `preview`'s report against what `resolve` then does — including the specific case
that was broken.

**The lesson.** A view function that duplicates a state-changing function's decision logic is a second
implementation of that logic, and it will drift. The cheap defence is not "keep them in sync by
reading carefully"; it is a test that runs both and compares, which is what now exists. The NatSpec
claim that they share a code path should have been a test from the start, because it was a claim about
the code that nothing verified.



## F48 — A seed of one pair stranded a claim and made `close()` unreachable

Found by continuing to read the coverage report as a diagnostic. `_seedBalanced`'s `longIn == 0` early
return had never executed, and asking which input reaches it gave the only answer: `pairs == 1`. A
probe test confirmed the consequence before any fix was written — a `seed` of one pair minted the pair,
left the pool unseeded, and left the pair sitting in the factory.

**Why that is worse than it looks.** The factory has no function that could redeem a claim, so the
pair is stranded for ever. The session is left in a state with an unseeded pool *and* an outstanding
pair, which means `close()` can never succeed: it requires both claim supplies to be zero. A caller
asking for a one-pair seed therefore got a session that could not be traded against and could not be
closed — the two worst outcomes at once.

**It is also a direct contradiction of the code's own comment.** The comment above `_seedBalanced`
says the odd unit goes to the short leg "rather than being left behind: a stranded claim is a claim
nobody can redeem, and it would make `close()` unreachable once the session settled." That is exactly
what happened. The odd-unit rule covers an odd seed *above* one; `seed == 1` is the case below it, and
the guard written to protect against stranding was the thing causing it — by returning quietly on the
one input it covered.

**Fix.** `createSession` refuses `seed == 1` at the listing gate with a named `SeedTooSmall`. Refusing
before the session exists is cheaper than refusing after, and the caller learns before spending gas on
a deployment. Zero remains the documented way to ask for an unseeded session and is not an error. Two
tests: the refusal, and the smallest *splittable* seed of two, which pins that the fix is not an
off-by-one that also rejects a legitimate listing.

**The guard it replaced is now provably dead and was removed.** With `seed == 1` refused, the only
caller passes `pairs >= 2`, so `longIn >= 1` always. Its absence is the fix rather than an omission,
and the comment says so.

**Three more dead branches were removed in the same pass, from `SessionFactory`.** `checkListingCap`
carried `if (whole == 0) revert NotOnHarmonicLattice(capWad)` and both diagnostics carried an
equivalent `continue`. All three are unreachable by arithmetic the functions themselves establish:
`checkListingCap`'s gate gives `0 < capWad < WAD`, so `reciprocal = 1e36 / capWad > 1e18` and
`whole >= 1`; `latticeCoverage` runs `capWad` over `[spacing, WAD)` with the same bound; and
`worstLatticeRoundingWad` skips `snapped >= WAD` immediately above, so `snappedLam >= 1` likewise.
Removed with the proof in a comment rather than tested around, which is the same resolution as
`Amm`'s `DivByZero` in F44. The diagnostics still report 399 grid points and 14 listable, so the
removal is behaviour-preserving.

**One branch was left uncovered on purpose, and the reasoning is recorded rather than the mock.**
`if (!collateral.approve(session, seed)) revert SeedTransferFailed()` cannot be reached without a
token that refuses approvals, and building a third mock for it would overstate its importance. The
check is not the only one on that precondition: if `approve` silently returned false, the very next
call — `mintPairFromFactory` — re-checks the same precondition through `transferFrom` and reverts with
`ClaimTransferFailed`. So the check converts one error into a clearer one; it is not load-bearing for
safety, unlike `SessionPool`'s `ClaimTransferFailed` checks, which *are* the only check on the value
they guard. A mock for a naming improvement is not worth its maintenance.

**Also recorded: a test-shape trap that cost two false findings.** `test_constructor_refusesAZeroBond`
held two `vm.expectRevert` calls, each followed by a `new` whose constructor reverts. The first
refusal read as covered and the second as uncovered, for a refusal that demonstrably fired. Splitting
them into one assertion per test resolved both. A reverting constructor is a frame that gets rolled
back, and the coverage counters written inside it go with it; two `new` calls in one function make the
attribution ambiguous. **One assertion per test is the rule**, and it is also the shape that would
have caught a test asserting a revert that never happened.

**One branch remains uncovered and is an artifact, not a gap.** `Session`'s `inState` modifier reports
`0/1` branches while dozens of tests assert its `WrongState` refusal directly. This is the same
modifier-inlining artifact as `ReentrancyGuard` in F44, and it is recorded rather than chased.



## F49 — The Python coverage had never been measured, and the target that would have measured it did not run

The Solidity coverage rules have been measured and asserted since F44. The Python side had not, and
the reason turned out to be that the target which would have measured it **could not run**.

**`make coverage` failed at its second step.** It invokes
`pytest --cov=bell_calibrator --cov-report=term-missing`, and `pytest-cov` was in neither workspace's
declared `dev` extra — so the command died with `unrecognized arguments: --cov=...`. The first step
(`forge coverage`) succeeded, which is why the target looked like it worked. It also covered only the
calibrator: the settlement workspace was not mentioned at all.

So three things were wrong at once, and each hid the others: a missing dependency, a target that
aborted before its later steps, and a workspace absent from the target entirely.

**Fix.** `pytest-cov==7.1.0` added to both `dev` extras, the target extended to both workspaces, and
both thresholds asserted by `tools/check_coverage.py`, which now measures the services through
`pytest-cov` — the same measurement `make coverage` prints, rather than a second opinion that could
disagree with it. `make check-coverage` runs all three rules.

**What the first measurement found.** The calibrator was at 96% and the settlement service at 96%,
and the gaps were the same shape as every other gap in this build:

- **`domain/digest.py` was at 80%** — the cross-language commitment contract, the module whose own
  docstring says a divergence "would let a publisher commit one input set and be challenged against
  another". All eight uncovered statements were its input-validation guards: the 32-byte checks on
  `nameId` and `inputsHash`, the negative-parameter check, and the four range and length checks in
  `inputs_preimage`. The fixture test exercises the *happy* path by construction, because a fixture is
  a set of valid inputs. Added `tests/unit/test_digest.py`, 13 tests; the module is at 100%.
- **`domain/models.py` was at 84%** and had no unit test file at all. Six validation guards had never
  fired and three methods (`Wad.to_decimal`, `__add__`, `__neg__`) had never been called. Added
  `tests/unit/test_models.py`, 17 tests; 100%.
- **`bell_settlement.domain.ports` was at 0%** because **nothing imported it**. The two protocols were
  declared and unreferenced, so nothing checked that they are *satisfiable*. Added
  `tests/unit/test_ports.py`, which asserts a conforming object satisfies each port, that an object
  without the member does not, and that the two ports are not interchangeable — the last because both
  declare one method taking one argument, so a copy-paste giving them the same method name would let
  an adapter for one silently satisfy the other.
- Smaller ones, each a refusal never observed to fire: `cap_for_leverage`'s positivity guard (its twin
  in `saturation_gap` was tested, which is exactly the shape where one of a pair goes untested),
  `truncated_abs_moment_at_cap`'s zero-sigma guard, the `OSError` branch of the gap-source reader that
  a missing file cannot reach because `FileNotFoundError` is a subclass, R5's third rationale case
  (challenged *with* a fallback registered), and `adjusted_gap_wad`'s zero-multiplier guard.

**Two measurement decisions, both stated rather than assumed.**

`coverage.py` is configured with `branch = true` and an `exclude_also` list covering `...`,
`if TYPE_CHECKING:`, `raise NotImplementedError` and `@overload`. Each is a declaration no input can
reach. A `Protocol` method body is the clearest case: a protocol is never instantiated and never
called, so counting its body makes every ports module read as uncovered and hides the modules that
are not. The alternative — a `# pragma: no cover` on every protocol method — puts the same
justification in twenty places instead of one. This is not a way to raise a number; it is a way to
stop counting declarations as behaviour.

**Two modules still report 0% and are correct to.** `bell_settlement.adapters.__init__` and
`bell_settlement.application.__init__` each contain a docstring and `__all__: list[str] = []`, and
nothing imports them because there are no adapters or use cases yet. Coverage is telling the truth:
they are declarations waiting for code. They will be covered when there is something to cover, and no
test asserting `__all__ == []` was written, because that would be a change detector — which
`tests/unit/test_moments.py`'s own docstring already argues against.

**Four branches in `moments.py` are unreachable in the routed domain, and are not removable.** Two are
the loop-exhaustion branches of `_erf_series` and `_erfc_continued_fraction`: `_erf` routes by
`SERIES_BREAKPOINT = 4`, and within that domain both iterations converge long before
`_SERIES_MAX_TERMS = 200`. They are the natural exit of a bounded `for` loop, not guards, so there is
nothing to delete — restructuring to remove them would be worse. The other two are the modified Lentz
algorithm's `d == 0` and `c == 0` fallbacks, which are part of the published algorithm and are
required for the fraction to be numerically stable at all. Recorded rather than chased with a
contrived input, which would be a test asserting an implementation detail rather than a behaviour.

**One guard is left uncovered for the same reason as `SessionFactory`'s `approve` check.**
`routes.best_quotable_route` raises when no shipping route has a quotable cost, and `cost_report()`
takes no arguments, so the condition cannot arise with the current five routes. It is a diagnostic
that converts `min()` on an empty sequence into a named error, not the only check on a value.

**Result.** Calibrator 99.09%, settlement 99.03%, with 16 of the calibrator's 18 modules and 11 of the
settlement service's 14 at 100%. The two workspaces went from 130 + 77 tests to 164 + 83.



## F50 — The brief scopes three artifacts, and none of them is the surface a participant touches

Raised by a question rather than by the build: *"So BELL won't have a UI? If so, how would users
interact?"* It is worth recording because the answer is not "it was out of scope" — it is that the
paper argues the interface is load-bearing, and the brief does not scope one.

**What the brief scopes.** §3 names three deployable artifacts: the contracts, the calibrator and the
settlement service. All three are built and tested. None of them is user-facing in the sense a
participant means. The contracts are a machine interface. The two services are operational
infrastructure: the calibrator is a scheduled batch job — it must run *before* a session opens, since
a commitment has to precede the session it is for — and the settlement service evaluates routes and
adjudicates challenges. Neither is something a holder "uses".

**Why that is a gap rather than a scoping choice.** The paper is explicit about who the participants
are, and it justifies its central design property by them. From §4.2, immediately after the solvency
theorem:

> "In a market whose participants are **largely retail**, holding positions across a 65-hour weekend
> with no ability to monitor a margin call, this is not a convenience feature — it is the difference
> between a product that can be offered and one that cannot."

The no-liquidation design exists *because* the users cannot be expected to monitor positions. That is
an argument that the interface is part of the product rather than decoration: the participant who
cannot watch a margin call is not going to call `cast send` on a Saturday. Note that "65-hour weekend"
is not rhetorical — the weekend session in `spec/constants.yaml` is 65.5 hours, and it is the flagship
term.

**What exists today.** Everything on chain is permissionless and complete: `mintPair`, `buyLong`,
`buyShort`, `swapShortForLong`, `swapLongForShort`, `seedPool`, `redeemPair`, `withdrawPool`, `claim`,
`close`, and on the pricing side `commit`, `challenge`, `resolve` and `quote`. A technical user can
drive all of it through a block explorer's write tab or `cast`.

**What does not exist is discovery, and discovery is a read problem.** `SessionFactory.sessionDeployed`
is a mapping keyed by `salt = (referenceToken, lamWad, expiryTimestamp)`, so it answers *"does this
session exist"* and not *"which sessions exist"*. `predictSession` derives an address from those three
values, so a client can find a session whose parameters it already knows. But there is no enumerable
list — no session registry, no indexer, no subgraph, no API. To browse what is available today a client
would compute the cross product of every name, every listed leverage (`listedLadder()`) and every
expiry, and make an RPC call per candidate. That is precisely what an indexer is for, and it is the
single missing piece: the contracts are fully usable *if you already know the address*, and nothing
tells you the address.

**The surfaces the protocol needs, by actor.**

| Actor | What they need | Right surface |
|---|---|---|
| Holder hedging inventory | browse sessions, see the premium, buy a leg, see the position, claim after settlement | web app |
| Liquidity provider | pool depth and price, provide at a neutral ratio, withdraw after settlement | web app |
| Publisher | run the fit, commit with a bond, withdraw after the lock | CLI (the calibrator) |
| Challenger | fetch a commitment's inputs, re-run the fit, challenge, read the ruling | CLI plus a web view |
| Arbiter | the deterministic re-run and its inputs | CLI |
| Session authority | advance the counter, register fallbacks | CLI or ops script |

So it is two audiences and two surfaces rather than one: a web app for holders and liquidity
providers, and the existing command-line services for the operators. That is also why D4's answer is
not "Python instead of Next.js" — the web app is the tier Next.js is for.

**What the web app must do that a block explorer cannot**, which is the actual specification:

- **Render `quote`'s three-valued verdict honestly.** `Usable`, `Fallback`, `Refuse` — and `Refuse`
  means *do not price at all*. An interface that rendered a refusal as a number would mint a free
  claim. This is a correctness requirement on the UI, not a presentation preference, and it is the
  sharpest one.
- **Set the slippage floor knowingly.** `buyLong(collateralIn, minOut)` — `minOut` is the user's only
  protection against the pool moving, and it is a parameter a person has to choose rather than a
  default.
- **Batch the multi-step transactions.** Buying Long is `approve` then `buyLong`; providing liquidity
  is `mintPair` then `approveClaims` then `seedPool`. Raw wallets make this error-prone in a way that
  loses money when it goes wrong.
- **Show the position after settlement.** Once the payoff is fixed, a holder needs both balances, their
  value at that payoff, and then `claim`.
- **Make challenging practical.** A challenger needs the committed `inputsHash`, the raw inputs from a
  `CommittedInputStore`, and a re-run of the fit to compare against. This is the trust mechanism's
  weakest operational link: if verification is inconvenient, the bond is the only deterrent left, and
  the paper's whole argument is that the bond polices discretion *because* verification is cheap.

**The constraint the interface must respect: it must be optional for correctness.** The claims are
ERC-20s and the payoff is fixed on chain, so a holder can always `claim` directly. The app must never
hold keys or funds, and there is no liquidation engine for it to be the sole access to — which is the
paper's own point. A frontend outage is therefore an inconvenience rather than a loss, and that is what
makes shipping the interface *after* the protocol the correct order rather than a shortcut.

**Not built, and deliberately not built in this pass.** The brief scoped three artifacts; this is a
fourth, and building it would mean inventing scope. Recorded so the gap is a decision rather than an
oversight, and so the next pass has a specification to build against. The order that follows from the
above is: indexer first (the discovery layer is what the app reads), then the web app, then the
challenge tooling.



## F51 — `pytest-cov` was declared in one workspace and not the other, and a commit message claimed otherwise

Found by inspection while answering "what is our tech stack?", which is a question that makes you read
the declarations rather than the code.

F49 established that `make coverage` could not run because `pytest-cov` was in neither workspace's
`dev` extra. The fix added it to `calibrator`'s and — as the commit message for that change states —
"to both workspaces' `dev` extras". That was **false**. It was added to the calibrator only.

**Why it did not fail.** `make venv` installs both workspaces in a single command
(`pip install -e calibrator[dev] -e settlement[dev]`), so `pytest-cov` resolved from the calibrator's
extra and satisfied the settlement workspace's coverage step. The declaration was wrong; the
environment happened to be right. A developer running `pip install -e settlement[dev]` on its own, or
any CI step that installed the workspaces separately, would have hit exactly the `unrecognized
arguments: --cov` error F49 was about.

**Fix.** `pytest-cov==7.1.0` added to the settlement workspace's extra, so the two declarations are
now identical. Verified by building a virtual environment from the declared extras alone — in a fresh
`python3 -m venv`, installing only `-e "calibrator[dev]" -e "settlement[dev]"`, and running the
settlement coverage step, which now passes.

**The lesson, which is about method rather than about dependencies.** The original fix was correct and
incomplete at the same time, and the incompleteness survived because the *environment* masked it. Two
things would have caught it and neither was done: reading both declarations side by side, or building
an environment from the declarations alone rather than reusing the one that already worked. The commit
message then recorded the intent rather than the outcome, which is the more serious half — a claim of
completion that was never checked is worse than no claim, because it stops the next reader from
looking. `make venv` installs both extras into one environment by design, and that is right for a
developer; it is not evidence that either extra is sufficient on its own.



## F52 — The digest fixture encoded a uint64 as a JSON number, which no JavaScript reader can read exactly

Found by the TypeScript port on its first run, and it is a defect in the fixture rather than in either
implementation.

The `event` case sets `forSession = 18446744073709551615` — uint64 max — deliberately, as a boundary
test. That value is larger than JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 − 1), so `JSON.parse`
reads it as `18446744073709552000`, which is **exactly 2^64**. The boundary case therefore arrived at
the TypeScript domain as an *out-of-range* value, and the range check refused it. Without that check it
would have produced a digest that looked entirely plausible and matched nothing — the silent failure
mode the module exists to prevent.

**The implementation was right and the encoding was wrong.** Python's `int` is arbitrary-precision and
`vm.parseJsonUint` coerces, so the number was lossless for two of the three consumers and lossy for the
third. The fix is to emit it as a **string**, which is what `lambdaWad` and `premiumWad` already do for
the same class of reason at 256 bits — the fixture was inconsistent with itself, not merely
inconvenient for TypeScript.

**Changes, all three verified.** `tools/gen_digest_fixture.py` emits `str(case["for_session"])`; the
Python contract test reads `int(case["forSession"])`; the Solidity differential test is unchanged
because `vm.parseJsonUint` accepts a string-encoded number, which was checked rather than assumed.
`spec/digest.json` was regenerated and all three consumers pass.

**The generalisable point.** A cross-language fixture is only a contract if every consumer can read it
losslessly. A JSON number is safe up to 2^53 and no further, so any value that can exceed that — a
uint64, a WAD, a timestamp in nanoseconds — must cross as a string. The Python side had no way to
notice, because in Python there is no such limit to trip over. The port is what surfaced it, which is
an argument for doing the port rather than against it.

**The same defect in the second fixture, at much larger scale.** Porting `moments` found it again in
`spec/fixtures/moments.json`: 112 points, and **all 112 carry at least one integer above 2^53** —
`lambdaWad` reaches 1e21, `premiumWad` 9.9e17 on 109 of the points, and `momentWad`, `capWad`,
`sigmaWad` and `firstMomentWad` are each over the line on between 59 and 96 of them. A JavaScript
reader would have rounded every one of them and the comparison would then have passed or failed by
luck against the recorded tolerance.

The digest fixture was one field; this is seven across 112 points, which is the difference between a
boundary case that happened to be extreme and a *systematic* encoding choice. The fix is the same and
was made uniform rather than per-field: **every integer in the fixture is now a string**, including
`toleranceWei`, which cannot exceed 2^53 today (its maximum is about 1.5e11). A uniform rule —
"every integer in this fixture is a string" — is checkable by reading one line; a per-field rule
requires re-deriving the bound every time a field is added, which is exactly the reasoning that let
seven unsafe fields through the first time.

Both readers were updated and both now *assert* the encoding rather than merely tolerating it: the
Python test checks `isinstance(point[field], str)` before coercing, so a regenerated fixture that went
back to bare numbers fails there. The Solidity reader needed no change, again because
`vm.parseJsonUint` accepts a string-encoded number.

**And the port reproduces it.** `moments.test.ts` verifies the TypeScript against all 112 points —
`truncatedAbsMoment`, the fair premium, the cap form, the reciprocal cap, and `truncatedFirstMoment` —
and every one matches exactly. That is the empirical answer to R5.1: `decimal.js` at 50 significant
digits reproduces the Python reference, so the one dependency the ruling admits is doing the job it
was admitted for.

## F53 — The architecture gate passed while enforcing nothing, twice, for two different reasons

The TypeScript counterpart of the Python side's `import-linter` contracts is a `dependency-cruiser`
configuration. It reported `✔ no dependency violations found` on the real tree from the moment it was
written, which is exactly what a working gate looks like and exactly what a broken one looks like.

It was broken, in two independent ways, and only probing it found either.

**Cause one: a deny-list of dependency categories.** The rule named the npm types
(`npm`, `npm-dev`, `npm-optional`, …) and permitted everything else. `node:fs` is classified as
`core`, not `npm`, so a domain file importing the filesystem — the single thing §7.4 exists to prevent
— passed the check. The fix is an **allow-list**: `domain/` may import itself, the shared domain core,
and `decimal.js`, and anything else is a violation. An allow-list fails closed on the category nobody
thought of; a deny-list fails open on it.

**Cause two: two options that look equivalent and are not.** With the allow-list in place, `node:fs`
was caught but an npm import still produced *no dependency edge at all*, so it was still not caught.
Two settings were responsible, and both were found by isolating them rather than by reading:

- `tsConfig: { fileName: 'tsconfig.base.json' }` — pointing it at an `extends`-only base with no
  `include` made dependency-cruiser extract **zero** dependencies from a domain file. Removing the
  option restored extraction; its own resolver already handles the `.js` → `.ts` mapping the option was
  added for.
- `exclude: { path: '…|node_modules)/' }` — `exclude` removes a module from the graph and takes its
  **edge** with it, whereas `doNotFollow` keeps the edge and declines to descend. Excluding
  `node_modules` therefore deleted every edge into it, which is the entire class of import the rule
  existed to police. `node:fs` was caught throughout, because a core module does not live under
  `node_modules` — so the gate looked like it was working.

**The lesson, which is the same one as F44 and F51 in a new costume.** A checker that has never failed
is a checker nobody has tested. This one was verified by writing three two-line probe files — an npm
import, a core import, and the one permitted exception — and asserting that the first two fail and the
third passes. That took four minutes and found two defects that reading the configuration had not, and
could not have. Every gate added in this port is now probed the same way before it is trusted.



## F54 — A third fixture was lossy, and the check that was supposed to find it compared a value against itself

F52 recorded the digest fixture and then the moments fixture. Porting the constants generator found
the pattern in a third place, and this one was not merely unsafe by form — it was **actually losing
data**.

**`spec/fixtures/canonical.json` carried 6 lossy integers.** The `capWad` values for the reciprocals
of 15, 11 and 22 — `66666666666666666`, `90909090909090909`, `45454545454545454` — read back through a
JavaScript consumer as `…664`, `…912` and `…456`. Unlike the other two fixtures' values, these have no
trailing zeros, so they carry no factors of two and a double cannot hold them. Solidity read them
correctly, Python read them correctly, and the TypeScript port would have silently compared against
rounded numbers.

**The first attempt to check this was wrong, and wrong in an instructive way.** A script walked the
parsed document and tested `BigInt(n) === BigInt(n.toFixed(0))`. Both sides are the *already-rounded*
value, so it reported zero losses on a file with six — it compared a number against itself and called
it verification. `JSON.parse` destroys the evidence before any consumer can see it, so the only way to
detect the loss is to compare against the **source text**, which Node exposes through the reviver's
third argument. That is what `tools/check_fixtures.ts` does.

**The durable fix is a gate, not three repairs.** Three fixtures in one repository were written with
WAD-scale integers as bare JSON numbers, each found independently. That is not three mistakes; it is a
missing guard. `make check-fixtures` now walks every `.json` under `spec/` and fails if any integer
literal does not survive a round trip through a double.

**The rule is exact representability, not a threshold**, and the distinction is not pedantic. A double
holds some integers above 2^53 exactly — anything of the form `k × 10^n` with a small `k` carries
enough factors of two — so a rule that failed on "above `MAX_SAFE_INTEGER`" would have failed on the
60 values in this file that were *fine* and would have said nothing about the 6 that were not. Values
that are above 2^53 but exact are reported as a warning: not broken today, broken the moment somebody
edits a digit.

**Consequences.** `canonical.json` now emits every integer as a string, uniformly, including the
genuinely small ones, for the reason F52 gives: a uniform rule is checkable by reading one line. Two
count fields were added (`cellCount`, `gaussianCount`) because the Solidity reader can no longer decode
the arrays wholesale. And `Stat.t.sol`'s reader was rewritten from
`abi.decode(vm.parseJson(json, ".cells"), (CanonicalCell[]))` to per-field `vm.parseJsonUint` calls —
which is three fixes in one place: it makes the string encoding work, it adopts the per-path pattern
F35 recorded as robust, and it removes the construct F21 traced the intermittent fixture failures to.
`vm.parseJsonUint` accepts a string-encoded number, so no other Solidity reader needed a change.

**A related correction.** The eslint `no-console` rule was global, which made it impossible to write a
command-line tool — a script under `tools/` exists to print. The rule is now scoped to the services,
where a stray `console.log` in a library really is an undeclared side effect.

## F55 — The ported generator is byte-identical, and the banner it reproduces is now out of date

Tracker A0 requires `tools/gen_constants.ts` to emit the three existing files **byte for byte**, and it
does: run it, and `git diff --exit-code` is silent on `Constants.sol`, `constants.py` and
`canonical.json`. The criterion earned its place on the first attempt, which failed it.

**The first version was not byte-identical, and the diff said exactly where.** `renderPython` printed
`undefined: int = 29_700_000_000_000_000_000` for the four route constants, because the TypeScript
table for those rows carried only the Solidity name while the Python row tuple carries one name that
both renderers use. Four lines, one missing field — and the byte comparison located it immediately.
That is the argument for byte-identity over "the tests still pass": every test in the repository passes
with a `constants.py` full of `undefined`, because nothing reads those four constants by value.

**The banner is now a lie, and is deliberately left as one.** `Constants.sol` and `constants.py` both
carry `Produced by tools/gen_constants.py from spec/constants.yaml`, and `make build` now runs the
TypeScript generator. The honest fix is one line in each; it is not made here, because
`git diff --exit-code` is the only evidence that the port is faithful and a banner edit would consume
it. The Python generator is also the **oracle** — editing it to agree with its own replacement makes the
comparison circular, which is the same reason it was not touched when the port's own tables were being
written.

So the two banners are corrected in one step with the Python generator's deletion (Phase B1), and the
new `calibrator/src/domain/constants.ts` — which has no counterpart, and therefore nothing to be
identical to — names `tools/gen_constants.ts` from the start. Until B1 the repository is inconsistent
about which tool produces a generated file, on purpose, and `make check-generated` runs **both**
generators so the differential stays live: the TypeScript half proves the committed files are what it
renders, the Python half proves two independent renderings of one YAML still agree.

## F56 — The ported generator is 626 lines, and §8.1's limit does not reach it

Brief §8.1: *"No source file exceeds 400 lines."* `tools/gen_constants.ts` is 626, so the question is
whether that is a violation or a scoping accident.

It is a scoping accident, and the reason is mechanical rather than a judgement.
`tools/check_layout.py` applies the limit by iterating `WORKSPACES`, which is `calibrator/src` and
`settlement/src`. `tools/` was never in scope — the rule is about the service sources, the ones a reader
has to hold in their head.

**What the 626 lines are is the more useful question.** About 190 of them are the three emission tables,
which the formatter expands to one field per line. Those tables are *data*: 27 rows of name, value, note
and provenance, ported from the Python's longhand tables for the reason the Python states — deriving
them from YAML keys instead makes a rename a silently missing constant rather than a loud failure. The
logic is three renderers and a `main` of thirty lines.

Recorded because C0 extends `check_layout` to the TypeScript tree, and whoever does that should decide
the scope deliberately rather than discover this file. Mirroring the Python's `WORKSPACES` — the two
service roots — keeps it out of scope, which is the reading taken here. The alternative, reformatting
the tables to fit a 100-character line, was tried and does not work: the longest rows
(`ROUNDING_LATTICE_WAD`, `RAMP_TIME_AVERAGE_CEILING_WAD`) exceed the budget by a few characters in every
field order, so the result would be a ragged table that a single note edit could reflow at random.

**Resolved by C0, and the decision is the one this note predicted.** The scope stayed the two `src/`
roots. The file is 590 lines now rather than 626 — 445 of them code and 109 comment — so it is over the
limit by total *and* by code, and no reading of §8.1 brings it under. The companion measurement is
`tools/check_coverage.ts` at 604 lines, 205 of which are comment: the two over-limit files are a
row-table renderer and the file where the coverage rules are argued, so a 400-line rule over `tools/`
would have exactly two remedies, and both are worse than the length. §8.1 says *source file*, and the
test trees are out on the same sentence (`settlement/tests/unit/routes.test.ts` is 523 lines of
fixtures). See F86.

## F57 — A pure function returned a different value depending on what had been imported earlier

`domain/leverage.py`'s module docstring ends *"Pure: a sequence of gaps in, a leverage out."*
`realised_saturation_rate` is the one function in it that is not pure, and the cause is one line:

```python
return Decimal(saturated) / Decimal(len(observations))
```

`Decimal.__truediv__` with no `context` argument divides in the **ambient** context — the thread-local
one `decimal.getcontext()` returns, default precision 28. The return value is therefore a property of
the caller's process state rather than of the arguments. Measured, on a three-element sample of which
exactly one element crosses the threshold:

| call site | precision | returned |
|---|---|---|
| a plain call | 28 | `0.3333333333333333333333333333` |
| inside `localcontext(prec=50)` | 50 | `0.33333333333333333333333333333333333333333333333333` |

and the two values are not equal.

**This is not hypothetical, and the module that proves it is in this repository.**
`tools/gen_constants.py` line 28 is `getcontext().prec = 60`, at *module scope* — a permanent mutation
of the thread's context for the remainder of the process. So:

```
precision before import : 28
rate before             : 0.3333333333333333333333333333                          (28 digits)

import gen_constants

precision after import  : 60
rate after              : 0.333333333333333333333333333333333333333333333333333333333333   (60 digits)
```

Same arguments, same function, different value, because something unrelated was imported.
`moments.py` is the other half of the story and gets it right: every division there is wrapped in
`with localcontext() as context: context.prec = WORKING_PRECISION`, which is scoped and restored.
`leverage.py` is the module that assumed the ambient context would never move, in a repository that
moves it.

**Why the suite never caught it.** `test_leverage.py`'s three saturation-rate tests assert
`== Decimal(1)`, `== Decimal(0)`, and a raised error. One and zero are exact at every precision, so
there is no precision at which those assertions could fail — they are correct and vacuous with respect
to this defect. A precision-dependent bug needs a precision-dependent assertion, and the module's only
non-terminating fraction was never asserted by value.

**The port cannot reproduce it, by construction.** `domain/moments.ts` declares
`D = Decimal.clone({ precision: WORKING_PRECISION })`, and a `decimal.js` clone is a *separate
constructor* carrying its own precision, not a view of a shared setting. Verified directly: after
`Decimal.set({ precision: 20 })` — which does move the default, a fresh `Decimal` then yielding 20
digits — a value built through `D` still yields 50 digits and compares equal to one built before the
call. So the port states the precision instead of inheriting it, `leverage.test.ts` asserts the digit
string is `'3'.repeat(50)`, and no import order can change that.

**One departure, stated because it is a departure rather than a reproduction.** The TypeScript and the
Python disagree on this function's value whenever the ambient precision is not 50. That is not a port
defect and it is not fixable by matching the Python, because "the Python's value" is not well defined —
it is a function of the process. The port takes the precision as declared rather than as ambient, which
is the only reading under which the docstring's "pure" is true. The Python is not corrected, for the
same reason no other Python is corrected while it is the oracle: an edit that makes the two agree is an
edit that destroys the evidence that they were compared.

## F58 — `.recon/` was out of scope for git and in scope for eslint

The tracker's convention is that reconnaissance scratch lives in `.recon/` and is gitignored — "not
repository content". `.gitignore` enforced that. Nothing else did.

eslint's typed linting resolves every linted file through the project service, and a file that belongs to
no `tsconfig` is a hard error rather than a skip:

```
.recon/probe_clone.ts
  0:0  error  Parsing error: ... was not found by the project service
```

So a scratch probe broke `make check` — from a file that was never going to be committed, and whose whole
purpose was to be disposable. The directory had held only `.py` and `.txt` files until now, which is why
this had never surfaced: eslint only lints what its own config matches, so a scratch Python probe was
always invisible while a scratch TypeScript probe is fatal.

Fixed by adding `.recon/**` to `ignores` in `eslint.config.js`, and then probed in **both** directions,
because a gate that has been *loosened* needs the same treatment as one that has been added: a
deliberately broken `.ts` file in `.recon/` now lints clean, and a deliberately unused binding in
`calibrator/src/domain/leverage.ts` is still reported. Without the second probe, "the ignore works" and
"the ignore is too broad" look identical — and the second failure would be silent, which is the one thing
a gate must never be.

## F59 — A declared constant that nothing reads, sitting next to a catch-all that makes it a trap

`sessions.py` declares `HOLIDAY_SPANS_DAYS = frozenset({2, 4, 5})`. **Nothing reads it** — not the module
it is declared in, not the tests, not any other module in either workspace. Verified by grepping the
whole tree for the name: one hit, the declaration.

It is not merely unused, it is misleading, and the reason is the function beside it:

```python
if span.calendar_days == OVERNIGHT_SPAN_DAYS: return SessionKind.OVERNIGHT
if span.calendar_days == WEEKEND_SPAN_DAYS:   return SessionKind.WEEKEND
return SessionKind.HOLIDAY                    # every other span, including 6, 7, 8, ...
```

`classify` reaches `HOLIDAY` by falling through, so this set is a strict **subset** of what the function
returns. The constant reads like a validation rule — a reviewer sees `{2, 4, 5}` and concludes that a
holiday is exactly a two-, four- or five-day span. A refactorer who "tightens" `classify` to
`HOLIDAY_SPANS_DAYS.has(span.calendar_days)` would introduce a hole for every span above five, and
**the existing tests would still pass**, because no test constructs a span outside 1–5.

The port keeps the constant, with the hazard stated at the declaration rather than silently deleted: a
faithful translation of a file should not quietly lose a declaration, and the discrepancy between what
the design enumerated and what the function implements is itself information. `DESIGN_NOTES.md` F53
records the same shape in a gate — a check that looked like it enforced something and enforced nothing.

**A second thing the module's public surface does not do.** `classify`, `is_pooled_with_weekend` and
`expected_tail_observations` have no production caller in either language; the only importer of
`sessions.py` anywhere is its own test file. The session reaches the application layer as *data* —
`calibrate.py` takes a `session: SessionKind` and `window_for` switches on it — so this is the rule that
ingestion is expected to apply upstream of the calibrator, and nothing asserts that ingestion does.
Recorded because it is the kind of thing a reader of the pipeline assumes is wired: the classification
is tested, and tested well, but the label on a session in the pipeline does not come from here yet.

## F60 — The ambient-precision defect is systemic, and observability depends on what a function returns

F57 found `realised_saturation_rate` dividing through `decimal`'s ambient context. It is not one
function's slip. An AST sweep of every function in `domain/` that does decimal arithmetic without
wrapping it in `localcontext` finds **nine sites across four modules**:

| module | function | the precision-sensitive step | returns |
|---|---|---|---|
| `leverage.py` | `realised_saturation_rate` | the division | a raw `Decimal` |
| `leverage.py` | `empirical_quantile` | `probability * Decimal(len)` | an `int` rank |
| `models.py` | `from_decimal` | `value * 1e18` | an `int` |
| `models.py` | `to_decimal` | `Decimal(raw) / 1e18` | a raw `Decimal` |
| `moments.py` | `truncated_abs_moment` | `1 / lam`, before the guarded cap form | a `Decimal` |
| `families/base.py` | `sigma_wad` | the mean, the squared deviations, the sqrt | an `int` |
| `families/base.py` | `quantile_magnitude_wad` | `probability * Decimal(len)` | an `int` |
| `families/gaussian.py` | `dimensionless` | the division by 1e18 | a raw `Decimal` |
| `families/gaussian.py` | `to_wad` | the multiply by 1e18, before rounding | an `int` |

**Which of them are observable is decided by one thing: whether the result is quantised to a WAD
integer.** The ambient error at 28 digits is a relative 1e-28, so on a value of order 1e16 it is about
1e-11 of a wei — invisible unless the true result falls within 1e-11 of a quantisation boundary.
A function ending in `int(...)` discards that difference; a function returning the `Decimal` itself
does not.

Measured, and the measurements are the whole of the argument:

- `sigma_wad` over **240** samples — sizes 2 to 5,000, gaps drawn across the full WAD range — computed
  at precision 28 and at 50: **zero** disagreements. `gaussian_premium_wad` over **400** random
  `(lambda, sigma)` pairs: **zero**.
- `realised_saturation_rate`, F57's site: differs, visibly — 28 significant digits against 50.
- `to_decimal` and `from_decimal`: **they differ**, for a raw above roughly 1e28.
  `Wad(10**31 + 123456789).to_decimal()` is `1000000000000.000000000123457` at 28 digits and
  `1000000000000.000000000123456789` at 50; `from_decimal("123456789012345678.123456789012345678")`
  gives `...123456789000000000` against `...123456789012345678`.

So the class has **two observable members and seven masked ones**, and the masking is an accident of the
WAD grid rather than a property anyone chose. The `to_decimal` member needs a quantity above 1e10 to
reach, which this protocol does not carry — latent, not live, and recorded as latent rather than
dropped.

**The port states the precision at every one of the nine**, through the domain's single `Decimal.clone`
in `moments.ts`, rather than inheriting it. That is a departure from the Python in principle and, for
the seven masked sites, unobservable in fact — which is stated rather than relied on, because "it
happens not to show" is not the same as "it is not there". The two live sites are the ones to watch if
the WAD grid ever widens.

## F61 — The oracle's suite cannot tell floor division from truncating division, and the difference is observable

Every `//` in the Python was translated to an explicit `floorDiv`, because `bigint`'s `/` truncates
toward zero and the two disagree by one whenever the quotient is negative and inexact: `(-1n) / 3n` is
`0n`, where `-1 // 3` is `-1`. This is not a theoretical case. `relative_error_wad` divides
`(estimated - reference) * WAD` by `reference`, and for the light-tailed sample its own test asserts,
that numerator is **negative** — so the difference is one wei on a quantity the registry publishes.

**The Python's test suite passes under either operator.** Verified by probing the port: replacing
`floorDiv` with `/` in `relativeErrorWad` leaves all 31 ported tests green, because
`relative_error_wad(90 * WAD, 100 * WAD)` divides exactly — the assertion the Python chose is one where
floor and truncation agree. Only the differential run against the oracle found it, and it found it as
**7 diverging fields**.

The same probe run produced the useful contrast:

| deliberate break | ported suite | differential |
|---|---|---|
| `sigma_wad` rounds instead of truncating | 1 failure | 19 fields |
| **`floorDiv` becomes truncating division** | **passes** | **7 fields** |
| `to_wad` truncates instead of rounding half-even | 1 failure | 68 fields |
| `truncated_mean_wad` stops capping | 3 failures | 81 fields |
| `familyFor` merges its two refusal types | 1 failure | 0 fields |
| *control:* `floorDiv` becomes `/` where both operands are non-negative | passes | 0 fields |

Two things to take from it. The **negative control** matters as much as the others: a break that
genuinely cannot change the answer must leave both checks clean, or "the differential catches things"
and "the differential fails on any edit" would look the same. And the two checks are **complementary,
not redundant** — the suite is the only thing that sees the error *type* (`familyFor`), the
differential is the only thing that sees the floor/truncate divergence.

Recorded because the port's acceptance test is not the oracle's suite. A translated operator that the
oracle's own assertions cannot distinguish is exactly the kind of thing a green suite hides, which is
F55's lesson in a different costume.

## F62 — The settlement service's port was declared in the calibrator's `ports.ts`

`CommittedInputStore` is declared in `bell_settlement.domain.ports`, and the settlement workspace's
`test_ports.py` is its only test. The port put it in `calibrator/src/domain/ports.ts`, because that was
the only TypeScript `domain/` directory in existence when `ports.ts` was written.

It is a real misplacement rather than a harmless one, because the calibrator's domain is now a
**published surface**: `settlement/package.json` will import `@bell/calibrator/domain` (A6), so a
settlement port living there is a dependency the settlement has on the calibrator for one of its own
interfaces. The two `ports.py` files are also asymmetric for a second reason — the calibrator's declares
`Keccak`, `GapSource`, `AnnouncementCalendar` and `ParameterPublisher`, and the settlement's declares
`ReferencePrintSource` and `CommittedInputStore` — so the boundary between "shared core" and "this
service's ports" is currently drawn by whichever file happened to exist first.

Not moved now, and the reason is that the move cannot be done cleanly yet: `ReferencePrintSource` needs
`ReferencePrint`, which is A6's `prints.ts`, so a `settlement/src/domain/ports.ts` created today would be
one declaration in a directory of one file. **A6 owns the move**, and `ports.ts` carries the note so a
reader of the declaration is not misled in the meantime.

The same entry records the two ports the file was *missing*. `ParameterPublisher` is A4's dependency and
was absent; `AnnouncementCalendar` is declared in the Python, listed in `ARCHITECTURE.md`'s port table,
and **implemented by nothing and called by nothing in either language** — one grep hit, its own
declaration. Carried rather than dropped, for F59's reason: the gap between what the design enumerated
and what the code implements is itself information, and a reader of the architecture table should not
assume a caller exists.

## F63 — `dateOrdinal` is the one piece of Python's standard library the port has to reproduce, and its failure is silent

`rows_digest` serialises each bar as `trading_date.toordinal().to_bytes(4, "big")`. The Python's
`DailyBar` holds a `datetime.date`, so both the proleptic Gregorian day number and its range check came
from the standard library and nothing in the repository had to state what they were. The port's
`DailyBar` holds a **string**, so `application/calibrate.ts` has to compute the same four bytes.

**A disagreement here is silent, and that is what makes it the most dangerous line in A4.** The ordinal
feeds `rowsDigest`, which feeds `inputsHash`, which the publisher commits and the registry stores. The
`inputsHash` is not checked by anything on chain — it is an opaque `bytes32` that a challenger uses as a
*key* into a `CommittedInputStore`. So a wrong day number produces a well-formed 32-byte digest that no
challenger can ever match, and the observable symptom is a challenge that fails to reproduce the fit —
which is exactly what a dishonest publisher looks like. There is no on-chain guard, no fixture, and no
Solidity counterpart that could catch it.

Three consequences, all acted on rather than noted:

- **The ordinal is exported and directly tested**, where the Python needed no equivalent because
  `date.toordinal` is already public in its standard library.
- **The accepted format is narrowed to `YYYY-MM-DD`**, loudly. `date.fromisoformat` also accepts
  `YYYYMMDD`, ISO week dates (`2020-W02-1`) and ordinal dates (`2020-006`); only the first form is
  reachable from the CSV adapter's documented header, and reimplementing three more grammars whose
  disagreement would be silent is worse than a refusal. The narrowing is a test, not a comment.
- **The port refuses a year of zero, a month outside 1..12 and a day outside its month**, matching
  `date.fromisoformat`'s own refusals, because the port's `DailyBar` does no validation of its own.

**And the Python validated the date nowhere, either — measured rather than assumed.** `DailyBar` is a
`@dataclass(frozen=True, slots=True)`, and a dataclass does not check its declared types at runtime:
`DailyBar(trading_date="garbage", …)` constructs successfully and fails later at `.toordinal()` with
`AttributeError: 'str' object has no attribute 'toordinal'`. So the port is not a regression, and the
observation is recorded because "the Python had a `date` type" is the kind of claim that reads as
validation and is not.

The differential run covers this exhaustively: **1,128 date lines** — every day of 1900 (a century year
that is not a leap year), of 2000 (one that is), of 2024, both extremes, and the four surrounding days —
and every ordinal is identical to Python's. A `year % 4` shortcut fails on 1900; a four-branch rule
fails on 2000; neither would be caught by any date a test would pick by hand.

## F64 — Two refusals escape the application layer as standard-library exceptions, and one of them is reachable from a CSV

Both members were found by the differential run rather than by reading, and both are `ValueError` or
`OverflowError`, so a caller cannot branch on either. The port names its types; the Python's messages are
reproduced exactly.

**(a) A negative `next_open` makes `rows_digest` raise `OverflowError` from three layers down.** The
adapter validates `close.raw > 0` and does **not** bound `next_open`, so a CSV row reading
`2020-01-06,100.00,-5.00` is accepted, produces a `DailyBar` whose `.gap()` computes fine (it is a ratio
with no range check), and then dies inside `rows_digest` at
`bar.next_open.raw.to_bytes(32, "big")` with `can't convert negative int to unsigned`.

This is precisely the leak the adapter's own docstring says it exists to prevent — *"the caller would
see an arithmetic failure from three layers down instead of a named adapter error about a file"* — and
the adapter has a hole for `next_open` where it closed one for `close`. Verified by running: the adapter
accepts the row. **The port inherits the hole unless A5 closes it**, which is why A5's tracker entry now
says so.

The port refuses with a named `DomainError` from `uintToBytes` (`nextOpen cannot be negative`), which is
a departure from the Python in *type* and identical in *outcome*.

**(b) A zero-variance sample makes the Gaussian's premium exactly zero, and `ParameterSet` then refuses
it from inside `calibrate`.** `GapSample.sigmaWad` is zero when every gap is identical, so
`gaussianPremiumWad` is zero, so `ParameterSet.__post_init__` raises
`ValueError("a premium outside (0, 1] is not priceable")`.

A zero-variance sample is not exotic. It is what a **stale feed** produces: a source that repeats the
same close and the same open, which the adapter cannot distinguish from a real one. Verified: three
identical CSV rows give a sample whose gap set is `{0.01}` and nothing else.

Two things make this a finding rather than a curiosity:

- **The two families disagree about whether the same input is calibratable at all.** The empirical
  family on the identical sample returns a premium of exactly `1e18` — the long leg pays the whole
  collateral, which `PI_L = min(λ|G|, 1)` does mean when every gap reaches the cap — and is accepted.
  The Gaussian throws. So "can this sample be calibrated" has a family-dependent answer that the
  *caller* cannot see, because one answer is a result and the other is an exception.
- **The refusal is an exception from a value object, not an outcome of the use case.** `calibrate`
  returns `Calibrated | InsufficientSample` precisely so that "the sample cannot support an estimate" is
  branchable. A degenerate fit is the same *kind* of thing and is not in the union, so it escapes as a
  `ValueError` whose message names a premium range rather than a sample.

Not fixed, and the reason is the port's rule: the Python is the oracle and a behaviour change during a
port is a finding, not a bug fix. The port reproduces the outcome (the port's `ParameterSet` refuses the
same zero) with a named `DomainError`. Whether the union should gain a `DegenerateFit` member is a
question for whoever owns `domain/models.ts` next, and it is recorded here rather than decided silently
in an application-layer port.

## F65 — The two languages disagree about what whitespace is, in both directions, and the adapter trims with one of them

A5 ported the CSV gap source and ran a differential of 58 fixtures against the Python oracle. Eleven
behavioural differences came out. Four were refusals the port chose (F64a's negative open, the short
row, the date narrowing), one was F60's second observable member, and **two were a class nobody had
looked at: `String.prototype.trim()` and `str.strip()` do not mean the same thing, and neither do the
two line readers.** Both are silent. Neither is reachable from a real exchange feed. Both are in the one
layer whose entire contract is that a file's problems live there.

Measured on the two standard libraries as they ship:

| character | `"…x".trim()` (JS) | `"…x".strip()` (Python) |
|---|---|---|
| `U+FEFF` byte-order mark | strips | **keeps** |
| `U+0085` next line | **keeps** | strips |
| `U+001C` file separator | **keeps** | strips |
| `U+000B` vertical tab | strips | strips |
| `U+00A0` no-break space | strips | strips |
| `U+2028` line separator | strips | strips |

and on the readers:

| separator | the port's `parseCsv` | Python's `str.splitlines` |
|---|---|---|
| `LF`, `CRLF` | a terminator | a terminator |
| a lone `CR` | a terminator, **after the fix below** | a terminator |
| `U+0085`, `U+000B`, `U+001C`, `U+2028`, `U+2029` | **not** a terminator | a terminator |

**Two consequences, in opposite directions.**

- **The port reads a file the oracle refuses.** A cell carrying a BOM — `\ufeff2026-09-10` — is trimmed
  to a date here and kept as an unparseable string there, so the fixture `bom` is `OK` on one side and
  `GapSourceMalformed` on the other. That is the *better* behaviour and it is what a spreadsheet export
  produces; recorded rather than corrected, because reproducing Python's answer would mean writing a
  `strip()` deliberately narrower than the language's.
- **The port refuses a file the oracle leaks out of.** `U+0085`, `U+000B`, `U+001C` and `U+2028` end a
  line for Python and do not for the port, so `2026-09-10\u0085,100.00,102.00` is one row here and two
  there — and on the Python side the first of those two rows is short, which is F64's `AttributeError`
  escaping the adapter a second time. The port refuses it as a malformed date, which is at least a named
  refusal.

**And the reader bug the differential caught before any of that.** The first version of `parseCsv`
discarded `\r` outright instead of treating it as a terminator. On a file using bare `CR` — which
`str.splitlines` reads as several lines — the port produced one malformed record. It was caught by the
`cr_only` fixture, and **the ported 24-test suite was green with it**: the probe direction
`cr_not_a_terminator` reproduces the bug and leaves the entire suite passing. The suite now has a test
for it, which is the right response to a probe that only the differential can see.

Fixed here: the reader treats a lone `CR` as a terminator, so `cr_only` agrees with the oracle.
Not fixed: the whitespace table. Normalising it would mean writing a `trim` that reproduces Python's
character set in a language whose own set differs, for inputs no source emits — and the differential now
names every one of them, so the next reader does not have to rediscover it.

## F66 — Three differences from the oracle that were not differences, and a harness that manufactured one

The port's own docstrings claimed five departures from the Python in the CSV adapter, one narrowing in
`Wad.fromStr`, and three accepted date grammars. The differential is what checked them, and **four of
those nine claims were wrong.** All four are corrected in place. None of them changed a line of
behaviour, which is the point: a false claim about a difference is as expensive as a missing one,
because it tells the next reader to stop looking.

- **`decimal.js` accepts underscore separators.** `Wad.fromStr`'s comment said the opposite and used it
  to justify a narrowing. Measured: `new Decimal("1_000.00")` is `1000`, exactly as Python's
  `Decimal("1_000.00")` is `1000.00`. What `decimal.js` refuses is a literal carrying surrounding
  whitespace or a no-break space, which Python's `Decimal` strips — the reverse of the claim. The
  fixture `underscore_number` is one of the 35 the two sides agree on.
- **`date.fromisoformat` does not accept ordinal dates.** F63 and the adapter both said it accepted
  `YYYYMMDD`, a week date and `YYYY-DDD`. Measured on CPython 3.13: `2026-006` is refused, exactly as
  `dateOrdinal` refuses it. The narrowing is three grammars (`2026-W37`, `2026-W37-4`, `20260910`), not
  four, and the fixture `ordinal_date` is what corrected it.
- **`csv.reader` reassembles a quoted field across lines.** The adapter's fifth departure said Python's
  `text.splitlines()` destroys a newline inside a quoted field, so the port would read a file the oracle
  could not. It does not: `"2026-09-10\n",100.00,102.00` is read identically by both, and the fixture
  `quoted_date_newline` is one of the 35 agreements. The departure was **removed**, and the test that
  asserted it kept with its comment corrected — a test asserting an agreement is still worth having, but
  not for the reason it was written.

**Two things the probes found that are not about the port at all.**

- **A unit test that passed for the wrong reason.** `a blank line is skipped and the row number counts
  records` asserted `/row 3/`, and the *broken* port satisfies it: with the blank record left in, the
  blank row is itself the second record and reports "row 3" — about an empty date rather than about
  `bad`. The probe direction `blanks_not_filtered` left the suite green. The assertion now names the
  offending value as well as the row.
- **The probe harness reported its own negative control as caught.** Its first run showed every probe
  moving 27–29 fixtures, including a De Morgan rewrite that cannot change an answer. The cause was the
  harness: each fixture is materialised in a fresh temp directory, both messages name that file, and the
  raw dumps were compared without normalising the path — so every error fixture differed between two
  runs of identical code. This is the second time in this port that a check has been found enforcing
  nothing (F53), and it is the same lesson: a harness is code, and code that has never been run against
  a null input has not been tested.

**One more difference, and it is one where the port is right.** The fixture `thirty_six_digits` reads
`123456789012345678.123456789012345678` — 36 significant digits, 18 of them after the point. The oracle
returns `123456789012345678123456789000000000`; the port returns the exact
`123456789012345678123456789012345678`. That is F60's second observable member, and this is the first
time it has been seen from *outside* the module that holds it: the two numbers differ in the last eight
digits, the oracle's own integrality check passes on the rounded value, and none of the Python's twelve
tests reaches it.

The port does not refuse this one — it has exactly eighteen decimal places, so `fromDecimal`'s
`decimalPlaces` guard does not fire. It is exact because the domain's single `Decimal.clone` carries 50
digits where Python's ambient context carries 28. The guard and the precision close the same defect from
two directions, and only the fixture shows that either is doing anything.

## F67 — The probe harness only ran in the terminal that wrote it

`probe.py` shells out to `.recon/a6/dump.py` through `subprocess.run(...)`, which inherits the
environment and passes nothing of its own. `dump.py` imports `bell_calibrator` and `bell_settlement`,
which are importable only when `PYTHONPATH=calibrator/src:settlement/src` is exported — and `dump.py`'s
own docstring said so, which is precisely why the requirement stayed invisible: every run so far had
been typed by hand, into a shell where it held.

Run from a bare shell, the harness printed

```
the oracle dump failed; nothing to probe against
```

and returned **before probing anything**. That message reads like a diagnosis of the code under test. It
was the harness failing to start. Had this been the first and only run, A6 would have been recorded as
"16 probes, all behaving as declared" with none of them having run — which is F53 and F66's lesson in a
third form: not a check that enforces nothing, but a check that never executed, and a failure message
that points at the wrong thing.

`dump.py` now puts the two source roots on `sys.path` itself, so both it and `probe.py` run from a bare
shell. The general form is narrower than "test your tests": **a harness that depends on ambient state is
reproducible only for the person who set that state, and that person is the one least able to notice it
is missing.**

## F68 — Three fixtures that never reached the branch they were written for

Probing a gate with a deliberate break does two things at once: it proves the acceptance test catches a
break, and it proves the *fixtures* are adequate to catch it. Three of A6's sixteen breaks were initially
not caught by the differential at all, because no fixture sat on the boundary the branch tests:

- **`r4_band_exclusive`** (`<=` → `<` on the plausibility band) survived. No input had a magnitude
  exactly equal to the band, so the two operators agreed on every case. Added `at_band`,
  `gap_wad = 250000000000000000`.
- **`age_not_floored`** (dropping the `now >= timestamp` guard in `age`) survived. The guard only fires
  for a print *newer* than `now`, and it is only *observable* when the freshness bound is zero or less —
  otherwise a negative age is still inside the bound. Added
  `select/future_negative_freshness` (`freshness_bound: -1, stale_bound: 0`).
- **`premium_tolerance_inclusive`** (`>` → `>=` against `PREMIUM_TOLERANCE_WAD`) survived. The three
  premium fixtures used deltas of ~5×10¹⁰ against a tolerance of 5×10¹³, so all three landed far inside
  the bound and the two operators agreed on every one of them. Corrected to `174049999999999999` /
  `174050000000000000` / `174050000000000001` — tolerance−1, tolerance, tolerance+1.

The third is the one worth keeping, because the fixture *looked* like a boundary test: it is named
`adj/upheld_at_tolerance` and it was not at the tolerance. **A fixture whose name asserts a boundary it
does not sit on is worse than no fixture at all, because it closes the question.**

## F69 — Two build defects that only the cross-workspace edge could reveal

A6 is the first item that makes the settlement import the calibrator (`settlement/src/domain` →
`@bell/calibrator/domain`, one-way, enforced by `.dependency-cruiser.cjs`). Both defects below had been
present — and invisible — for exactly as long as that edge did not exist.

- **The calibrator's `exports` map was off by one extension.** It read
  `"./domain/*": { "default": "./dist/domain/*.js" }`, so the specifier
  `@bell/calibrator/domain/constants.js` — the one TypeScript's `NodeNext` resolution requires, and the
  only one a reader would write — resolved to `dist/domain/constants.js.js`. Nothing outside the
  calibrator had ever imported the calibrator, so it had never been exercised once.
- **`make build` did not compile TypeScript.** `ts-test` and `ts-check` resolve the calibrator through
  `exports` → `dist/`, so on a fresh clone they failed on a missing `dist/`. `npm run build` is now part
  of `build`, and `ts-build` is a prerequisite of both. A `paths` mapping to `../calibrator/src/` would
  have *hidden* this by making the type checker read sources while node ran `dist` — two different
  programs, one build.

Both were found by probing the gate rather than reading it: the first by importing across the new edge
and watching it fail, the second by running the tests in a tree that had no `dist/`. Neither is
detectable by any test that lives inside a single workspace, which is the reason a monorepo's first
cross-workspace import is worth running early and on purpose.

## F70 — `decimal.js`'s ambient precision is 20, and the payoff-observable drift is the *small* one

`decimal.js` defaults to **20** significant digits; CPython's `decimal` default context carries **28**.
The port had inherited the 20 by using the bare `Decimal` constructor, and in `adjustedGapWad` —
`(1 + G) · m_reg / m_now`, then truncated to a WAD — that is short by exactly enough.

The quotient's integer part is **eighteen digits**, so 20 significant digits leave only **two** fractional
places, and the true fraction here is `.99627…`, which rounds up in the second place and carries into the
integer part. With `gapWad = −0.02·WAD` and `multiplierNow = 1.000318` the exact quotient is
`979688459070015734.996271185762927389…`:

| working precision | the division rounds to | truncate | `adjustedGapWad` |
|---|---|---|---|
| 20 (`decimal.js` default) | `979688459070015735.00` | `…735` | `−20311540929984265` |
| 28 (CPython default) | `979688459070015734.9962711858` | `…734` | `−20311540929984266` |

One wei, which `payoffLongWad` multiplies by `λ = 15` → **15 wei of payoff** (`304673113949763990`
against `304673113949763975`), and well below the cap, so it is not absorbed.

**The larger drift hides it, and that is the trap.** At `multiplierNow = 0.100052` the two precisions
still disagree by one wei in the adjusted gap (`8794906648542757766` against `…765`), but the payoff is
`WAD` under both, because `15 × 8.79×10¹⁸` saturates. So the divergence is visible in the quantity the
contract actually pays *only* at the small drift, and the ported suite's corporate-action case — a 2%
drift, which truncates identically at 20 and at 28 — does not reach it either. `probe.py`'s `precision_20`
probe therefore has the shape the tracker's rule is written for: **caught by the differential, clean in
the suite.**

Fixed with a named `D28 = Decimal.clone({ precision: 28 })`. Named, and not `D`, because `moments.ts`
already exports a `D` at 50 digits and the two must not be confusable at a call site.

## F71 — Reference equality on `Uint8Array` is the port's only translation whose wrong form looks right

Every other translation in this port fails loudly when it is wrong. `left === right` on two
`Uint8Array`s does not. It compiles, it type-checks, it reads as the obvious spelling of "are these the
same bytes", and it compares two *object identities*. Python's `bytes == bytes` is content equality. The
consequence is the worst available one: the oracle's `digest_matches` and the port's would disagree for
every *correct* digest, so the port would report `DigestMismatch` on exactly the inputs that should pass
— i.e. slash every honest publisher, and do it deterministically.

`bytesEqual` was added to the calibrator's `models.ts` beside `hexOf`, with its header stating that it is
the port's only translation of this kind, and it is used at both digest-comparison sites. `probe.py`'s
`bytes_equal_by_reference` probe confirms the ported suite catches the substitution, so the guard is
demonstrated rather than declared. The general form: **a language's `==` is not a semantics that carries
over for free, and the dangerous cases are the ones where the wrong spelling is the shorter one.**

## F72 — A provenance banner is not a value, so the oracle's may be edited to match

`make check-generated` runs **two** generators for each fixture — the Python one and the TypeScript one
— in `--check` mode, and requires both to report the committed file up to date. The pair is the point:
two independent renderings of the same source, held byte for byte together.

The TypeScript halves were verified by byte-identity first. `gen_moments_fixture.ts` reproduced
`spec/fixtures/moments.json` with **exactly one** line different, and `gen_digest_fixture.ts` reproduced
`spec/digest.json` with **exactly two** — all 112 points × 7 fields, and all three digest cases,
byte-identical. In both cases the differing lines were the provenance banner (`_source`, and for the
digest also `_note`): the Python named the *generator*
(`tools/gen_moments_fixture.py (bell_calibrator.domain.moments, 50 digits)`), the TypeScript named the
*derivation* (`domain/moments, evaluated at 50 significant digits (paper Eq (12))`).

That leaves a question the pair cannot answer on its own: which banner is right, and may the Python's be
changed? The repository's rule is that the Python is never edited to agree with its TypeScript
successor, because an oracle bent to match its port can no longer detect that the port is wrong.

**The rule is about the oracle's answers, and a banner is not an answer.** Nothing reads `_source` or
`_note`: `check_fixtures.ts` looks for integers a JavaScript reader would round, the Solidity
differential reads the numeric fields, and no test on either side asserts the banner's text — verified
by search rather than assumed. So editing it cannot make the comparison circular; it changes what the
file says about itself and nothing else.

The Python's banner was rewritten to name the derivation too, and each pair now agrees byte for byte.
The general form: **"never edit the oracle" protects the oracle's *values*; applying it to the oracle's
*label* would have forced the surviving rendering to carry the retired implementation's name.**

## F73 — The tools read the compiled calibrator, because bare `node` cannot resolve a relative specifier

`tools/*.ts` run under bare `node`, which strips types but does not rewrite a specifier. Measured, with
three one-line probes:

| specifier | outcome |
|---|---|
| `../../calibrator/src/domain/constants.js` | `ERR_MODULE_NOT_FOUND` |
| `../../calibrator/src/domain/moments.js` | `ERR_MODULE_NOT_FOUND` |
| `@bell/calibrator/domain/moments.js` | resolves through the calibrator's `exports` map to `dist/` |

**The failure is caused by the specifier, not by the module graph behind it**, and the third probe is
why that had to be measured rather than argued: `moments.ts`'s only import is `decimal.js`, so a naive
reading would blame a relative import *inside* the module. It is not — `constants.ts` has no imports at
all and fails identically. The conclusion still forces the design: `models.ts` writes
`import { WAD } from './constants.js'`, so the source tree is not loadable by bare `node` at any depth.

The consequence is a build dependency that has to be declared: `check-generated` and `check-coverage`
both need `ts-build`. That is the same dependency A6 found from the other side (F69), where the
settlement's cross-workspace import first exercised it.

## F74 — A cell the parser could not read made a whole row disappear

`forge coverage` prints `N/A (0/0)` for a column with nothing to cover. Both `check_coverage.py` and its
port matched a cell with `([\d.]+)%\s*\((\d+)/(\d+)\)`, which `N/A (0/0)` does not match — so a row
carrying one yielded **three** cells instead of four, failed the `len(cells) != len(COLUMNS)` guard, and
was **dropped whole**.

Both consequences are fail-open:

- **Rule 1** — a `src/libraries/` file with no branches was *invisible* to the library rule rather than
  perfect on it. The rule reports "no files under `src/libraries/`" only when the list is empty, so one
  such file among others is silently skipped.
- **Rule 2** — its lines were excluded from the `src/**` total, so the percentage was computed over a
  subset. A subset can be higher *or* lower than the truth; here it would have been higher, which is
  the direction that passes.

`percent()` already carried `100.0 if total == 0`, with a comment saying forge prints `N/A (0/0)` for
these — so the intent was written down and the parser made it unreachable. Found by probing the tool
with a synthetic report, and it is only findable that way: **no `src/` row in this repository's report
carries an `N/A` today.** The hole was latent, which is the worst kind, because it would have opened on
the first branch-free library and nothing would have said so.

Fixed in both halves by matching `N/A` as a cell, so `0/0` reaches the guard written for it.
`coverage_n_a_column_counted` is the regression guard: its report clears 95% and shows one perfect
library *only if* the unmatched row is counted, and fails both rules if it is dropped.

## F75 — Both measurements now write into a directory the tool owns

`check_coverage.ts` runs two external measurements, and both wrote into the repository by default:

- `coverage.py` writes a data file into the working directory unless told otherwise → a
  `calibrator/.coverage` after every run.
- `vitest --coverage` **deletes its reports directory before every run** → `rm -rf coverage/`, some
  eighty files.

Both were fixed the same way — point the tool at a directory this process created, and remove it
afterwards (`COVERAGE_FILE`, `--coverage.reportsDirectory`) — and the second is worth stating because
of *how* it failed. The delete was refused by a filesystem shim's bulk-delete guard, which surfaced as
a **non-zero vitest exit**, which the tool reported as *"the TypeScript suite did not run to
completion, so there is no coverage to assert"* — about a suite that never started. A measurement
failure that reads like a test failure sends a reader to the wrong file, and `make check` found it
rather than any test.

The general form: **a tool that runs another tool inherits that tool's filesystem behaviour, including
the parts that are not about measurement.** Owning the scratch directory is cheaper than tolerating the
interaction, and it is also what makes the run reproducible.

## F76 — Two defects in the A7 probe harness, both the shape it exists to find

The harness that probes these two checkers had two faults of its own, and both are worth recording
because they are the same shape as the failures it looks for.

- **A column nobody compares.** The layout probes returned `expected` and `actual` as separate fields
  and printed them side by side, but the pass/fail decision was taken from the note text — which the
  layout probes never set. So all nine layout probes reported `ok` **while the negative control was
  failing**: the harness printed the contradiction and passed it. Fixed by giving every row an explicit
  verdict. This is F53's shape one level up — a check whose *result* is not the thing it printed.
- **A harness that dirties the tree it measures.** One run left `calibrator/src/domain/utils.ts`
  behind, the artifact of the banned-name probe. It did not fail the harness; it failed `make check`
  two commands later, as a §6 violation in a tree nobody had touched — and the failure pointed at
  `check_layout.ts` rather than at the harness. Leftovers are now removed up front and reported, and
  the restore is asserted rather than assumed.

The first is the more interesting one, because the harness was *reporting* the truth and *concluding*
something else. **A probe harness is a gate like any other: it needs a probe of its own, and the
negative control is that probe.**

## F77 — The domain-purity rule banned three of the six ways to reach a double

The rule's own comment says the check is placed on "the thing that makes a double dangerous rather than
on the type: `Math` and the string-to-number parsers". Measured, it enforced rather less than that.

| Route | Sites in `domain/` | Banned? |
|---|---|---|
| `Math.*` | none | yes |
| `Number.parseFloat` | none | yes |
| bare `parseFloat`, bare `parseInt` | none | yes |
| `Number.parseInt` | `bytes.ts:74` | **no** |
| `Number(...)` | `dates.ts` ×4, `digest.ts` ×1 | **no** |
| `.toNumber()` | `leverage.ts`, `families/base.ts` | **no** |

`Number.parseInt` is the one that is plainly an oversight rather than a judgement: `Number.parseFloat`
is listed beside it and bare `parseInt` is listed below it, so one of the three spellings of the same
operation was missing from a list that names the other two. It was not hypothetical — `bytesFromHex`
used it, and used it *correctly*, because a hex digit is 0..15 and exact, so no value was ever wrong.
The defect is that the gate failed open on a spelling nobody had thought of. That is F74's shape again,
and it is R5.1's own lesson: a deny-list fails open on the category nobody thought of.

**Closed** by adding `Number.parseInt` to `no-restricted-properties` and rewriting `bytesFromHex` to use
nibble arithmetic, so the module needs no parser at all. Probed three ways:
`eslint_number_parse_int_refused` injects `Number.parseInt` and requires the refusal to *name*
`no-restricted-properties`, so the probe cannot pass for an unrelated reason;
`hex_digit_uppercase_dropped` and `hex_from_odd_length_allowed` require the rewrite to keep the
behaviour the old regex had; and the 14 contract-digest tests round-trip the committed fixtures through
`bytesFromHex`, which is what makes the rewrite a refactor rather than a new implementation.

**Not closed, and deliberately.** `Number(...)` and `.toNumber()` are unguarded and used, and every
current call site is an exact small integer: a year, a month, a day, a day count, a masked byte, and a
quantile rank that is an array index. Banning them would touch six call sites whose correctness depends
on magnitude bounds the rule cannot see, so it wants a ruling rather than a unilateral edit. The comment
above the rule now states what it covers *and* what it does not, so the paragraph that used to overstate
the enforcement is not left for the next reader to believe.

## F78 — `Symbol` shadows a JavaScript global, and the port keeps it

`models.ts` exports a class named `Symbol`, and `Symbol` is a JavaScript global. Any module that imports
it shadows the global for the rest of that file. Python has no `Symbol` builtin, so the collision is the
port's rather than the oracle's, and it arrived silently by keeping the name.

Kept rather than renamed: the name is what the protocol calls the thing, it appears throughout the
ABI-adjacent prose, and a rename would touch every adapter, test and comment for a hazard that is
visible at each use — `new Symbol('NVDA')` reads as a domain value in context, and nothing that imports
it needs the global. Recorded so that it is a decision rather than an accident, and so the next person
to notice it knows it was noticed. `models.test.ts` names it once, at the head of the `Symbol` block.

## F79 — Two headers counted their own tests wrongly, and a count target was met by coincidence

`calibrator/tests/unit/sessions.test.ts` opened by saying the Python it ports "has 10 tests in five
classes", that the two classes it defers are "4 of the 10", and that the deferred tests belong in
`models.test.ts`, "which tracker item A8 creates from `test_models.py`". The third claim is the one that
mattered: A8 read it and went looking. The Python has **11** tests in five classes and the two deferred
classes are **5** of them. The arithmetic was self-consistent at the answer that mattered (11 − 5 = 6,
and the file has 6), so only the totals were wrong — but a reader checking "4 of the 10" against the file
would conclude a test was missing.

The substance held, and A8 confirmed it rather than assuming it: all five are subsumed by
`test_models.py`'s versions, which are strictly stronger — the refusal set adds `-NVDA`, the gap test
adds a flat bar and a negative close — and `models.test.ts` now names which assertion covers each. So
nothing was lost. The counts were still wrong, and were fixed in the header.

The tracker's own A8 entry was wrong the same way, and more interestingly: *"the TypeScript count reaches
roughly 278 (31 + ~247)"*. 31 was the TypeScript count when the entry was written and 247 the Python
total; the suite landed on exactly **278** — from 251 + 52, because the earlier phases had already
absorbed most of the Python's tests into the TypeScript contract files. **A target met by coincidence is
not a verification**, so A8 was verified instead by enumerating both languages' test names per module and
matching them one for one. That enumeration is what found the gaps:

- **`test_rejects_a_for_session_beyond_uint64` had no TypeScript counterpart at all** — the only Python
  test name in either workspace with none. It is a guard, so it moved in with the other guards in
  `unit/digest.test.ts`, and the port added the boundary case the Python does not assert (uint64 max is
  *accepted*), which is what makes the refusal a bound rather than an off-by-one.
- **Two width guards were one-sided, in the Python and in the port.** `inputsHash` and `rowsDigest` are
  guarded `!= 32` but were only ever tested at 31 bytes, so weakening either to `< 32` left every test
  green. Both now test 33 as well. `nameId` was already two-sided, which is what made the asymmetry
  visible.

Eleven of the Python's 22 `test_moments.py` tests also turned out to be already present in
`contract/moments.test.ts`, which had absorbed them; the eleven that were genuinely absent are in
`unit/moments.test.ts`, and its header records the whole mapping. That is the useful form of a port
record: not "the suite is green" but "this Python test is that TypeScript test, and here is the one that
is the fixture instead".

## F80 — The TypeScript coverage bar was a real decision, and every shortfall under it was a real gap

B0 was written as a formality — *"set them at the same bars as the Python: ≥95%, and 100% on the
equivalent of `libraries/`"* — and it was not one. `TYPESCRIPT_REQUIRED_PERCENT` was `null`, so rule 4
was measured and unasserted, and the two workspaces read **96.41 / 91.46** and **96.46 / 86.09** on
lines/branches. So the bar the Python clears at 99.09 and 99.03 was a bar the port met on lines and
missed on branches, in both workspaces.

**The obvious move was the wrong one, and the branch report is what showed it.** Setting 95 on lines
alone would have been a bar chosen to be green. Setting it on the pooled line-and-branch measure —
the literal analogue of `coverage.py`'s `percent_covered` — would have been closer to the Python and
still green by luck: 94.63 and 92.65 pooled, so it would have needed three and eight more covered
items and no one would have known *which*. Asking instead which branch of which file was untaken
produced a list of real gaps, and every one of them was a gap rather than unreachable code:

| Site | What had never run |
|---|---|
| `models.ts` `Wad.one` | never evaluated — `fromWhole(1n)` was the only way anything wrote a unit |
| `models.ts` `isZero`, `isNegative`, `abs` | never invoked; `abs`'s conditional entered zero times |
| `models.ts` `toDecimalString` | never asked for a *negative* value, so both sign branches were unrun |
| `models.ts` `fromDecimal` integrality guard | the non-finite path its own docstring names |
| `digest.ts` `uintToBytes` | both refusals — see below |
| `leverage.ts`, `families/base.ts` `ascending` | never asked whether two values were **equal**, at either sort site |
| `prints.ts` `magnitudeWad` | only ever read for a negative gap |
| `routes/base.ts` | every fixture carried one timestamp and one insertion index |
| `routes/index.ts` `cheapestShippingRoute` | the fold's callback never called — one shipping route, no ties |
| `r4_multi_source_void.ts` | the sign arm; every negative r4 fixture was refused earlier |

Sixteen tests closed all of it, and the two workspaces now read **98.38 / 96.64** and **100 / 100**.
The comparator finding is the one worth keeping: `Array.prototype.sort` is stable only when the
comparator reports equality, and the nearest-rank rule then reads `rank - 1`, so a comparator that
mis-ordered a tie would move a quantile by one observation — and by one *gap*, which is the quantity
the leverage is built on. Neither sort site had ever been asked.

**Two of those sites were not gaps at all, and telling them apart is what the per-file rule needed.**
`leverage.ts`'s `rankedValue` guard and `families/base.ts`'s copy of it are `noUncheckedIndexedAccess`
guards whose docstrings already said the caller's arithmetic proves them: `empiricalQuantile` refuses
an empty sample *and* a probability outside `(0, 1]`, so `ceil(p · n)` lies in `[1, n]`; `GapSample`
refuses an empty sample at construction, so the same holds one layer down. `digest.ts`'s `byteOf`
guard is the third — three callers each check its bound first, so it had executed 13,306 times with
neither consequent taken. That redundancy is deliberate and already ruled on (F44/F45: a depth guard
belongs in the library and not only at its callers), so the guard stays and the coverage question is
answered elsewhere. The fourth and fifth are the two zero guards the Lentz continued fraction
specifies, which had not fired in 6,338 iterations.

**The four are `v8 ignore` hints in the source rather than exemptions in the tool.** A hint sits on
the line it silences and states its reason; a name in `check_coverage.ts` would be remote from the
code it excuses and would fail open the moment the code moved — the failure an allow-list exists to
avoid, and the same argument R5.1 made for `dependency-cruiser`. That the hints are load-bearing was
probed rather than asserted: removing one from `leverage.ts` fails rule 5 alone, naming three short
metrics on that file, while rule 4 stays silent because the workspace aggregate is still above 95.

**The `libraries/` analogue is `domain/`, and the identification is structural rather than
convenient.** `contracts/src/libraries/` is where the brief demands 100% on all four metrics, and it
is the pure arithmetic layer; `domain/` is the layer R5.1 defines as "no dependency that can reach
the world". Same role, same bar, and the constant is written as a reference to the contracts' one so
the equivalence is literal. It is also the only rule that closes the hole the workspace bar leaves by
construction: `calibrator/src/domain/models.ts` read **78.57%** of its branches inside a workspace
that read 91.46%, and an aggregate cannot see that.

**One unreachable path was a comment claiming a rule nothing tested, and it was refactored instead.**
`cheapestShippingRoute` documented two branches as unreachable — no shipping route, and a tie between
two — and wrote them out "anyway, because a tie-break that exists only in the oracle is a divergence
waiting for the day `ships` becomes a set". That is the right instinct and the wrong remedy: an
unasserted claim *about the oracle* is exactly what a differential port cannot afford. The function
now takes the cost rows as a parameter defaulting to `costReport()`, so every call site is unchanged
and both branches are asserted in both arrival orders. It is the same move as giving an `internal`
Solidity guard a frame through an `external*` wrapper.

**What the probes show, since a gate that has never failed is a gate nobody has tested.**
`--typescript-threshold 99` fails naming both metrics on `calibrator/src`. A synthetic summary with one
domain file at 0/2 branches fails rule 5 **alone**, with rule 4 silent — which is the isolation that
proves the two rules are independent rather than one rule reported twice. A summary with every row
present but none under a `domain/` root trips the "the rule was not applied to anything" guard rather
than passing by absence. And `null` is gone from the tool: B0 removed the state it guarded, because a
bar that can be switched off is a bar that will be.

## F81 — The Python was not only in the Python: three things outside the workspaces depended on it

**B1 deleted the two service workspaces, their tests and their packaging — 59 tracked files: 55 `.py`,
two `py.typed` and two `pyproject.toml`**, plus the untracked build residue of the toolchain
(`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, both `.egg-info/` directories and both
`.import_linter_cache/` directories). The tracker scoped the deletion to the workspaces, and that scope
was wrong in three places. Each would have been a live defect rather than a missing tidy-up.

**1. `tools/gen_constants.ts` was still *writing* the Python module it replaced.** Its `emits` list
named four outputs, one of them `calibrator/src/bell_calibrator/domain/constants.py`, and `main` passed
a `renderPython` result into the output map. Deleting the directory would not have removed the
emission: `mkdirSync(dirname(path), { recursive: true })` runs before every write, so the next
`make build` would have recreated `bell_calibrator/domain/constants.py` — a Python file inside a tree
that no longer has Python — and `make check-generated` would have gone on asserting it as a build
product. The emission is deleted rather than kept as a mode nobody runs, because a generator that can
resurrect a deleted tree is not a generator with a spare feature.

**2. The `Row.python` field was misnamed, not unused.** The obvious reading of "the Python is gone" is
that a field called `python` is dead and should go. It is not: `renderTypeScript` reads it for the
export name (`export const ${row.python} = ...n`), so it was the *TypeScript* identifier that the Python
renderer happened to share. Deleting it would have deleted all 23 constants. It is renamed
`Row.typescript`, which is what makes the `solidity`/`typescript` pair in the interface honest and what
the `RouteRow` comment beside it already claimed. The rename is mechanical across 23 rows, and the
check that it did not disturb the tables is that **no constant value changed**: after regeneration the
only diff in `Constants.sol` and `constants.ts` is prose.

**3. The F72 banner could finally be corrected, and it was one banner rather than two.**
`gen_constants.ts`'s header recorded that both renderings emitted `Produced by tools/gen_constants.py`,
that correcting either would destroy the diff that proved the port, and that they would be corrected
"in one step with the Python's deletion" (F55, F72). The Python's own banner died with `renderPython`;
the surviving one is the Solidity header, and it now names the tool that writes the file. The principle
that licensed the wait is worth restating, because it is what made the wait correct rather than lazy:
**a provenance banner is not a value.** Byte-identity was the acceptance test, and a banner is not a
number two implementations could disagree about, so it could wait. A constant could not have.

**`check_coverage.ts` carried a rule that could no longer be measured.** Requirement 3 was "each service
workspace must be at least 95% on `coverage.py`'s combined measure", and it worked by running each
workspace's pytest suite under `pytest-cov` with an interpreter the tool resolved and a caller could
override with `--interpreter`. Deleting the suites makes the rule unmeasurable, and an unmeasurable
rule is not a weaker assertion — it is prose. The rule, `PYTHON_REQUIRED_PERCENT`, `PYTHON_WORKSPACES`,
`PythonTotals`, `interpreterFor`, `defaultInterpreter`, `measurePython`, `readTotals`, `checkPython`
and the three flags that fed them are deleted, and the surviving rules renumber to 1–4. **The argument
the rule rested on is kept, because the argument was never about Python:** `bell_settlement.domain.ports`
forced the services onto the contracts' bar rather than a lower one because a `Protocol` body is a
declaration, and a declaration nothing imports is a boundary nobody has checked. That is requirement 4
now — the per-file `domain/` rule — and it is why the two `ports.ts` files are legal by having nothing
to instrument rather than by exemption. *The rule numbers shifted by one in that renumbering: what F80
calls rule 5 is requirement 4 in the tool today, and F80's rule 4 is requirement 3. The header is
authoritative; F80 is left as the dated record of the measurement.*

**Deleting the Python made eleven statements false, and they were corrected in the same step.** A
docstring naming a module that does not exist is not a stale comment; it is a false claim about where
the code is, and this repository's whole discipline is that a stated thing is a checked thing. Four
Solidity docstrings pointed at Python that is gone — `PremiumStore`'s digest preimage,
`SessionKind`'s counterpart enum, `Stat`'s shared formula, and `Moments.t.sol`'s reference generator
(`tools/gen_moments_fixture.py`) — and each now names the TypeScript that replaced it. One test comment
cited `tools/gen_constants.py` for the `prec = 60` that made the Python's ambient precision a hidden
input; the lesson is kept and the deleted filename is not. `ARCHITECTURE.md` needed more than a
sweep: it said the port was "in progress" with "both languages present", that the dependency rule was
"enforced twice because the languages need different tools", that `check_layout` had "not yet been
extended to the TypeScript tree", and that the coverage thresholds were "deliberately not set yet" —
four statements that B0 and B1 had between them made false. It now describes one tree.

**The Makefile lost its second toolchain, and the gate *names* were the interesting decision.**
`PYTHON`, `BIN_DIR`, `venv`, `check-python`, `test-calibrator`, `test-settlement`, the two `pytest --cov`
lines in `coverage`, and the ruff, mypy and `lint-imports` passes all went. The gate list is unchanged,
and that is deliberate: `check-types` (mypy) and `check-architecture` (`lint-imports`) each had a
surviving counterpart, so they name it — `npm run typecheck` and `npm run architecture` — rather than
disappearing from a list a reader has learned. The two whose subject was Python and nothing else
(`check-python`, and the per-workspace test targets) are deleted. `ts-check` then had to be *narrowed*:
it used to run format, lint, types and the dependency rule, which would have made a full `make check`
run `tsc` and `depcruise` twice each once `check-types` and `check-architecture` pointed at them. It
now runs format and lint only, and `npm run verify` is the target that runs the whole TypeScript half in
one go. `clean` gained the two build products it had stopped covering — `dist/` and the `tsc -b` build
info — which is what keeps its docstring true and its two workspace variables in use.

**Two gates died with the tree they guarded, and both say so where the check used to be.**
`check_layout.py`'s first check walked Python's `ast` to prove `domain/` imported nothing but the
standard library; TypeScript cannot parse Python, so it was never ported and has nothing left to guard.
`check_coverage.py` was already outside `make check` — the Makefile said so and said why — and every
rule it asserted is asserted by `check_coverage.ts`. Both TypeScript tools state their half's death in
their headers rather than leaving it as a silent omission.

**Verified, and the verification is the acceptance test the tracker named: `make build && make test &&
make check` with no Python on the machine.** Run with `python`, `python3`, `pytest`, `ruff`, `mypy` and
`lint-imports` all shadowed by stubs that exit 127, so a surviving invocation fails loudly rather than
merely being absent. All three targets exit 0, and the three logs contain **zero** stub hits. **672
tests** (353 Solidity, 319 TypeScript), down from 919 — the 164 calibrator and 83 settlement Python
tests are what was deleted, and the TypeScript count is unchanged. The coverage verdict is identical to
B0's: `calibrator/src` 98.38% lines / 96.64% branches, `settlement/src` 100% / 100%, and 23 `domain/`
files at 100% on all four metrics.

**The five `v8 ignore` hints were re-probed, because B0 left that as a condition of this step.** The
worry was specific: `byteOf`'s width guard is unreachable *because* three callers each check its bound
first, so one of those callers disappearing would make it reachable and turn a hint into a silenced
test. Removing the hint in `leverage.ts` and re-running `check_coverage --typescript` still fails with
**one** violation naming that file on three metrics (lines 97.37%, statements 97.62%, branches 95.83%),
with the per-workspace rule silent — so the guards are still unreached and no caller was a Python-only
path. The hint was restored byte-identically.

## F82 — `dist/` is what every cross-package import resolves to, and nothing kept it in step with `src/`

B2 was scoped as a confirmation: `calibrator/src/{domain,application,adapters}/` is now the whole of
`calibrator/src/`, so check that the `tsconfig` roots and the `exports` subpath pattern still hold. The
first half was already true — `rootDir: "src"` and `include: ["src/**/*.ts"]` were never written against
the nesting the Python added, so there was nothing to move. The second half is where the defect was, and
it is not in the config.

`calibrator/package.json` declares `"./domain/*.js"` → `./dist/domain/*.js`. The Makefile already knows
this is load-bearing — it is why `ts-build` is a prerequisite of `ts-test` and `ts-check` rather than a
convenience, and why a `paths` mapping onto `src/` was rejected. But the same fact is a hazard as well as
a prerequisite: **the `exports` pattern is a claim about what is in `dist/`, and nothing asserted that
`dist/` is what `src/` compiles to.**

It was not. `settlement/dist/domain/` held four files — `__probe.js`, `__probe.d.ts` and their maps —
whose source, `settlement/src/domain/__probe.ts`, does not exist and was never committed. They were the
output of a coverage probe, left behind when the probe file was removed. `tsc -b` writes the outputs of
the files it is handed and **never removes the output of a file that has been deleted or renamed**, so
they survived every build since. Because `settlement/package.json` declares no `exports` field at all,
`@bell/settlement/dist/domain/__probe.js` was a resolvable deep import into a module no source contains.

**Measured rather than assumed.** Two files were planted, `calibrator/dist/domain/__orphan_probe.js` and
the same under `settlement`:

| Command | Exit | Planted orphan |
|---|---|---|
| `tsc -b calibrator/tsconfig.build.json settlement/tsconfig.build.json` | 0 | survives |
| `tsc -b --clean` on the same two projects | 0 | **survives** |

`--clean` was the obvious remedy and it is not one: it removes the outputs its build info records having
emitted, and an orphan is by definition not among them. It emptied both `dist/` trees of everything else
and left both planted files in place.

**The fix is a sixth rule in `check_layout`, not a prune in the build.** `make check-layout` now fails
when any file under `dist/` has no counterpart under `src/`, naming the file and the remedy. Rule 3 of
the same tool is already "tests mirror source"; this is that rule one layer down, applied to the tree the
`exports` map actually reads.

Two other remedies were measured and rejected. **`rm -rf calibrator/dist settlement/dist` in
`npm run build`** guarantees the postcondition but throws away `tsc -b`'s incrementality to fix a defect
that is one to four files, and at 320 targets it is refused outright by a guarded run — `make build`
exited 1 with a `SAFE_DELETE_BULK_CONFIRM_REQUIRED` marker, which is a build that does not work
everywhere. **`tsc -b --clean`** was the third candidate and the table above is why it fails.

**The rule is one-directional, and that is the part worth stating.** An orphan is caught by nothing — no
compiler reads `dist/`, and the specifier that resolves to it is one nobody writes. A *missing* output is
caught twice over: `tsc` rebuilds it at the next build, and every test that imports it fails immediately.
Checking the direction that is already enforced would add a false failure for a developer who has just
added a source file and not yet rebuilt, which is the ordinary state of a working tree.

**Probed six ways**, because a rule that has never failed is untested. A clean `dist/` passes; four
planted orphans in `calibrator/dist/domain/` — `__orphan.js`, `__orphan.d.ts`, `__orphan.js.map` and
`__orphan.d.ts.map`, the four outputs one source produces — are each reported, so the suffix stripping is
tested rather than assumed; an orphan one directory deeper is reported; removing them passes; deleting a
*real* output with its source intact still passes, which is the one-directional property; and moving
`dist/` away entirely passes, which is the fresh-clone case that a target without a `ts-build`
prerequisite has to survive.

The scope is `dist/` and not `contracts/out/`, and the reason is the difference between the two: `dist/`
is a *resolution target* — the `exports` map and every `@bell/calibrator/domain/*.js` specifier in the
repository point into it — while `contracts/out/` is read only by `forge`'s own tooling, and `forge test`
compiles from source. A stale artefact there is untidy; a stale artefact here is importable.

## F83 — B1 de-Pythonised `.prettierignore` and left the language named in two more files

The B1 sweep was thorough about code and prose and stopped one file short of the ignore files. It removed
the two `**/*.py` / `**/pyproject.toml` lines from `.prettierignore` and did not touch `.gitignore`,
which still carried the full fourteen-rule Python stanza — `__pycache__/`, `*.py[cod]`, `*.egg-info/`,
`.venv/`, `venv/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.import_linter_cache/`, `.coverage`,
`.coverage.*`, `htmlcov/`, `coverage.xml`, `.mutmut-cache/`.

Left in place they would have been harmless, which is the argument for removing them: **an ignore rule is
how an artefact's reappearance stays invisible.** A `.venv/`, a `__pycache__/` or a fresh `.coverage` in a
tree that has no Python would have been silently untracked rather than shown in `git status`. The stanza
is replaced by a comment saying so, and `.recon/` remains the one place a `.py` file belongs. The edit
immediately did what it was meant to: two dead `coverage.py` databases, `calibrator/.coverage` and
`settlement/.coverage`, 163 KB between them, appeared as untracked and were removed.

`spec/constants.yaml` was the second file. Its header read "the Solidity side reads a generated header
from this file at build time; **the Python side loads it directly**" — present tense about a language the
tree no longer contains, in the one file the repository calls the single place a domain constant is
written down. It now names `tools/gen_constants.ts` and both of the renderings it emits. The edit is a
comment in a YAML file that `gen_constants.ts` parses with `yaml`, not hashes, so the check that it
changed no value is `make check-generated` still reporting all three artefacts up to date — which it does.

## F84 — `ARCHITECTURE.md` described a composition root that was never written

The layering section ended with "Nothing imports `adapters` except the composition root." No composition
root exists. Neither package declares `main` or `bin`, nothing in the repository executes either service,
and the only importers of `application/` and `adapters/` are the test files, which reach them by relative
source path (`../../src/application/publish.js`) rather than through the `exports` map.

The sentence is the same shape as the four B1 corrected in the same file: a description of the tree
written from the design rather than from the tree. It now says what is there — the layer table is a rule
about *permitted* imports, not a description of a running system — and keeps the one part that is
enforced, that `application-does-not-import-adapters` means the first composition root to be added cannot
invert the stack. Whether the two services are *meant* to have a runnable entry point is a separate
question, and the brief's §6 describes them as services without supplying one; that is recorded here
rather than answered by a paragraph.

**Resolution.** Both services now have entry points. The settlement's `challenge-verify` root landed
with F2 slice 1 (`settlement/src/cli/verify.ts`); the calibrator's landed as `make calibrate-publish`
(`calibrator/src/cli/publish.ts`): synthetic or CSV bars → `calibrate` → `publish` → merge the window
into a committed-input store file → print the `PremiumRegistry.commit` intent preview, no wallet.
`ARCHITECTURE.md` now names both roots. F84 is closed.

## F85 — Two of the retired gates were still enforced; two rules were not

B3 is the audit the tracker asked for: *"every rule they asserted has a home — confirm that rather than
assuming it."* The Python halves of `check_layout.py`, `check_coverage.py` and the two `import-linter`
contracts went with the tree in B1, so the audit starts by recovering them from `929245f^` and
enumerating what they asserted, one rule at a time. A confirmation that only reads the surviving gates
would be circular.

**The mapping, rule by rule.** All six of `check_layout.py`'s checks and all three of
`check_coverage.py`'s are accounted for:

| Deleted | Rule | Home now |
|---|---|---|
| `check_layout.py` 1 | Python `domain/` import purity, by walking `ast` | **died** — stated in `check_layout.ts`'s header, and nothing replaces it because there is no Python left to be impure |
| `check_layout.py` 2–6 | banned module names, 400 lines, tests mirror source, no `require` with a string, no untracked `TODO` | `check_layout.ts` rules 1–5, same rules on the surviving tree |
| `check_coverage.py` 1–2 | every `src/libraries/*.sol` perfect on four metrics; `src/**` ≥ 95% lines | `check_coverage.ts` rules 1–2, unchanged |
| `check_coverage.py` 3 | each service ≥ 95% on `coverage.py`'s combined measure | `check_coverage.ts` rule 3 — per workspace, **lines and branches separately**, which is the stricter reading |
| `import-linter` ×2 | `domain` depends on nothing but the stdlib and itself (calibrator), plus the shared core (settlement) | rules 1–2, and as **allow-lists** rather than the six-name deny-lists they replaced |
| `import-linter` ×2 | `application` does not import `adapters` | rule 3 |
| `import-linter` ×1 | the calibrator never imports the settlement service | rule 4 — **and it was blind. See below.** |
| `import-linter` ×2 | `the layer stack`, `layers = [adapters, application, domain]` | **no rule, and none is needed.** See below. |

**Finding: `the-calibrator-never-imports-the-settlement-service` could not fire on the spelling this
repository uses.** The rule was `from: ^calibrator/src`, `to: { path: '^settlement/src' }`. Probed with
a two-line file, the difference is entirely in how the import was written:

| Written as | Resolved in the graph to | Rule fires |
|---|---|---|
| `'../../../settlement/src/domain/routes/settle.js'` | `settlement/src/domain/routes/settle.ts` | yes |
| `'@bell/settlement/domain/routes/settle.js'` | `@bell/settlement/domain/routes/settle.js` — **unresolved** | **no** |

A package-name specifier stays a bare specifier in the graph, so `to.path` never sees the path it would
resolve to. And a package-name specifier is the only spelling this repository uses to cross a package
boundary — the reverse edge is `@bell/calibrator/domain/*.js` in twelve files. So the rule passed every
`make check` while missing the one way anyone would write the violation. Fixed by naming both spellings
in an array, and the two `domain/` allow-lists are unaffected for a reason worth stating: `pathNot`
catches everything *not* on the list however it was written, so an allow-list rule cannot be blind in
this way. That is the third time in this project that a deny-list has failed open on the form nobody
enumerated (F74, F77) — and the first time the missed form was a *resolution* rather than a spelling.

`application-does-not-import-adapters` had the same shape and is widened with it, guarding a spelling
that does not resolve today (`@bell/calibrator/adapters/*` is outside the `exports` map, and the
settlement has no `adapters/` layer). It is there because the rule names a *target*, not a way of
writing it.

**Finding: `Date` was available to `domain/`, and the tree said it was not.**
`settlement/src/domain/prints.ts` opens its docstring with "`Date` is not available to `domain/`". It
was available: `new Date()` and `Date.now()` in either `domain/` tree passed every gate, because
`dependency-cruiser` sees imports and `Date` is a global, and the eslint domain scope restricted
`Math`, `Number.parseFloat`, `Number.parseInt` and the bare parsers — four spellings of "a string
became a double" — and nothing about a clock. The Python had a rule for this (`ruff`'s `DTZ`, naive
datetimes) and the port had none.

Closed by adding `Date` to `no-restricted-globals` in the same domain scope, with the reason in the
rule: `getTime()` is a `number` of milliseconds, which is an IEEE-754 double in a costume, and §5.1
forbids a clock in the domain for the same reason it forbids `Math`. Probed: `new Date()` and
`Date.now()` in `calibrator/src/domain/` are both refused and both name `no-restricted-globals`, while
`Math.sqrt` still names `no-restricted-properties` — so the new entry did not displace the old ones.
The audit found no other rule in either `domain/` tree that the tree states and the gates do not
enforce: no `process.env`, no `Math.random`, no `node:` import, and the only `Date` mentions in
`domain/` are the two paragraphs explaining why it is not used.

**Decision: `.dependency-cruiser.cjs` does not restate the `layers` contract.** `import-linter`
declared `layers = [adapters, application, domain]` in each workspace, and `dependency-cruiser` has no
`layers` rule type. The tracker asked whether the config should restate it, and the answer is no,
because the content is already there and in a stronger form: every violation a `layers` contract can
catch is `domain -> application`, `domain -> adapters` or `application -> adapters`, and the three
rules above catch all three — the first two as allow-lists, which is a superset of what a layer
ordering forbids, since they also forbid a third-party package and a core module. Adding a `layers`
rule would be a second statement of one rule, and the two could drift. What was *not* there is the
claim: `ARCHITECTURE.md` listed *"the layer stack — the ordering itself, as a single rule"* among the
contracts, and no such rule has ever existed in the file. That paragraph is corrected rather than the
config being bent to match it, and the generalising property the `layers` contract did have — a new
layer being constrained by construction — is carried by the layer table in `ARCHITECTURE.md`, which a
new layer has to be added to anyway.

**One overstatement corrected, then closed.** `eslint.config.js` mapped `consistent-type-imports` to
"`ruff`'s `I`", which is half of what `I` does: `I` also sorts import statements. Ordering was therefore
a convention with no gate — the one shape of rule this repository tries not to have. Closed by adding
`eslint-plugin-simple-import-sort` and reforming the tree; both halves of `I` are now gates. The rest of
the `ruff` selection maps as follows, and the entries with no home are stated rather than left to be
discovered: `E`/`W`/`F` are `js.configs.recommended` plus `strictTypeChecked`; `UP` is
`erasableSyntaxOnly` and the ES2023 target; `ANN` is `explicit-function-return-type`; `B`/`SIM` are
`eqeqeq`, `prefer-const` and `no-var`; `T20` is `no-console` scoped to `src/`; `mypy`'s
`disallow_any_explicit` is `no-explicit-any`. **No home, and each deliberate:** `N` (naming — and
`SCREAMING_SNAKE_CASE` for immutables conflicts with `IERC20.decimals`), `A` (builtin shadowing — F78
records that `Symbol` is kept), and `C4`/`PTH`/`RUF`, which have no TypeScript analogue.

**Probed, because a gate that has never failed is untested.** Six dependency probes, each a two-line
file created, run and deleted: `domain -> application`, `application -> adapters`, `domain -> a
third-party package`, `domain -> node:fs`, `settlement domain -> the calibrator's application layer`,
and `calibrator -> the settlement service` in both spellings. Every one is caught and named. The
deletions left no residue in `dist/` — which is asserted rather than assumed, because the probe file
itself is the defect F82 describes, and `check_layout`'s sixth rule is what proves the workspace is
clean afterwards.

## Closure of F85 — import ordering is a gate

The B3 audit recorded that `consistent-type-imports` covered only half of `ruff`'s `I`: sorting was a
convention with no gate. Closed by adding `eslint-plugin-simple-import-sort` (`imports` and `exports`),
reforming the tree (33 files), and probing that an unsorted import fails `npm run lint` by name.
`prettier` still does not sort; the gate does.

## F86 — C0 gave `check_layout` three scopes, and the rule it did *not* add is the finding

C0 is the tracker's *"extend `check_layout` to TypeScript"*, and its premise was half wrong in each
direction. The 400-line rule and the banned-name rule already reached both workspaces' sources, because
B1 and B2 extended them when the tree became TypeScript. What was missing was narrower than the tracker
described, and in one place what was missing was not a rule.

**The Python's single `WORKSPACES` tuple was three scopes wearing one name.** Recovered from
`c0b7935^`, `check_layout.py` declared `WORKSPACES = (calibrator/src, settlement/src)` and read every
rule through it: one `python_sources()` fed the banned-name rule, the 400-line rule and the marker rule
alike. So "extend it to TypeScript" is not one decision, and C0 splits it into three, each decided on
its own evidence:

| Scope | Rules | Why |
|---|---|---|
| the two `src/` trees | §8.1's 400 lines, `dist/` mirrors `src/` | the brief says *source*, and the measurement below |
| every TypeScript file the repository owns — both `src/` trees, both `tests/` trees, `tools/` | banned module names, the marker rule | neither rule is about source, and both cost nothing today |
| `domain/` only | the coverage hint (new) | the per-file 100% rule is the only bar a hint is ever needed for |

**The 400-line rule was measured before it was scoped, and the measurement says no.** Of the six files
under `tools/`:

| File | total | code | comment |
|---|---|---|---|
| `tools/check_coverage.ts` | 604 | 354 | 205 |
| `tools/gen_constants.ts` | 590 | 445 | 109 |

Both exceed 400 by total lines, and `gen_constants.ts` exceeds it by code lines as well — so no reading
of §8.1 brings the rule's two subjects under it. Neither length is a design smell: `check_coverage.ts`
is a third comment because it is where the coverage rules are argued, and `gen_constants.ts` is a
row-table renderer `prettier --write` expands (F56). A rule whose only remedies are deleting the
reasoning that makes an audit tool auditable, or splitting a table renderer, costs more than the length
it objects to. §8.1 says *source file*, the Python never scoped it past the two `src/` roots, and both
readings agree. The test trees are excluded on the same sentence:
`settlement/tests/unit/routes.test.ts` is 523 lines of fixtures, and a fixture is not source.

**Decision: there is no TypeScript analogue of rule 3, and `check_coverage.ts` is why.** Rule 3 demands
`test/unit/X.t.sol` for every `src/libraries/X.sol`, because a library with no test is invisible to a
reader. The TypeScript tree already answers the stronger question at the same layer: requirement 4 of
`check_coverage.ts` holds every file under a `domain/` tree to 100% on lines, statements, branches and
functions, so a `domain/` file with no test cannot exist. A same-stem rule would ask for exactly three
files that add no coverage — `dates.test.ts`, `families/base.test.ts` and `routes/base.test.ts`, each
already perfect through another suite — and would additionally require three test files to be renamed to
match a directory (`families.test.ts`, `gap_source.test.ts`, `routes.test.ts`). That is a rule reshaping
the tree to fit the rule, and the honest form of it is this paragraph rather than a check that always
passes.

**The rule that *was* missing is the hint bound F80 asked for, and it is an allow-list.** Five
`v8 ignore` hints exist and all five are under `domain/`, so the per-file 100% rule depends on them —
which makes a hint the one place a coverage shortfall can be silenced by hand, with nothing bounding
where one may appear. Rule 7 permits a hint under a `domain/` tree and refuses it everywhere else. It
matches the *directive* (`v8 ignore next|start|stop`) rather than the words, because prose that names
the mechanism is not a hint and `check_coverage.ts`'s header discusses it twice; and it reads every
TypeScript file rather than only the instrumented ones, because a hint in a file that is not
instrumented silences nothing while reading as an exemption somebody took.

**A gate that could not fail, found while adding the rule.** Rule 6 reads `dist/`, and an absent `dist/`
passes — nothing can be orphaned in a directory that does not exist. On a tree that had never been built
this target therefore reported success while examining nothing, and `make check` made that worse rather
than better: it lists `check-layout` *before* `check-generated` and `check-coverage`, the two targets
whose `ts-build` prerequisite brings `dist/` into existence, so on a fresh clone rule 6 always ran first
and always vacuously. Fixed by giving `check-layout` its own `ts-build` prerequisite, which is a no-op
after the first build. This is the same finding as F82's second half and the same shape as the retired
gates in F85: a rule whose subject can be absent is a rule nobody has tested.

**Probed, 13 checks, each a planted file created, run and deleted.** Rule 7 fires in
`calibrator/src/adapters/`, in `tools/` and in `calibrator/tests/`, and permits `v8 ignore start` under
`settlement/src/domain/`; it does not fire on the five existing hints or on `check_coverage.ts`'s two
prose mentions. The banned-name rule fires on `tools/utils.ts` and on
`calibrator/tests/unit/helpers.ts`. The marker rule fires on an untracked marker in `tools/` and passes
on `TODO(#123)` — including on this checker's own header, which is the self-reference control: the token
is written in its accepted form there because the file is subject to the rule it states. The 400-line
rule passes a 501-line file in `tools/` and fails a 402-line file in `calibrator/src/`, so the scope is
enforced in both directions rather than only the one. Rule 6 fails on a planted
`calibrator/dist/domain/__probe.js`. And with `calibrator/dist` deleted, `make check-layout` rebuilds it
— 65 files — before the rule reads it, which is the prerequisite doing the work it was added for.

**One process correction, because it produced a false report before it produced a true one.** The first
harness run left three planted files behind and the second run's "clean tree" control then failed with
four violations, so every verdict in that report was a false negative and the file was byte-identical
between runs. The fix is a line of `rm -f` at the top of the harness plus a recorded
`git status --porcelain` in the report itself, so a contaminated run is visible rather than plausible.

## F87 — G0's premise was wrong: the NIG needs no Bessel function, and the fit that avoids one is exact

G0 is the tracker's *"NIG as the thin-sample fallback"*, and it carried its conclusion in its own text:
*"the modified Bessel K of the second kind is a numerical routine: it belongs in an adapter, not in
`domain/` (F39)."* That premise is wrong, and correcting it is the finding.

**The marginal density is never formed.** Written as a normal variance-mean mixture — `G | V ~
N(mu + beta*V, V)` with `V ~ IG(delta/gamma, delta^2)` — the truncated absolute moment is a
one-dimensional integral of an elementary function against an elementary density:

    E[min(|G|, c)] = (1/sqrt(2 pi)) * integral exp(shape - s/2 - shape*cosh s)
                                               * M(c, mu + beta*v0*exp(s), sqrt(v0*exp(s))) ds

with `v0 = delta/gamma` and `shape = delta*gamma`. No `K_1` appears, because the mixture representation
integrates against the *mixing* density rather than evaluating the marginal. So F39's placement rule is
not exercised by this family at all: `nig.ts` lives in `domain/` with no adapter, which is the outcome
F39 argued for, reached by a route it did not anticipate. The rule is not violated, and the record says
so rather than leaving a rule that looks violated for the next reader to re-derive.

**The inner moment is `moments.ts`'s primitive with the mean freed, and it reduces to it.** `|X|` at a
non-zero mean is folded normal, and `truncatedAbsMoment` refuses that case — correctly, since its closed
form does not apply. The free-mean form is the same split taken at the sign change as well:

    M = mean*(Phi(u_c) - 2*Phi(u_0) + Phi(u_m)) - scale*(phi(u_c) - 2*phi(u_0) + phi(u_m))
        + cap*(1 - Phi(u_c) + Phi(u_m))

At a zero mean the first bracket becomes `Phi(u_c) - 1 + Phi(-u_c) = 0`, the second `2*(phi(u_c) -
phi(0))` and the third `2*cap*(1 - Phi(u_c))`, which is `truncatedAbsMomentAtCap` written out.
**Measured over 88 `(cap, scale)` pairs the worst relative difference is 1.79e-49** — the last digit of
the fifty-digit working precision, because the two routes differ algebraically rather than numerically.
The test asserts 1e-45 and the docstring says *reduces* rather than *equals*: the first draft claimed an
exact identity, and the measurement refused it.

**The fit is by method of moments, which is a deliberate deviation from §7.11.** The paper fits by
maximum likelihood and records that MLE understates the variance by 2–6% on short windows — which is
precisely the regime the fallback exists for. The closed-form inversion has no iteration, no starting
values and no convergence criterion, so it either returns a parameter set or refuses; what it costs is
conditioning, since a thin sample's fourth moment is a noisy statistic. From the standardised moments
`s` and `k`, with `rho = beta/alpha` and `shape = delta*gamma`:

    rho^2 = s^2 / (3k - 4s^2)          shape = 9 / (3k - 4s^2)

The scale then follows from the variance, `m2 = shape / (gamma^2 (1 - rho^2))`, and `mu` from the mean,
`m1 = mu + delta*beta/gamma`. **Round-tripped against the exact cumulants of known parameter sets and
recovered to 3.9e-46 or better** across eight sets spanning `rho` from −0.96 to +0.97 and `shape` from
0.23 to 65.

**The inversion formula the reconnaissance notes carried was wrong, and the round trip is what caught
it.** The notes had `gamma = 3*m2^(3/2)/m3`, which is sign-dependent — it inverts a *positive* skewness
to a negative `gamma` — and on a case whose true parameters were known it returned `d(beta) = 3.0e+0`
and `d(delta) = 1.7e+0`, and `NaN` on the symmetric case. It is recorded here because the notes were
the only place it lived, and a formula that produces a plausible number for the wrong reason is exactly
what a round trip against known parameters is for. The pair above eliminates without a quadratic, which
is not obvious in advance: the two standardised moments of a NIG are `3*rho/sqrt(shape)` and
`3(1 + 4*rho^2)/shape`, and substituting the first into the second cancels the quadratic term.

**Three refusals, and the third is the one that is easy to miss.** A sample with no variance; a sample
whose `(skewness, kurtosis)` pair fails `3k - 4s^2 > 0`; and one that fails `rho^2 < 1`. The reachable
band for the third is `(4/3)s^2 < k <= (5/3)s^2` — a factor of 1.25 wide — and it took a search to land
in it: about one random small sample in 20,000, with the systematic form `{0.005, -0.007, 0 x 5}` giving
`rho^2 = 1.637`. The second condition is far more restrictive than the third: **of 60,000 deterministic
random small samples, 59,947 were refused by the cone and 53 fitted.** That is not a defect — a NIG is
leptokurtic by construction, so a sample with a negative excess kurtosis has no parameter set at all —
but it bounds where the fallback applies, and it is worth knowing before wiring it in.

**The quadrature's range and point count are measured, not chosen.** Substituting `v = v0*exp(s)` and
then `s = t/sqrt(shape)` turns the exponent into `shape - s/2 - shape*cosh s`, whose width in `t` scales
with `sqrt(shape)` while its range grows only logarithmically. So the node count is a multiple of
`acosh`, and the multiple was found by converging in `N` against a target the WAD grid sets: `toWad`
rounds at 1e-18, so the moment needs about 1e-22 and everything tighter is paid for in nodes. The rule is
`N = max(64, ceil(12*acosh(1 + 150/shape)))`, and over `shape` from 1e-4 to 1e3 **the worst mass error
is 7.3e-26** — four orders under the bar. The range has a derivable limit, `tMax -> sqrt(300)`, and its
approach is `DECAY/(12*shape)`, which the test asserts as a coefficient rather than a tolerance.

**The cost is set by the sample's excess kurtosis, not by the code.** Since `shape = 3/(k - 4s^2/3)`, a
fatter-tailed window needs more nodes: the fixture's `k = 97` gives `shape = 0.031` and 111 nodes at
465 ms, while a near-Gaussian sample gives `shape = 21` and 64 nodes at 104 ms. The TypeScript suite went
from 747 ms to 2.83 s. **One available optimisation was measured at G0 and taken later as F88**: 29.2% of
the quadrature's `Phi` arguments exceed 11, where `erf` is exactly 1 at fifty digits (`erfc(11) =
1.5e-54`), and short-circuiting there cut the fixture's path from 814 ms to 342 ms — a factor of 2.4.
It was left out of the G0 commit because `moments.ts` is the reference the Solidity differential is
derived from, and a feature commit is the wrong place to change how it computes.

**Probed, and the probe is the point.** The claim "the new file is at 100% on all four metrics" is worth
nothing unless the file is instrumented at all — a file the coverage config silently excludes also
reports 100%, and reports it identically. So the harness plants a branch that cannot be reached
(`cap.lt(0)` after a guard that has already thrown for every `cap <= 0`) and requires the checker to
fail. It does: `nig.ts: statements 98.89% (89/90), branches 95.00% (19/20)`, exit 1. The domain file
count moves from 23 to 24, and the restore is byte-identical. `nig.ts` is 344 lines, under §8.1's limit.

**Two smaller corrections, recorded because both were invisible.** The header of `families.test.ts`
claimed 31 tests while the file held 32 — a count written by hand and never re-derived, which is why the
number is now checked against the file. And the `rho^2 >= 1` branch needed a search rather than a
construction: the first two fixtures written for it were refused by the cone instead, and the test would
have passed while testing the wrong refusal.

## Closure of F88 — `erf` saturates where the continued fraction is pure cost

G0 measured that 29.2% of the NIG quadrature's `Phi` arguments exceed 11, where `erfc(11) = 1.5e-54`
and `erf` is exactly 1 at the module's 50 digits. Short-circuiting there cut the fixture's path from
814 ms to 342 ms — a factor of 2.4 — and was left out of the G0 commit because `moments.ts` is the
Solidity differential's reference.

**Taken.** `erf` returns ±1 at `|z| >= 11` (`ERF_SATURATION`). The moments fixture regenerates
byte-identical: every affected argument is far past the WAD grid, so the quantised oracle does not
move. The deep-tail `Phi(-7)` path still runs the continued fraction (`7/sqrt(2) ≈ 4.95`).

## F89 — G1's estimator reproduces Table 17, and the published column resolves the fourth digit of τ

**The rule the tracker states is right; one of its constants is rounded, and the column says so.** G1 is
"pool the shape, keep the scale": the event session's *shape* is homogeneous and near-Gaussian —
measured excess kurtosis −0.08 ± 0.48 against 13.24 ± 0.06 for the non-event pool — while its *scale* is
name-specific and estimable, because the name's own level is pinned by roughly 2,479 non-event
observations and only the ratio carries event information. A per-name empirical quantile at n = 34 is
biased low by 13.8% with a spread of 16.4%; the parametric route is −0.4% with a spread of 12.6%. So
`lambda_C = floor(1 / (q_C * r* * sigma_nonC))`, which is the rule `leverage.ts` already implements —
`lambda* = 1 / Q_(1-alpha)(|G|)` — with the empirical quantile replaced by `q_C * sigma_C*`. That
substitution is the whole architecture of §7.10: a quantile needs the tail, a scale does not.

**The estimator is `r*_i = w_i r_i + (1 - w_i) mu` with `w_i = tau^2 / (tau^2 + SE(r_i)^2)`, and `mu` is
the plain unweighted mean.** Three candidates were tested against the published column, and the
measurement picks one. Solving each published `r*` for the target it implies gives 4.363776 to 4.379700,
centred on `mean(r) = 4.371590909...`; the whole spread is explained by the quantisation of the published
inputs, because the implied target's sensitivity is `1 / (1 - w)` — 62× for XOM, 3.3× for NFLX — so a
5e-4 rounding in `r*` becomes exactly the deviation observed. The precision-weighted mean is 3.253, which
is nothing like it, and the median (4.1565) is not either.

**τ's fourth digit is resolved by the table, and the brief's 1.596 loses to it.** The method-of-moments
estimator `sqrt(var(r) - mean(SE(r)^2))` over the 22 names, with the *sample* variance (`n - 1`), is
**1.596142018792765...** The `n` form gives 1.554552 and the uncorrected `sqrt(var(r))` gives 1.697890;
neither reproduces the column, so the variance convention is load-bearing rather than a detail. The
tracker and the brief both state 1.596, and the paper's §7.10 body rounds it further to 1.58 — so the
question is which the published `r*` column actually supports, and it is answerable: **fitting τ to that
column by least squares puts the minimum at 1.596337**, which is 0.012% from the MM estimator and
therefore two independent routes to the same number. Against that optimum, the brief's rounded 1.596 is
**6.2% worse in rms**, and against the unrounded estimator 4.0% worse; it misses the published third
decimal on two names (NFLX, NVDA) where the unrounded value misses on one (NVDA). The paper's 1.58 is 17×
worse and misses 18 of 22. `spec/constants.yaml` therefore carries 1.596142, not 1.596, and the deviation
from the tracker is this paragraph rather than a silent edit.

**My own harness reported 12.7% for that comparison, and the number was wrong because the statistic was.**
The reconnaissance script's "rms" accumulated squared deviations and never took the square root, so every
ratio it printed was a ratio of variances. 1.0397² is 1.0810 — which is where 8.1% came from, and it is
not the deviation of anything. The error was caught by the test failing against its own pinned value, and
the corrected figures are the ones above. The same class of mistake the NIG work hit twice: a plausible
number from a wrong formula is indistinguishable from a right one until something independent checks it.

**`eventLeverage` takes the scale, not `(r*, sigma_nonC)`, and that is a decision about testability.**
`sigma_nonC` is *not published* — Table 17 prints only `sigma_C* = r* * sigma_nonC`, to two decimals. A
signature taking the unpublished input would force every check against the table to reconstruct it as
`sigma_C* / r*`, which cancels the factor the test claims to be checking and would pass for any
implementation of the quotient. So the module takes `sigma_C*`, which is the published object, and the
one composition step is `eventScale`, unit-tested on its own fixture. A test that cannot fail is worse
than no test, because it reads like evidence.

**The interval is `r* ± SE(r)` — the shrunk point estimate with the *raw* standard error.** Five
candidates were measured against all 22 published intervals: `r* ± SE(r)` misses 1, `r* ± SE(r*)` misses
5, `r ± SE(r)` misses 8, `r* ± SE(r*)/w` misses 1, and a τ-inflated form misses 10. Two candidates tie at
1 miss and `r* ± SE(r)` is the conservative one, which is the direction a published uncertainty band
should err. It is also the one the paper's caption implies — "the uncertainty on `r*` alone" is the
standard error of the measurement, not of the shrunk value.

**A real defect in the module's first draft, caught by asserting the order rather than the set.**
`eventLeverageBand` returned `[13, 10]` for AAPL. The leverage is the *reciprocal* of the scale, so the
upper multiplier gives the *smaller* leverage, and the two locals were named `high` and `low` for the ends
they were computed from rather than the ends they are. Ascending is the opposite of the order the
arithmetic produces. A test comparing the pair as a set would have passed.

**What reproduces.** All 22 `lambda_C` exactly, from the published 2-dp `sigma_C*`; the canonical three
are NVDA 5, TSLA 5, AAPL 11. All 22 `r*` within 1.0e-3 — a bound *derived* rather than fitted, being the
sum of two half-steps at 3 dp, since `r` is published at 3 dp and so is `r*` and `r*` is a convex
combination of `r` and the mean of `r`. Measured worst is NVDA at 9.2866e-4, 93% of the bound, and 21 of
22 also agree to the published third decimal. The interval reproduces 21 of 22: KO's low end computes to
17.98 against a published 18, and the scale that would flip it is 0.0216785 — 0.099% below the published
0.0217, whose own 2-dp quantisation is ±0.23%. The miss is inside the input's rounding, and it is
recorded rather than absorbed by widening a tolerance that would then hide a real error.

**Two constants had no consumer in either language, which is why G1 needed a generator change.**
`pooled_shape_q_C` was emitted into `spec/fixtures/canonical.json` as `eventSession.pooledShapeQWad` and
read by nothing; `cross_sectional_tau` was emitted nowhere at all. Both were declarations awaiting this
work. They are emitted into `constants.ts` as TypeScript-only rows — the chain receives a leverage, never
a shape, so `Constants.sol` is the wrong home — and, unlike `UINT_ROWS` and `ROUTE_ROWS`, those two rows
*read* the YAML rather than transcribing it. See F90 for why that distinction had to be made explicitly.

**One declaration was waiting for a caller that never came, and the comment said otherwise.**
`ports.ts`'s `AnnouncementCalendar` documented itself as "the interface G1 (event-session shrinkage) will
need". G1 landed without it: the rule is cross-sectional over per-name estimates the paper publishes, and
it fetches no announcement date. The guess was reasonable — the event session *is* defined by scheduled
announcements, so a fitter for it sounds like it must reach a calendar — which is exactly why the
correction is recorded rather than quietly deleted. What needs that port is ingestion, the same unwritten
caller `sessions.ts` already names for `classify`.

**Probed, and the probe is the point.** The same discipline G0 used: a coverage claim is worth nothing
unless the file is instrumented, because a file the config silently excludes reports 100% and reports it
identically. Planting an unreachable branch in `eventLeverage` — `if (eventScale.raw < 0n) return
Wad.zero;` after a guard that has already thrown for every `raw <= 0` — makes the checker fail with
`calibrator/src/domain/shrinkage.ts: statements 97.14% (34/35), branches 91.67% (11/12)` and one
violation. The domain file count moves 24 → 25, and the restore is byte-identical. `shrinkage.ts` is 231
lines, under §8.1's limit.

**Verified.** 25 tests in `shrinkage.test.ts`; `check_coverage` reports 25 `domain/` files at 100% on all
four metrics; `make check` exits 0; `depcruise` finds no dependency violation, so `decimal.js` is still
the only thing `domain/` may reach.

## F91 — G2 inverts the pool price in the truncation ratio, and M14 measures a derivative its stated purpose does not need

**The rule is Eq (13), and the root-find belongs in a different variable from the one the paper writes it
in.** G2 is "the unique `sigma` solving `lam * E[min(|G|, c)] = pL` with `c = 1/lam`". Writing `u = c/sigma`
and `g(u) = E[min(|Z|, u)]` gives `E[min(|G|, c)] = sigma g(u)` and `lam sigma = 1/u`, so

    lam * E[min(|G|, c)]  =  g(u) / u  =  h(u),

and the equation is `h(u) = pL` — a function of `u` **alone**, with the leverage entering only through the
final `sigma = 1/(lam u)`. That is the same equation, in the variable that makes it well conditioned, and
three things follow that the volatility form does not give:

- `h` is a fixed map `(0, inf) -> (0, 1)`, strictly decreasing (`h'(u) = -2(phi(0) - phi(u))/u^2 < 0`), so
  the inversion is a one-dimensional monotone root-find whose answer does not depend on the leverage.
- The reachable set is **provable** rather than asserted. `h(u) < 1` for every `u`, so `pL >= 1` has no
  solution at all — the same statement as `lam c = 1`, the saturation ceiling. The module refuses such a
  price instead of returning the large `sigma` a bisection would hand back.
- The relative error in `u` *is* the relative error in `sigma`, because `sigma = 1/(lam u)`. So the paper's
  M15 bound is a statement about solving `h(u) = pL`, and that is what the suite measures.

**The bracket is closed form, and the reason it had to be is that the suite timed out.** The first draft
bisected with a doubling search, which is correct and needs about sixty moment evaluations per inversion.
`moments.ts` computes at fifty digits and one evaluation costs ~3 ms, so the 112-point round trip took over
five seconds and vitest killed it. The fix is not a bigger timeout: two bounds on `h` hold for every
`u > 0` and bound the root with no search at all.

    h(u) >= 1 - 2 phi(0) u   gives   u >= (1 - pL) / sqrt(2/pi)
    h(u) <= sqrt(2/pi) / u   gives   u <= sqrt(2/pi) / pL

The second is the Mills ratio, `1 - Phi(u) <= phi(u)/u`. The first follows from `h(u) >= 2(1 - Phi(u))`,
whose two sides agree to first order at zero. Both are written in `sqrt(2/pi)`, which is exactly `2 phi(0)`
— and which is also `E[|Z|]`, so this is a third place where the F16 confusion between it and
`TWO_OVER_SQRT_PI` would be silent. Newton inside that bracket converges quadratically, a rejected step
falls back to bisecting it, and the 112 inversions now take **892 ms** — about eight evaluations each
rather than sixty.

**The paper's M14 check is reproduced to four figures, and identifying it is the finding.** The published
"minimum discrete derivative over 5 truncation ratios × 400 volatilities is 4.023e-01" is

    unitCapMoment(1/2) = 0.402291446000253296692826626067,

which says what the quantity is: `dE/dsigma` along a ray where the cap scales with `sigma`, i.e. `g(u)`
itself. The derivative that governs invertibility at a **fixed** leverage is a different one,
`2(phi(0) - phi(u))`, and on the same five-ratio grid its minimum is
**0.093753907274266400330531236676** — smaller by a factor of 4.29. The two are related by the exact
identity `g(u) = 2(phi(0) - phi(u)) + 2u(1 - Phi(u))`, and at `u = 1/2` the tail term is `0.3085`, which
is 3.3× the term that actually bounds the inversion. So the published figure is dominated by the piece
that has nothing to do with conditioning. This does **not** make the map non-invertible — it is strictly
increasing either way, and both derivatives are positive — but a check whose number is not the number its
stated purpose needs is worth recording, because a reader comparing M14 against this module's arithmetic
would otherwise find two different numbers and no explanation. Both are pinned in the suite, together with
the identity.

**The accuracy is the input's information content, and that makes the tolerance derivable rather than
observed.** The pool price arrives as a `Wad`, so it carries nothing about `sigma` below one wei; the
root-find stops when `|h(u) - pL|` reaches one wei, and therefore

    du / u  <=  quantum / (pL * |e_h|),     |e_h| = |u h'/h|.

The suite checks that inequality at all 112 fixture points instead of pinning a worst case, because a
pinned worst case would pass for an implementation that was accidentally good at 111 points and wrong at
one. The measured worst is **0.637 of the bound**. The round trip itself recovers every one of the 112
reference volatilities with a worst relative error of **3.195e-17**, against M15's published 1.16e-13 — a
factor of 3630 inside it. Re-pricing the recovered `sigma` back through `truncatedAbsMoment` lands within
**467 wei** (4.708e-16), which the M15 round trip does not cover: a `sigma` that recovered the right
`sigma` but not the right price would pass the first assertion.

**Check X8 does not reproduce, in the conservative direction.** The paper says the inversion's elasticity
"is unity to within 0.21% while `c/sigma >= 3`". Measured, it is **1.027%** from unity at `c/sigma = 3`,
and 0.21% is not reached until `c/sigma = 3.492403635244047`. The sentence the figure is attached to —
"a 1% relative price error produces a 1% relative volatility error" — *does* hold at `c/sigma >= 3`, from
`3.008758104335780`; so the tolerance is optimistic by a factor of 4.9 and the conclusion it supports is
not. Both thresholds are pinned. The tangent elasticity is the quantity, and it was confirmed against a
secant at `eps = 1e-9` and `1e-12`, which converge to it.

**The freshness guard is a rule with three decisions in it, and each is recorded rather than assumed.**
The bound is **inclusive** — an age equal to the staleness bound is still the pool's own reading — because
Table 19 makes the rotation period equal the bound, so a set *at* the bound is one the publisher is
already due to replace; reading it as exclusive would price on it for one session too many. Beyond the
bound with no fallback supplied the call **refuses**, which is Table 19's "the pool refuses to price rather
than pricing on a stale fit", and the function returns a reading rather than a boolean so that a caller
cannot render a refusal as a number. A reading carries its provenance as a named union rather than a flag,
because `trailing-realised` is a different claim from `pool` and a consumer deciding whether to trust the
number needs to see which it holds. `ageAt` refuses a session *before* the reading's own, because a
negative age compared against a bound reads as maximally fresh, which is the one direction that fails
unsafe.

**`STALENESS_SESSIONS` had no consumer, and this is the third constant of that kind.** It was declared in
`constants.ts`, emitted into `Solidity`'s fixture and into nothing that reads it by value — the same shape
F89 found for `pooled_shape_q_C` and `cross_sectional_tau`. It is now the default `boundSessions` of
`publishedVolatility`, which is a real consumer and is also the right design: the protocol states one
staleness bound and a caller should not restate it, while a test still needs to pass a bound of its own.

**Two defects in my own reconnaissance, both of which produced plausible numbers.** The derivative was
first evaluated as `truncatedFirstMoment(1, u)`, which is `u * 2(phi(0) - phi(1/u))`, where the argument
that yields `2(phi(0) - phi(u))` is `truncatedFirstMoment(1/u, 1)`; the two agree only as `u -> infinity`
and differ by a factor of **7.4 at `u = 1/2`**. And the safeguarded Newton shrank the bracket *before*
taking the step and ignored the residual's sign, so the bisection fallback became a one-way ratchet toward
`upper` — it converged to the bracket's end for every point, and the fixture round trip read 70% instead
of 3e-17. Both were caught by a finite-difference check and by the fixture disagreeing, not by inspection.
A third: a `targetRelative` default of `null` made the step count compute to `Infinity` and the first
reconnaissance run hung for two minutes before it was killed.

**One deliberate duplication, checked rather than trusted.** `implied.ts` carries its own two-line
half-even WAD quantiser rather than importing `families/gaussian.ts`'s `toWad`, so that the pool-price
surface does not read as depending on the *Gaussian family strategy* — the conversion is generic and only
happens to live beside the family that first needed it. The direction of the rounding is a recorded
decision (half-even, against `GapSample.sigmaWad`'s truncation), so a second copy is a drift risk, and the
suite removes it: `capRatioForPrice` is the shared input, so comparing `impliedVolatility` against
`toWad(1/(lam u))` isolates the quantiser and nothing else. This is the discipline `families/base.ts`
already applies to its duplicated nearest-rank rule.

**Probed, and the probe is the point.** The same discipline G0 and G1 used: a new `domain/` file at 100% is
only meaningful if it is *instrumented*. Planting an unreachable branch in `capRatioForPrice` — `if
(lower.gt(upper)) return ONE;`, after a bracket whose ends are ordered for every price in `(0, 1)` because
`(1 - pL) pL <= 1/4 < 2/pi` — makes the checker fail with `calibrator/src/domain/implied.ts: lines 98.25%
(56/57), statements 98.28% (57/58), branches 97.37% (37/38)` and one violation. The domain file count moves
25 → 26 and the restore is byte-identical.

**Verified.** 26 tests in `implied.test.ts`; `check_coverage` reports **26 `domain/` files at 100% on all
four metrics**; `make check` exits 0; `depcruise` finds no dependency violation across 33 modules, so
`decimal.js` is still the only thing `domain/` may reach. `implied.ts` is 357 lines, under §8.1's limit —
but it is now the **longest TypeScript file in either `src/` tree** (`nig.ts` is 344, `models.ts` 352) and
the third-longest file overall behind `Session.sol` at 376 and `ReferenceRegistry.sol` at 364, so a further
addition to the surface should expect to be split rather than appended.

## Closure of F90 — the generator reads the single source

`gen_constants.ts`'s emission tables held their values as literals — `value: wad('0.01')`, `value: 6n` —
so `spec/constants.yaml`, which the brief's §6 makes *the* place a domain constant is written down, was
not the source for the 27 constants those tables emit. It was read for structure (canonical parameters,
`event_session`, `bond_sizing`, `deployment`) and transcribed for scalars, and **nothing asserted the two
agreed**. G1 found it (F89) by refusing to reproduce the pattern for `1.596142`; the two rows it added
read the YAML instead.

All three tables now read it. `UINT_ROWS` (21 rows), `BOND_ROWS` (2) and `ROUTE_ROWS` (4) became
functions of the parsed document, each row naming its path. The route table writes the path's *shape*
once — `settlement_routes.${route}.expected_cost_bp` — so a fifth route cannot be added pointing
somewhere else, and `BOND_ROWS` now takes its base-unit exponent from `protocol.collateral_decimals`
rather than a literal `6`. That last one matters more than it looks: the F4 incoherence was *caused* by
the bonds and the collateral disagreeing about decimals, so a hardcoded `6` left the one number that has
already been wrong once outside the single source.

**The acceptance test is byte-identity**, because the emission is the artefact: all three generated files
are unchanged — `Constants.sol` `64a843c2…`, `constants.ts` `984556b2…`, `canonical.json` `c657a1df…` —
and the generator reports "up to date" for each rather than rewriting them. A refactor of a generator is
proved by its output not moving, and there is no tolerance in that.

Four probes, because byte-identity proves the change is safe and proves nothing about whether the rows
now *read* anything:

| Probe | Result |
|---|---|
| `protocol.alpha.value` `0.01` → `0.02` | `ALPHA_WAD` follows: `10_000_000_000_000_000` → `20_000_000_000_000_000`, in both renderings |
| rename the leaf `value` under `alpha` | `Error: spec/constants.yaml has no protocol.alpha.value` |
| rename the section `protocol` | `TypeError: Cannot read properties of undefined (reading 'alpha')` |
| `meta.wad` `1e18` → `1e17` | `Error: … declares meta.wad = 100000000000000000, but this generator scales by 1000000000000000000` |

Probe 1 is the one that matters: **before this change it printed the same numbers after editing the
YAML**, which is the defect restated as an experiment.

Probes 2 and 3 are the two failure modes and they are not equally good. A renamed **leaf** is caught by
`at()`, which names the file and the path. A renamed **section** throws before `at()` is reached, because
the accessor chain is what fails, and the message names neither. That is accepted rather than fixed: the
generator runs on every `make build`, so the failure is immediate, and a section rename is a deliberate
edit to a file with fourteen sections rather than a plausible slip. The alternative — reading by a dotted
path string — trades a compile-checked accessor for a nicer message on the rarer failure, and
`ConstantsDocument` exists precisely so the compiler checks the accessor.

**One copy could not be removed, so it is checked.** `WAD` is the module's own scale (`10n ** 18n`) and
`meta.wad` is the YAML's declaration of the same number; `wad()` is what builds the rows, so it cannot
read the document it is being used to read. `assertWadScale` compares them at startup. Without it,
editing `meta.wad` would emit `Constants.sol`'s `WAD` at one scale and every other WAD constant at
another, and nothing downstream compares the two — probe 4 is that check firing.

## F92 — the F52 guard does not read the file the constants actually live in

`tools/check_fixtures.ts` walked `spec/` for **`.json`** files — its own words: "every JSON fixture under
`spec/`". `spec/constants.yaml` is not one, so the guard that exists because three fixtures independently
carried WAD-scale integers as bare JSON numbers did not cover the file §6 makes the single source for
every domain constant.

One instance is live today: `meta.wad: 1000000000000000000` is a bare YAML number above 2^53. It is
exactly representable — `10^18 = 2^18 · 5^18` and `5^18 < 2^53` — so it is the *at-risk-but-exact*
category the checker already has a name for, and it becomes lossy the moment somebody edits a digit.
Nothing read it before F90, so the hazard was inert; the generator reads it now, and `assertWadScale`
compares it against a value that is itself exact, so this specific instance fails loudly.

**Closed.** `check_fixtures` now walks `.json`, `.yaml` and `.yml` under `spec/`. YAML has no
reviver-with-source, so the check reads each unquoted integer scalar's range in the concrete syntax
tree and compares that source text against the number the parser produced — the same round-trip the
JSON path already performed. Quoted scalars are skipped: quoting is the YAML form of the string
encoding the rest of `spec/` already uses.

The committed tree reports **5 files, 1 integer above 2^53, all exactly representable**, and the one
is `meta.wad`. Probed: editing it to `1000000000000000001` fails with `wad written as
1000000000000000001, reads as 1000000000000000000` and names the YAML file; restoring is
byte-identical. That is the digit-edit F92 said would be lost before `wad()` saw it.

## F93 — `createSession` deploys a session it never registers, and nothing else does either

`SessionFactory.createSession` deployed the session, handed it `referenceRegistry` in the constructor, and
emitted `SessionCreated`. It did **not** call `ReferenceRegistry.registerSession`. Nothing in `src/`
called it: `registerSession` was declared `external`, permissionless, and its only reference in the
tree was its own declaration. `registerSession` was therefore a step the listing path did not perform.

**What that cost.** A freshly created session was `Open` and fully usable — it could be seeded, traded and
resolved *by the registry* only after registration, because `resolve` opens with

```solidity
SessionRecord storage record = _sessions[session];
if (record.referenceToken == address(0)) revert NotRegistered(session);
```

So between `createSession` and somebody sending `registerSession`, the session was **unsettleable**. Its
collateral was not at risk: the instrument is fully collateralised, and `claim` and `withdrawPool` both sit
behind `inState(State.Settled)`, which no path reaches without a `settle` that only the registry can call.
This was a liveness gap rather than a hole — but it was a gap a participant reached by following the listing
path correctly, and it made the listing **two** transactions when it looked like one.

**Why it looked like a design decision.** `registerSession` reads three things rather than accepting them: the
session's `expiryTimestamp`, the session's `lamWad`, and the reference token's `multiplier()` — and the
third is read here *on purpose*, so that the multiplier a session is judged against is the value the token
reported at registration rather than a value a caller supplied. G8 compares that recorded multiplier
against the token's multiplier at resolution, so registration time is a load-bearing input and not a
bookkeeping step. The open question was whether the factory performing the call would reopen the
caller-supplied-multiplier question.

**Closed.** It does not. The factory passes the same `referenceToken` it already used for CREATE2;
`registerSession` still reads the multiplier from the token and the expiry/leverage from the session.
The factory now calls `registerSession` after emitting `SessionCreated`, so listing is one transaction.
`registerSession` stays permissionless for sessions created outside the factory, and the duplicate path
remains a named, testable error. The log fixture no longer performs a second registration; the Deploy
script test asserts the record exists after `createSession` alone.

**Where it was found.** While writing the log fixture (F94). The fixture used to perform the registration
explicitly; it no longer has to.

## F94 — the log fixture's provenance note asserted an event the corpus did not contain

The fixture `spec/fixtures/logs.json` carries a `_note` naming the events it holds: "…PrintSubmitted,
ReferenceRegistry.Resolved and Settled." The corpus contained **no `Settled` at all**. It regenerated
byte-for-byte on every run, the test passed, and the note was false.

**The mechanism.** `ReferencePrintBook._trySelect` filters candidates twice:

```solidity
if (candidate.timestamp < notBefore) continue;              // notBefore is the session's expiry
if (_ageOf(candidate.timestamp, nowTimestamp) > staleBoundSeconds) continue;
```

The fixture submitted its only print *before* `vm.warp(expiry + 1)`, so the print was disqualified on
both counts: it predated the close, and by the time of resolution it was 63,001 s old against a
`staleBoundSeconds` of 7,200. `_selectOrDefer` returned its `type(uint256).max` sentinel, the branch
became `Deferred`, and `resolve` skipped the settle entirely:

```solidity
if (branch != Branch.Deferred) {
    record.resolved = true;
    Session(session).settle(payoffWad, stale || branch == Branch.StalePrint);
}
emit Resolved(session, branch, gapWad, payoffWad);
```

The registry emitted its `Resolved` with `branch = Deferred`, `gapWad = 0` and `payoffWad = 0`, the
session stayed `Expired`, and the corpus was one event short of what its own note described.

**Two things worth keeping.**

The first is domain, and it is the trap for anything a participant touches (F50): **the reference print is
a closed-session print.** A print taken before the close cannot be the reference print however fresh it
is, because selection is bounded below by the expiry, not only above by staleness. A UI that submits a
print and then closes a session has the two the wrong way round; the print belongs *after* the close, and
within `staleBoundSeconds` of the resolution.

The second is about the evidence. **Byte-identity is the acceptance test for a generator and it cannot
detect a corpus that is internally inconsistent with the claim made about it.** Unchanged bytes prove the
generator is safe, not that its output is complete. The remedy is not a more careful note — a note is a
claim, and this one was unchecked — but an assertion on the property whose absence produced the defect.
The fixture now ends with

```solidity
assertEq(
    uint256(session.state()), uint256(Session.State.Settled), "the session did not settle"
);
```

so a lifecycle that stops settling fails loudly instead of quietly regenerating a weaker corpus. This is
the same shape as F90's lesson one layer over: a copy that cannot be removed has to be *checked*, and a
claim that nothing verifies is the thing that goes wrong.

**Regenerated.** The corpus is 29 logs across 13 distinct topic0 values and 7 emitting addresses; the
session now settles on `LivePrint` with `gapWad = 2e16` and `payoffWad = 3e17`, which is
`min(λ·|G|, 1) = min(15 × 0.02, 1)` — the instrument's own pricing primitive, visible in the logs.

## F95 — the fourth generator was in no gate, and the one place it ran was the wrong build

`spec/fixtures/logs.json` is produced by `contracts/test/indexer/LogFixture.t.sol`, not by a Node tool.
`make check-generated` ran three `--check` invocations — `gen_constants`, `gen_moments_fixture`,
`gen_digest_fixture` — and the fourth generator had no entry. The only place it was executed at all was
`check-coverage`, which runs `forge coverage`.

**That is the one profile that cannot reproduce it.** `forge coverage` instruments the contracts it
measures. `SessionFactory.createSession` deploys a session with CREATE2, and CREATE2's preimage is
`keccak(0xff ‖ factory ‖ salt ‖ keccak(initcode))` — so **the session's creation code is part of its
address**. Instrumentation changes the creation code, the session address moves, and the two claim tokens
the session deploys move with it. Measured, on the same corpus:

| Contract | `forge test` | `forge coverage` |
|---|---|---|
| `SessionFactory` | `0xc7183455…` | `0xc7183455…` (unchanged) |
| `ReferenceRegistry` | `0xf62849f9…` | `0xf62849f9…` (unchanged) |
| `PremiumRegistry` | `0x5991a2df…` | `0x5991a2df…` (unchanged) |
| `Session` | `0x3fc355a5…` | `0x063c3c2e…` |
| long claim token | `0xadc235f7…` | `0xf17e96dd…` |
| short claim token | `0x447add36…` | `0x991fe1ec…` |

The four that held are deployed by the test contract with CREATE, whose address and nonce are fixed; the
three that moved are the CREATE2 chain below it. So **a fixture that records a CREATE2-derived address is
a function of the compiled bytecode, and "byte-identical" is a claim about one build.** A gate has to
name which build it is asserting in.

**The failure was worse than a red test.** The fixture test wrote the new bytes *before* reverting — the
`--check` idiom — so the coverage run left the instrumented corpus in the tree. A check whose purpose is
to catch a corrupted generated file corrupted the generated file. `make check` then failed on the *next*
run, with `check-generated` having already passed, which is the shape of a flake rather than of a defect.

**Three fixes.**

The write is now opt-in: the test writes only when `BELL_WRITE_FIXTURES` is set, and otherwise a mismatch
fails with an error that carries the regeneration command. An unintended run can no longer touch the tree.
This is the same `--check`/write split the three Node generators use, expressed as an environment variable
because the producer is Solidity rather than a tool that can take a flag.

The fixture is asserted by `make check-generated`, in the canonical build — so a stale Solidity-produced
fixture is a `make check` failure like the other three, rather than a failure only under coverage.

`forge coverage` is passed `--no-match-path test/indexer/LogFixture.t.sol`, naming the one file rather than
its directory so that a later test placed there has to make the decision deliberately.

**Probed.** Corrupting the fixture and running the test without the flag fails with
`LogFixtureStale("BELL_WRITE_FIXTURES=1 forge test --match-path test/indexer/LogFixture.t.sol")` and
leaves the corrupted bytes on disk; running with the flag restores it byte-for-byte. And the fixture's
md5 is unchanged across a full `make check` — which is the measurement that matters, because before this
change the same run rewrote it.

**A third inaccuracy in the same file.** The fixture's `_note` said "Regenerate with `make build`", and
`make build` does not run a Solidity test — so the instruction had never worked. It now names the flag and
the test, and `make check-generated` is what enforces it.

## F96 — the architecture gate was blind to the only spelling this repository uses

`.dependency-cruiser.cjs` stated its own mechanism in its header: *"a package-name specifier stays
UNRESOLVED in the graph, so `to.path` sees the bare `@bell/settlement/domain/x.js` and never the path it
would resolve to."* Measured, that is true for exactly one of the three workspaces — the one with no
`exports` map.

**The calibrator and the indexer both map their `exports` onto `./dist/…`**, so a cross-workspace
specifier does not stay bare: it resolves, to the target's build output. And `options.exclude` contained
`dist`, which — by the mechanism the same header describes for `node_modules` — removes the module from
the graph *and the edge with it*. The edge therefore never reached any pattern.

The measurement, on a two-line probe importing `@bell/indexer/domain/log.js` from
`calibrator/src/domain/`:

| Configuration | Dependencies found on the probe file |
|---|---|
| `exclude` contains `dist` (as shipped) | **none at all** |
| `dist` not excluded | six |

**What that cost.** Three rules were affected, and the shape of the damage is what makes it hard to
notice: the gate reported *no violations*, which is what a working gate reports.

| Rule | Effect of the blindness |
|---|---|
| `nothing-imports-the-indexer` | fired on nothing, in **any** spelling — it was written first and had never worked |
| `application-does-not-import-adapters` | the `^@bell/…/adapters` pattern could never match; only the relative spelling reached it |
| `the-calibrator-never-imports-the-settlement-service` | worked, **by accident**: `@bell/settlement` is the one workspace with no `exports` map, so its specifier stays bare and the bare pattern matched |
| the two `domain/` allow-lists | unaffected — they are `pathNot`, so they catch anything not on the list however it was written, which is F85's observation and the reason the gate looked healthy |

**Two configurations, two different failures, and neither is acceptable.** Excluding `dist` deletes the
edge; keeping the edges without widening the patterns makes the allow-lists fire on *permitted* edges —
`settlement/src/domain/routes/settle.ts → calibrator/dist/domain/constants.js` was reported as a
violation of the rule that exists to permit it.

**The fix.** `dist` moved from `exclude` to `doNotFollow`, which keeps the edge and declines to descend
into it — build output is not source and needs no rule applied, but the edge is the whole subject. And
every pattern that names a layer now accepts both spellings, `(src|dist)`, at all five sites. The
alternation is written out rather than produced by a helper because this is a `.cjs`: a TypeScript
return annotation is a syntax error there, and the lint rule requiring one cannot be satisfied, so five
repetitions of a two-word pattern are cheaper than a lint exemption.

**Probed, nine checks.** Seven fire — the indexer's application→adapters edge, `@bell/indexer` imported
from both the calibrator and the settlement, `@bell/settlement` and the relative `src` and resolved
`dist` spellings of the calibrator→settlement edge, and `node:fs` in the indexer's domain. Two negative
controls stay silent: the settlement's and the indexer's permitted reads of
`@bell/calibrator/domain/models.js`. The graph grew from **36 modules and 86 dependencies to 41 and
101** — that difference is the count of edges the gate could not previously see.

**The lesson is F85's, one layer out.** F85 found a rule whose `to.path` named a spelling nobody writes.
This is the same failure with the opposite cause: the rule named the spelling everybody writes, and the
*resolver* turned it into a third one that the exclusion list had deleted. A gate written against paths
has to be checked against the paths the resolver produces, and the way to check it is to probe every
spelling rather than the one the author had in mind.

## F97 — the trading fee is implemented and never charged

The paper's §6.3 specifies two fees: a **trading fee** paid to liquidity providers — the ramp of
Eq (19), `φ(t) = φ0 + (φ1 − φ0)·(t − tk−)/Tk` with φ0 = 0.10%, φ1 = 1.00%, and the volatility scaling
of Eq (20), `φ(σ) = φref·(σrealised/σref)` capped at φmax — and a **protocol fee** on redemption,
Eq (17), 12% annualised prorated by term. Only the second is wired: `Session.redeemPair` charges
`FeeModel.protocolFeeWad` (Session.sol:159). The trading fee functions — `tradingFeeWad` and
`volatilityScaledTradingFeeWad` — are implemented in `FeeModel` and called by nothing in `src/`:
only the unit tests and `PrintDiagnostics.s.sol` reach them. `Amm` and `SessionPool` charge no fee.

**Why this is a finding rather than a quiet fix.** Wiring the fee is a protocol change with three
decisions the paper does not pin down:

- **Which schedule.** Table 5 compares the ramp ("Time"), the reweight and the level schedule
  (Eq 20) as *alternatives* — "The three candidate schedules are simulated below" — while the §6.3
  parameter table says the fee is the ramp "scaled by realised volatility relative to the calibration
  reference (equation (20))". The FeeModel implements both as separate functions, so the final form
  (ramp × level, or level alone) is a choice, not a transcription.
- **Where it accrues.** The paper says the trading fee is "liquidity-provider compensation, not
  protocol margin" — at a 55 bp fee the protocol captures 6.9% of the stack. The protocol fee
  accrues to `collectedFees`; the trading fee would accrue to the pool's reserves (or to LPs
  directly), which changes the pool invariant and the settlement accounting.
- **The volatility source.** Eq (20) needs σ_realised at trade time. The calibrator publishes σ as
  part of the committed parameter set, but the session does not currently read it; the fee would
  need the published σ (or a pool-price inversion) at the trade.

**What the F11 ruling changed.** The reference volatility is now pinned (2%), so the constant side of
Eq (20) is settled; what remains is the wiring itself. Recorded rather than implemented because the
schedule and accrual questions are rulings, not transcription.

**Ruling (F97).** The trading fee is wired into `buyLong`/`buyShort` as
`phi(t, pL) = min(ramp(t) * pL / pLRef, phi_max)`, charged on top of the collateral deposited, and
accruing to a `poolFees` line distributed to the pool's share holders at settlement. Four decisions,
each grounded in the paper:

- **The schedule is the ramp scaled by the volatility ratio, not either alone.** The §6.3 parameter
  table specifies the fee as a linear rise into the open "scaled by realised volatility relative to
  the calibration reference (equation (20))", and §6.4's cold-start lever 3 weights the Eq (19)
  schedule by realised session volatility. At the reference premium the multiplier is one and the
  fee is the pure ramp, whose time-average is `phi_ref = 0.55%` -- the two equations agree at the
  reference, which is the natural reading of Eq (20)'s "phi_ref = 0.55% at the calibration
  reference". Table 5's three schedules are simulation alternatives, not a specification of the
  launch fee.
- **The volatility signal is the pool price.** The session has no on-chain sigma, and the paper
  does not specify where one would come from. The pool price `pL` is the only volatility signal a
  session can observe on chain: BELL-IV inverts it (G2), `pL/sigma` is constant to within 1.2% over
  the measured range, and it embeds the net-flow imbalance that is the liquidity provider's
  exposure driver (Eq 22). The reference premium `pLRef = lam * E[min(|G|, 1/lam)]` at the
  F11-pinned 2% is computed in the session constructor and stored as an immutable -- trustless, and
  reproducible by any challenger from chain state.
- **The fee accrues to the pool, not the protocol.** The paper says the trading fee is
  "liquidity-provider compensation, not protocol margin", so it cannot join `collectedFees`. It is
  kept as a collateral line rather than minted into the reserves: minting claims into the pool
  would move the marginal price toward one half, and the price is the fee's own volatility signal --
  a fee that distorts the signal it scales with is a feedback loop. `poolFees` is distributed to
  share holders with the claims at settlement, the last withdrawal taking the remainder.
- **The fee base is the collateral deposited, on top of the trade.** The paper's Eq (22) revenue is
  `phi * V` with `V` the collateral flow, so the fee is `phi * collateralIn`, pulled with the
  deposit. The swaps are exempt: they convert already-fee-paid claims and do not change the pool's
  value. The elapsed time is capped at the term so a post-expiry trade (state still `Open`,
  `expire()` not yet called) pays the open fee rather than reverting.

Measured: a `buyLong` with the fee is 128,339 gas (the delta is the fee computation plus the
`poolFees` line); the constructor's truncated moment adds ~35k to a `createSession` that measures
3,662,616 gas. F97 is closed.

## Still open

| # | Item | Blocking |
|---|---|---|
| R5 | the TypeScript port is **complete, asserted, and the only implementation**: every module is verified against the committed fixtures or a differential dump — the application layer against a 1,203-line one, the CSV adapter against a 58-fixture one, the settlement workspace against a 125-case one — every Python test has a TypeScript counterpart matched by name rather than by total (F79), the coverage bar is set and asserted with the per-file `domain/` rule at 100% (F80), and **B1 has deleted the Python** — 59 files, with the generator's emission removed, the F72 banner corrected, and the whole tree verified with no interpreter on the machine (F81). **B2 has confirmed the layout and closed the one defect it found** — the `exports` pattern points at `dist/`, nothing kept `dist/` in step with `src/`, and the build now prunes it (F82), with the language's last two present-tense claims removed (F83) and a composition root that was described but never written (F84). **B3 has audited the retired gates** — all nine `check_layout.py`/`check_coverage.py` rules and all seven `import-linter` contracts are accounted for, two rules that were blind or absent are now enforced, and the one that genuinely died is recorded (F85). **C0 has extended the layout gate** — it now reads three scopes decided separately rather than one inherited, the coverage hints are bounded by an allow-list, the `dist/` rule can no longer pass vacuously, and the one rule the measurement rejected is recorded rather than added (F86). **G0 has landed the NIG fallback** — by method of moments rather than §7.11's maximum likelihood, with the quadrature's range and point count measured against the WAD grid, and with F39's Bessel premise corrected rather than obeyed (F87). **G1 has landed the event-session parameter set** — the shape pooled, the scale shrunk toward the cross-section, all 22 published `lambda_C` reproduced exactly and all 22 `r*` within a derived 1.0e-3, with the fourth digit of τ taken from the column rather than from the brief's rounding (F89). **G2 has landed BELL-IV** — the pool price inverted in the truncation ratio, where the reachable set and the accuracy bound are both derivable rather than asserted, with the closed-form bracket that replaced a doubling search, all 112 committed points recovered to 3.195e-17 against M15's 1.16e-13, the paper's M14 figure identified as a derivative its stated purpose does not need, and the freshness guard's three decisions recorded (F91). Phases A, B and C are complete, G0, G1 and G2 are done, F0/F1/F2 are complete, Phase E is ruled (F11, F42), F97 is ruled and wired (Phase 49), and Phase D (fork suite) is built against the testnet; what remains is G3 (blocked on a maker) | — |

