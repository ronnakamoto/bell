# Security

## The trust model

Stated explicitly, because the trust shift in this protocol is deliberate and the code is written to
make it visible rather than to hide it.

| Component | Trusted for | Not trusted for |
|---|---|---|
| Reference price feed | Reporting prints that occurred | Anything about the future |
| Off-chain premium publisher | Publishing a fitted parameter set | Fitting it after seeing the outcome |
| Arbiter | Ruling whether a committed parameter matches its committed inputs | Changing any parameter |
| Contract | Arithmetic, collateral custody, state transitions | Correctness of an external print |

**The trust shift.** The protocol does *not* ask the contract to reproduce the distributional fit.
Measuring showed that costs 685,590 gas against 2,640 for a storage read, a factor of about 260. The
oracle publishes the *transformed result* — a leverage and a premium — and the discretion that
creates is policed by a commitment, a bond and a deterministic re-run. `PremiumRegistry` is that
policing mechanism: specified in the paper's §7.11 and built in `contracts/src/pricing/`
(`PremiumStore` holds the record, `PremiumRegistry` the decisions). Its authority is narrow by
construction — it cannot alter a parameter, only rule on whether a committed one matches its
committed inputs — which is why `inputsHash` is load-bearing and why the ruling is a deterministic
re-run rather than a matter of testimony.

## What the design protects, and how

**Solvency.** `PI_L + PI_S == 1` for every reachable `(lambda, G)`. Theorem 1 in the paper, asserted
here by fuzz over generated inputs in `contracts/test/fuzz/Payoff.t.sol` and verified at a residual
of exactly zero. No margin, no liquidation, no cascade.

**Liability is bounded.** Both legs lie in `[0, 1]`, so neither side can owe more than it deposited.
This is the property that removes the liquidation engine rather than tuning it.

**The AMM cannot quote a parity arbitrage.** Marginal prices sum to one identically
(`Amm.priceLongWad(a, b) + Amm.priceLongWad(b, a) == 1e18`, to one wei of fixed-point rounding),
which is what makes the no-arbitrage band tight at its upper edge by construction rather than by
monitoring.

**Saturation is a chosen probability, not an observed one.** `lambda* = 1 / Q_(1-alpha)(|G|)` gives
`P(lambda* |G| >= 1) = alpha`. The rule is correct; the paper's §7.3 shows its *inputs* were the
problem, and that feeding it measured data delivers the stated rate.

## The guard set

Five settlement guards, under the paper's identifiers. **All five are built**, each with a positive
and a negative test, and the table records where each lives so a reader can check it rather than take
it on trust. This section previously read "none is built yet" — it was written before the stateful
core existed and was never updated, which is worse than useless in a security document: a reader would
conclude the protocol ships without G3, G8, G9, G10 or G10b.

| ID | Guard | Where it lives | Failure mode it prevents |
|---|---|---|---|
| G3 | Tier-1 halt band | `ReferencePrintBook.submitPrint` against `haltBandWad` | a feed fault or a bad print entering the print set |
| G8 | Multiplier drift | `ReferenceRegistry._multiplierDrifted`, routing to `Branch.CorporateActionTerminal` | a spurious gap recorded on every ex-date, roughly quarterly per name |
| G9 | Collateral decimals | asserted in the `SessionPool` constructor | an 18-decimal collateral producing a session wrong by 1e12 with no revert, no event and no signal |
| G10 | Issuer pause | `ReferenceRegistry._requireIssuerNotPaused`, opt-in through `pauseChecked` | settling on a feed frozen while a corporate action is processed |
| G10b | Sequencer uptime | `ReferencePrintBook._requireSequencerUp` | settling on stale L2 state |

Plus a plausibility check at the **ingestion** boundary, which is not one of the five: it rejects an
implausible gap before it can enter the print set. It is deliberately checked *before* the G3 halt
band, because the plausibility band is the wider of the two and a gross feed fault would otherwise be
reported as a halt — naming the wrong defect to whoever has to act on it. See DESIGN_NOTES.md F31.

### The pitfall the guard set must design against

The issuer-pause guard must **not** probe arbitrary tokens. A `staticcall` into an unverified
selector on a contract with a fallback executes that fallback, so "harmless because we check the
return value" holds only if the call returns. The paper records the first implementation doing
exactly this and taking two passing settlement scenarios red against the real chain — not with a
revert, but with a storage error at the RPC layer, before the return value was ever inspected.

The guard is therefore a **registry** (`setPauseChecked(token, bool)`): an unregistered reference is
never probed and settles exactly as it did before the guard existed. That is implemented, and the test
that matters — that an unregistered token is not probed, and settles on the live branch regardless —
is in `contracts/test/unit/ReferenceRegistry.t.sol`. The registry's own configuration surface
(authority-only, and refusing the zero address, which is the mapping's "not registered" value) is
tested alongside it.

## Residual risks, stated rather than glossed

These are not mitigated and the design does not pretend otherwise.

- **Oracle correctness.** The invariant guarantees solvency, not correctness. A wrong close or open
  print settles both legs wrongly while the protocol remains perfectly solvent. The invariant
  protects the system, not the participant. Given that corporate-action-adjusted oracles are an
  active unsolved problem, this deserves more attention than the design gives it.
- **Settlement-route manipulation.** Settlement is immune to on-chain price manipulation because the
  payoff is an even function of the gap. That covers one of five routes into the reference process;
  the other four are cheaper, and two are not priced anywhere in the design. The definitional route
  dominates the price route by at least 3.29x.
- **The void-at-half fallback is a free long butterfly**, struck at `c/2` and written by the protocol
  at no premium to its own hedgers: 29.7 basis points of notional per session, 14.3% of the premium
  paid. Route R1 must never ship. Route R2 removes it exactly at 0.021 bp.
- **Platform-level access control.** The chain's terms of service include a reset right allowing the
  platform to restrict wallet access. Not mitigable at the protocol layer; disclose it.
- **Regulatory characterisation.** The instrument sits at the intersection of three regimes rather
  than one. The compliance path is multi-year and is the single largest item on the critical path.
- **Dependency provenance.** Every Solidity dependency is vendored in `contracts/lib/` and pinned to
  an exact tag and commit, recorded in `contracts/lib/VENDOR.md`. There are no submodules and no
  floating refs. Python runtime dependencies in `domain/` are zero, enforced by `import-linter`.

## What is *not* protected

The invariant says nothing about the map from the world to the pair of prints. Settlement factors as
`world state -> (C, O) -> G -> PI_L`, and the design covers only the last two arrows. The first is the
protocol's entire residual risk, and it is not a mathematical object but a procedure.
