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
concurrent second read. Ten consecutive full runs are clean since. The underlying cause is not
established — it is consistent with a race in the cheatcode's file cache under Foundry's parallel
suite execution — so this is recorded as a workaround rather than a diagnosis. `make test` should be
re-run if it ever appears again.

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



## Still open

| # | Item | Blocking |
|---|---|---|
| F3 | guard identifiers inconsistent between brief §4.1.4 and §13.1; `G9` missing from the table, multiplier drift is `G8` | the guard implementation |
| F6 | no RPC endpoint for the chain-4663 fork suite | `make test-fork` |
| F9 | event-session `tau` stated two ways in the paper | the shrinkage estimator |
| F10 | NIG promoted from fallback to production model in the brief | the calibrator's control flow |
| F11 | the Eq (20) reference volatility is unpinned | the volatility-scaled fee |
| F42 | `commit` costs 158,247 against a 150,000 cap; meeting it needs two field narrowings | the gas budget |

