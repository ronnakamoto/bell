// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Constants} from "../generated/Constants.sol";

/// @title WadMath
/// @notice Fixed-point arithmetic at 1e18. Pure, internal, no storage, no events.
/// @dev Every multiplication that could overflow is left to Solidity 0.8 checked arithmetic. The
///      library contains exactly one `unchecked` block, in `sqrt`, and it carries the proof that
///      makes it safe. No other function may reach for `unchecked`.
library WadMath {
    /// @dev Thrown when a WAD division is asked for with a zero denominator.
    error DivByZero();

    /// @notice `a * b / 1e18`, rounded toward zero.
    /// @dev No `unchecked`: `a * b` can overflow for operands above ~3.4e38, and a silent wrap here
    ///      would corrupt a payoff rather than revert. The revert is the desired behaviour.
    function mulWad(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / Constants.WAD;
    }

    /// @notice `a * 1e18 / b`, rounded toward zero.
    /// @param b denominator; must be non-zero.
    function divWad(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) revert DivByZero();
        return (a * Constants.WAD) / b;
    }

    /// @notice `|a - b|`.
    /// @dev Branches rather than subtracting in `unchecked`; the branch is cheaper than the
    ///      alternative of a checked subtraction that would revert on the larger operand.
    function absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? a - b : b - a;
    }

    /// @notice The smaller of `a` and `b`.
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice The larger of `a` and `b`.
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /// @notice `floor(sqrt(x))`.
    /// @dev Newton's method, held as "best so far" plus "next iterate". `z` starts at `x`, which is
    ///      an over-estimate for every `x >= 1`, and the loop replaces it with each strictly smaller
    ///      iterate `y = (x / y + y) / 2`, halting when the iterate stops decreasing. Because Newton
    ///      started above the root converges monotonically downward and then oscillates within one
    ///      unit, the last `z` before the halt is exactly `floor(sqrt(x))`.
    ///
    ///      The first iterate is `ceil(x / 2)`, written as `x / 2 + x % 2` so that it cannot
    ///      overflow on `type(uint256).max` the way `(x + 1) / 2` would.
    ///
    ///      This is the library's only `unchecked` block. The bound that makes it safe: the loop
    ///      maintains `z >= floor(sqrt(x))`, hence `x / z <= sqrt(x) <= z` and the new iterate is at
    ///      most `2z`. The sum `x / z + z` is largest at the first iterate `z = ceil(x / 2)`, where
    ///      it is about `2 + x / 2 < 2^255` for every `x < 2^256`; every later iterate is smaller.
    ///      The block exists to keep the loop cheap, not to widen the domain.
    ///
    ///      The brief asks for a revert on negative input. The radicand is `uint256`, so no
    ///      negative input exists and no such error is declared: a custom error with no reachable
    ///      trigger is an untested path, which the brief forbids elsewhere.
    function sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        unchecked {
            uint256 z = x;
            uint256 y = x / 2 + (x % 2);
            while (y < z) {
                z = y;
                y = (x / y + y) / 2;
            }
            return z;
        }
    }
}
