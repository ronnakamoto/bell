// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {WadMath} from "../../src/libraries/WadMath.sol";

/// @notice Unit tests for `WadMath`. One file per unit under test (brief §6).
/// @dev Revert tests route through the `external*` wrappers at the foot of this file. The library's
///      functions are `internal`, so a direct call is inlined into this contract and never creates
///      a call frame; `vm.expectRevert` cannot observe a revert that happens at the cheatcode's own
///      depth. The wrappers exist only to supply that frame.
contract WadMathTest is Test {
    function test_mulWad_scalesByOneE18() public pure {
        assertEq(WadMath.mulWad(2e18, 3e18), 6e18, "2 * 3");
        assertEq(WadMath.mulWad(1e18, 1e18), 1e18, "1 * 1");
        assertEq(WadMath.mulWad(0, 123e18), 0, "zero absorbs");
        assertEq(WadMath.mulWad(0.5e18, 0.5e18), 0.25e18, "half squared");
    }

    function test_mulWad_truncatesTowardZero() public pure {
        // 1 wei * 1 wei / 1e18 truncates to zero rather than rounding up. Documented so that a
        // future change to rounding is a deliberate act.
        assertEq(WadMath.mulWad(1, 1), 0, "sub-wad product truncates");
    }

    function test_mulWad_revertsOnOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        this.externalMulWad(type(uint256).max, 2e18);
    }

    function test_divWad_scalesByOneE18() public pure {
        assertEq(WadMath.divWad(6e18, 3e18), 2e18, "6 / 3");
        assertEq(WadMath.divWad(1e18, 4e18), 0.25e18, "1 / 4");
        assertEq(WadMath.divWad(0, 5e18), 0, "zero numerator");
    }

    function test_divWad_revertsOnZeroDenominator() public {
        vm.expectRevert(WadMath.DivByZero.selector);
        this.externalDivWad(1e18, 0);
    }

    function test_absDiff_isSymmetricAndNeverNegative() public pure {
        assertEq(WadMath.absDiff(5e18, 3e18), 2e18, "larger first");
        assertEq(WadMath.absDiff(3e18, 5e18), 2e18, "smaller first");
        assertEq(WadMath.absDiff(7e18, 7e18), 0, "equal");
    }

    function test_minAndMax() public pure {
        assertEq(WadMath.min(1e18, 2e18), 1e18);
        assertEq(WadMath.max(1e18, 2e18), 2e18);
        assertEq(WadMath.min(2e18, 2e18), 2e18, "ties");
        assertEq(WadMath.max(0, 0), 0, "zeros");
    }

    function test_sqrt_knownValues() public pure {
        assertEq(WadMath.sqrt(0), 0, "sqrt(0)");
        assertEq(WadMath.sqrt(1), 1, "sqrt(1)");
        assertEq(WadMath.sqrt(2), 1, "sqrt(2) floors to 1");
        assertEq(WadMath.sqrt(3), 1, "sqrt(3) floors to 1");
        assertEq(WadMath.sqrt(4), 2, "sqrt(4)");
        assertEq(WadMath.sqrt(8), 2, "sqrt(8) floors to 2");
        assertEq(WadMath.sqrt(9), 3, "sqrt(9)");
        assertEq(WadMath.sqrt(15), 3, "sqrt(15) floors to 3");
        assertEq(WadMath.sqrt(16), 4, "sqrt(16)");
        assertEq(WadMath.sqrt(1e36), 1e18, "sqrt of a WAD square");
    }

    function test_sqrt_isExactOnPerfectSquares() public pure {
        for (uint256 n = 0; n < 200; ++n) {
            assertEq(WadMath.sqrt(n * n), n, "perfect square");
            if (n > 0) {
                // One below a perfect square must floor to n - 1.
                assertEq(WadMath.sqrt(n * n - 1), n - 1, "just below a perfect square");
            }
        }
    }

    /// @dev The property that defines integer square root: `z^2 <= x < (z + 1)^2`.
    function testFuzz_sqrt_isTheFloorOfTheRealRoot(uint256 x) public pure {
        x = bound(x, 0, type(uint128).max);
        uint256 z = WadMath.sqrt(x);
        assertLe(z * z, x, "square does not exceed the radicand");
        assertGt((z + 1) * (z + 1), x, "next square exceeds the radicand");
    }

    function testFuzz_sqrt_ofWadScaleInput(uint256 x) public pure {
        x = bound(x, 0, type(uint192).max);
        uint256 z = WadMath.sqrt(x);
        assertLe(z * z, x);
        assertGt((z + 1) * (z + 1), x);
    }

    /// @dev The extremal radicand must not overflow inside the `unchecked` block.
    function test_sqrt_handlesExtremalRadicand() public pure {
        uint256 z = WadMath.sqrt(type(uint256).max);
        assertLe(z * z, type(uint256).max);
        assertEq(z, type(uint128).max, "floor(sqrt(2^256 - 1)) == 2^128 - 1");
    }

    // ---------------------------------------------------------------- external wrappers

    function externalMulWad(uint256 a, uint256 b) external pure returns (uint256) {
        return WadMath.mulWad(a, b);
    }

    function externalDivWad(uint256 a, uint256 b) external pure returns (uint256) {
        return WadMath.divWad(a, b);
    }
}
