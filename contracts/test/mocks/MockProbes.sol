// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    IIssuerPauseOracle,
    IMultiplierToken,
    ISequencerUptimeFeed
} from "../../src/interfaces/ExternalProbes.sol";

/// @title MockReferenceToken
/// @notice A reference token stub carrying a multiplier and a pause flag.
/// @dev A mock is acceptable for these two properties and *not* for the ones the brief names, and the
///      distinction is worth stating. The property under test here is the registry's *response* to a
///      multiplier moving or a pause flag being set -- a control-flow property of the guard. Where
///      the real token's own behaviour is what is being guarded against -- the real `multiplier()`
///      semantics, the real pause flag's timing relative to a corporate action, the real
///      `decimals()` -- the brief forbids a mock and requires a pinned fork, and no mock is used
///      there.
contract MockReferenceToken is IMultiplierToken, IIssuerPauseOracle {
    uint256 public multiplier;
    bool public paused;

    constructor(uint256 multiplier_) {
        multiplier = multiplier_;
    }

    function setMultiplier(uint256 multiplier_) external {
        multiplier = multiplier_;
    }

    function setPaused(bool paused_) external {
        paused = paused_;
    }
}

/// @title MockSequencerFeed
/// @notice A sequencer uptime stub, for guard G10b.
/// @dev Deliberately a plain stub with no fallback and no unverified selector: the point of the
///      guard's opt-in registry is that a *real* token with a fallback must never be probed, and that
///      property is asserted against the real chain rather than here.
contract MockSequencerFeed is ISequencerUptimeFeed {
    bool public sequencerUp;
    uint256 public lastUpTimestamp;

    function setUp(bool up, uint256 lastUp) external {
        sequencerUp = up;
        lastUpTimestamp = lastUp;
    }
}
