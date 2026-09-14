// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Branch
/// @notice The exhaustive set of ways a session can resolve.
/// @dev Resolution switches over every member with no `default` fallthrough, so adding a member is
///      a compile error at every switch rather than a silent fall-through to a permissive default.
///      "Fail closed" is the governing rule: an unresolvable state must revert or refuse, never
///      return a default. The brief's §4.1.4 enumerates four branches; `CorporateActionTerminal`
///      is the fifth, and it is the one paper §7.6 shows fires on a schedule (roughly quarterly
///      per name) because a corporate action drives settlement into it.
enum Branch {
    /// @dev A qualifying print arrived inside the staleness bound. Pay on it.
    LivePrint,
    /// @dev A qualifying print arrived but outside the freshness bound. Pay on it with the stale
    ///      flag set, so the caller can see the degradation rather than infer it.
    StalePrint,
    /// @dev No valid print, and the configured route refunds both legs at half value. Route R1
    ///      only. Paper §8.3 shows this is a free long butterfly struck at c/2, worth 29.7 bp of
    ///      notional per session, and it must never ship (paper §12.4, P0 gate).
    VoidAtHalf,
    /// @dev No valid print, and the configured route defers. Route R2, the recommended
    ///      architecture: it removes the free option exactly at a cost of 0.021 bp.
    Deferred,
    /// @dev The reference token's multiplier moved between deployment and settlement, so a
    ///      headline price would record a spurious gap. Pay on the corporate-action-adjusted
    ///      price instead. Guard G8.
    CorporateActionTerminal
}
