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

**Requested input.** An archive-capable RPC URL for chain ID 4663, and confirmation that L2 block
61,228,000 is still retrievable. Note that §13.4's "no network access" requirement is in tension
with any fork test — I would treat the fork suite as an opt-in target (`make test-fork`) that is
skipped when `BELL_RPC_URL` is unset, so `make test` stays hermetic.

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

F3, F6, F7, F8, F9 and F10 remain open and are listed at the foot of this file.

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
here, so the brief's rejection of the Gaussian as a seed is re-measurable rather than asserted. The
Student-t, the NIG and the Merton jump-diffusion are named in the paper's Table 18 and absent from the
code. That is deliberate: F10 is open on whether NIG is the production model or a fallback for thin
samples, and implementing a family whose role is undecided would fix the answer by accident.
`family_for` raises a specific `NotImplementedError` naming F10 rather than a `KeyError`, because a
missing key reads as a typo and this absence is a decision.

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



## Still open

| # | Item | Blocking |
|---|---|---|
| R5 | the TypeScript port is **in progress**: the calibrator's `domain/` is written and verified against the digest fixture; `moments`, `leverage`, `sessions`, `families`, the application layer, the adapters, the settlement service, `tools/` and the 247 ported tests remain | the port |
| F3 | guard identifiers inconsistent between brief §4.1.4 and §13.1; `G9` missing from the table, multiplier drift is `G8` | the guard implementation |
| F6 | no RPC endpoint for the chain-4663 fork suite | `make test-fork` |
| F9 | event-session `tau` stated two ways in the paper | the shrinkage estimator |
| F10 | NIG promoted from fallback to production model in the brief | the calibrator's control flow |
| F11 | the Eq (20) reference volatility is unpinned | the volatility-scaled fee |
| F42 | `commit` costs 158,247 against a 150,000 cap; meeting it needs two field narrowings | the gas budget |

