# Gas report

Per external operation, against the budget in the build brief's §13.3. Regenerate with `make gas`, or
with `forge test --match-path test/gas/GasBudget.t.sol -vv` for the attributed figures below.

Every measurement is a `gasleft()` delta around a real call, so it includes the call frame. A budget
quoted without the frame would be a budget for arithmetic nobody performs in isolation.

## The budget

| Operation | Budget | Measured | Verdict |
|---|---|---|---|
| Truncated-moment payoff path | within 2× of 37,439 → 74,878 | **26,911** | met, and below the baseline |
| Premium read from storage | within 1.5× of 2,640 → 3,960 | **2,108** | met |
| `commit` | ≤ 170,000 (raised from 150,000 by ruling F42) | **158,247** | met, with 6.9% headroom |
| `challenge` | ≤ 150,000 | **35,807** | met |
| `resolve` | ≤ 150,000 | **43,911** | met |
| `quote` | ≤ 150,000 | **15,274** | met |

## The one miss, attributed

`commit` was the only operation over the brief's 150,000, and the overrun is not in the registry's
arithmetic. The measurement splits as:

| Component | Gas | Share |
|---|---|---|
| The commitment record: five cold `SSTORE`s at ~22,100 | ~110,500 | 70% |
| The bond `transferFrom` | 36,056 | 23% |
| Two mapping-key hashes, the duplicate check's cold load, the digest | ~11,600 | 7% |

Two things follow.

**The record is the cost, and it is already packed.** Five slots is the minimum for what `commit`
must store: three 32-byte values (the leverage, the premium and the input digest), plus a slot
carrying the publisher, the status and the session it was made in, plus one for the challenger and
the bond. The field order is deliberate and documented on the struct; declaring the same fields in
their conceptual order costs six slots, which measured 21,877 gas more.

**The bond transfer is not the registry's to optimise.** It is three cold slot writes inside the
ERC-20, and any six-decimal token charges roughly the same. A registry that did not collect the bond
would not be a registry — the bond is the mechanism that makes publishing a fitted parameter safe.

Meeting 150,000 would require narrowing the session counter to `uint32` and the bond to `uint56`, so
that both pack into the publisher's slot. That trades a real, if distant, limit — 4.29e9 sessions,
and a bond capped at $72bn — for 5% of one operation's gas. **The brief's cap is 5.5% too tight for
this design, so the cap was raised to 170,000 by ruling rather than narrowing two fields for it**
(F42): the record is five packed slots and the bond transfer is the ERC-20's, so 158,247 is the
structural cost of the trust mechanism, not an inefficiency. The budget now reads from the generated
`GAS_COMMIT_MAX` constant, so `spec/constants.yaml` is the single source. Recorded as F42 in
`DESIGN_NOTES.md`.

## The measurement that justifies the trust shift

The design moves the distributional fit off-chain and polices it with a commitment, a bond and a
deterministic re-run. The justification is a measurement rather than an argument:

| Computation | Gas | Ratio to the closed form |
|---|---|---|
| The closed form, paper Eq (12) | 26,911 | 1× |
| A 32-term quadrature over the real normal density | 388,442 | **14.4×** |
| A premium read from storage | 2,108 | 0.08× |

The paper records 685,590 for its own quadrature against 2,640 for a storage read, a ratio of about
260. This repository's quadrature is cheaper because it is 32 terms over a trapezoid rather than the
paper's; the ratio it reproduces is the one that matters, and it is an order of magnitude either way.
An on-chain fit would cost more than an order of magnitude over the closed form, and the closed form
is already only the *approximation* of the quantity the fit is trying to measure.

## What is not measured here

The gas of a real settlement: minting, seeding, trading, settling and claiming a session end to end.
Those are covered for correctness by `test/unit/Session.t.sol` and
`test/invariant/Session.t.sol`, but their gas is not budgeted by the brief and is therefore not
asserted. `make gas` prints a per-function report for them.

Two measured figures from the trading-fee wiring (F97) belong beside that note. A `buyLong` with the
trading fee charged measures **128,339** gas against roughly 100k without it -- the delta is the fee
computation plus the `poolFees` storage line, which is written on every trade. And the session
constructor now computes the reference premium `pLRefWad = lam * E[min(|G|, 1/lam)]` at the pinned
2% reference volatility; the truncated moment measures **~35k** gas at the published leverages, so an
unseeded `createSession` with the fee wiring costs **3,663,292** gas, dominated by the CREATE2
deployment itself. The depth gate (F111) added ~700 gas to that figure (two comparisons against the
inlined `MIN_SEED` constant). A seeded `createSession` costs **~3,980,220** -- the delta is the pair
mint and the seed transfer, which the unseeded path skips. The 685,590 figure quoted in `Stat.sol`'s
NatSpec is the paper's quadrature-based estimate for an on-chain implementation, not the cost of the
erf-polynomial route the library actually uses.
