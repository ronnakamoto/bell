// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ISequencerUptimeFeed
/// @notice The L2 sequencer uptime probe, guard G10b.
/// @dev Read at ingestion *and* at resolution. Both are needed and they catch different failures: a
///      print submitted while the sequencer was down may be based on state that was never final, and
///      a session resolved during an outage may be resolving against a print whose ordering is not
///      yet determined.
///
///      The grace period is not optional. When a sequencer comes back it replays the transactions
///      that queued while it was down, so for a window after recovery the head of the chain is not
///      the head of the market. Resolving inside that window is resolving against a reordering.
interface ISequencerUptimeFeed {
    /// @notice Whether the sequencer is currently up.
    function sequencerUp() external view returns (bool);

    /// @notice The moment the sequencer last came back up, or zero if it has never been down.
    function lastUpTimestamp() external view returns (uint256);
}

/// @title IIssuerPauseOracle
/// @notice The issuer's pause flag, guard G10.
/// @dev The issuer documents that a paused oracle *may still return a value*, so the flag is advisory
///      and is not enforced on chain. A staleness check alone does not cover it, because the failure
///      mode is a feed that is frozen but not obviously stale.
///
///      This interface is only ever called against a token the registry has been told to check --
///      see `setPauseChecked`. That is not a convenience. A `staticcall` into an unverified selector
///      on a contract with a fallback *executes that fallback*, so "harmless because we check the
///      return value" holds only if the call returns at all. The paper records the first
///      implementation probing every reference and taking two passing settlement scenarios red
///      against the real chain -- not with a revert, but with a storage error at the RPC layer,
///      before the return value was ever inspected.
interface IIssuerPauseOracle {
    /// @notice Whether the issuer has paused this reference token's feed.
    function paused() external view returns (bool);
}

/// @title IMultiplierToken
/// @notice The reference token's corporate-action multiplier, guard G8.
/// @dev The token's price is the share price times this multiplier, so the multiplier moving between
///      registration and settlement means the headline return contains a distribution rather than a
///      market move. Reading it is what lets settlement route to the terminal corporate-action branch
///      instead of paying on a stale multiplier.
interface IMultiplierToken {
    /// @notice The current multiplier, at WAD scale. One (1e18) means no corporate action.
    function multiplier() external view returns (uint256);
}
