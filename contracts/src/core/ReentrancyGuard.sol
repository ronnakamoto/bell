// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ReentrancyGuard
/// @notice The secondary reentrancy defence. Checks-effects-interactions is the primary one.
/// @dev The brief is explicit that this must not be the only defence: *"Apply checks-effects-
///      interactions as the primary defence and a `nonReentrant` guard as the secondary. Do not rely
///      on the guard alone."* A guard stops a re-entrant call; it does not stop a state ordering
///      that is wrong in the first place, and the two failure modes need different fixes.
///
///      The guard is set in the constructor rather than at declaration so that a derived contract
///      cannot reorder storage and leave it at its default. `ENTERED` and `NOT_ENTERED` are
///      non-zero on purpose: a zero default would read as "not entered" and silently disable the
///      guard if the initialiser were ever skipped.
abstract contract ReentrancyGuard {
    /// @dev Thrown on a re-entrant call into a guarded function.
    error Reentered();

    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    /// @dev Slot 0 of the derived contract's layout. See the comment on the constructor.
    uint256 private _guardStatus;

    constructor() {
        _guardStatus = NOT_ENTERED;
    }

    /// @dev Guards a function against re-entry. Applied to every mutating entry point that moves
    ///      collateral or claims, which is every entry point that could re-enter.
    modifier nonReentrant() {
        if (_guardStatus == ENTERED) revert Reentered();
        _guardStatus = ENTERED;
        _;
        _guardStatus = NOT_ENTERED;
    }
}
