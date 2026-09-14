// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {WadMath} from "../../src/libraries/WadMath.sol";
import {Amm} from "../../src/libraries/Amm.sol";

/// @notice Unit tests for `Amm`, the constant-product pool.
/// @dev Revert tests route through the `external*` wrappers at the foot of this file.
contract AmmTest is Test {
    uint256 internal constant A = 1000e18;
    uint256 internal constant B = 200e18;

    // ---------------------------------------------------------------- marginal price

    function test_priceLongWad_isTheReserveRatio() public pure {
        assertEq(Amm.priceLongWad(A, B), 0.166666666666666666e18, "b / (a + b)");
        assertEq(Amm.priceLongWad(1e18, 1e18), 0.5e18, "balanced pool");
        assertEq(Amm.priceLongWad(1e18, 0), 0, "no short reserve");
    }

    /// @dev Paper Eq (7) and check M1: the marginal prices of the two legs sum to exactly one, so
    ///      the pool can never quote a set that admits a parity arbitrage. `priceLongWad(b, a)` is
    ///      the Short marginal price, so this is the sum-to-one assertion without a second function.
    ///
    ///      The paper reports this as exact at 2.22e-16, which is floating-point exact. At WAD fixed
    ///      point each price is floored by an integer division, so the sum can sit one wei below one.
    ///      The tolerance is that wei, not a chosen number.
    function testFuzz_marginalPricesSumToExactlyOne(uint256 a, uint256 b) public pure {
        a = bound(a, 1e15, 1e30);
        b = bound(b, 1e15, 1e30);
        assertApproxEqAbs(
            Amm.priceLongWad(a, b) + Amm.priceLongWad(b, a), Constants.WAD, 1, "pL + pS == 1"
        );
    }

    function test_priceLongWad_revertsOnEmptyPool() public {
        vm.expectRevert(Amm.PoolDepthZero.selector);
        this.externalPriceLongWad(0, 0);
    }

    function test_k_isTheProductOfReserves() public pure {
        assertEq(Amm.k(A, B), A * B);
        assertEq(Amm.k(0, 5e18), 0);
    }

    // ---------------------------------------------------------------- swaps

    function test_longOutForShortIn_preservesK() public pure {
        uint256 shortIn = 10e18;
        uint256 out = Amm.longOutForShortIn(A, B, shortIn);
        // The invariant is preserved in real arithmetic; the pool floors the output, so `k` can
        // only rise. Asserted in both directions: never below, and equal to within the floor.
        assertGe((A - out) * (B + shortIn), Amm.k(A, B), "k never decreases");
        assertApproxEqRel((A - out) * (B + shortIn), Amm.k(A, B), 1e6, "k is preserved");
        assertEq(out, (A * shortIn) / (B + shortIn), "closed form");
    }

    function test_shortOutForLongIn_preservesK() public pure {
        uint256 longIn = 10e18;
        uint256 out = Amm.shortOutForLongIn(A, B, longIn);
        assertGe((A + longIn) * (B - out), Amm.k(A, B), "k never decreases");
        assertApproxEqRel((A + longIn) * (B - out), Amm.k(A, B), 1e6, "k is preserved");
    }

    // ---------------------------------------------------------------- the cost function

    /// @dev The paper's worked example (its §4.4), reproduced exactly: with a = 1,000, b = 200 and
    ///      Q = 20 it returns x* = 3.3801 against a published 3.38, an average price of 0.1690
    ///      against a marginal price of 0.167 (checks M7, K8).
    ///
    ///      Tolerance: `assertApproxEqRel` takes its tolerance in WAD, so 1e14 is one part in ten
    ///      thousand. The published figures carry four significant figures -- 3.3801, 0.1690,
    ///      0.167 -- and the coarsest of them, 0.167, carries a rounding uncertainty of 3e-3
    ///      relative. One part in ten thousand sits inside that, so the tolerance is bounded by the
    ///      precision the paper chose to quote rather than by the arithmetic.
    function test_costLongWad_reproducesThePublishedWorkedExample() public pure {
        uint256 cost = Amm.costLongWad(1000e18, 200e18, 20e18);
        assertApproxEqRel(cost, 3.380148e18, 1e14, "x*(Q) == 3.3801");
        assertApproxEqRel(Amm.averagePriceWad(1000e18, 200e18, 20e18), 0.169007e18, 1e14, "0.1690");
        assertApproxEqRel(Amm.priceLongWad(1000e18, 200e18), 0.166666e18, 1e14, "0.167 marginal");
    }

    function test_costLongWad_isZeroForZeroQuantity() public pure {
        assertEq(Amm.costLongWad(A, B, 0), 0);
    }

    function test_costLongWad_revertsOnDegeneratePool() public {
        vm.expectRevert(Amm.PoolDepthZero.selector);
        this.externalCostLongWad(0, B, 1e18);
        vm.expectRevert(Amm.PoolDepthZero.selector);
        this.externalCostLongWad(A, 0, 1e18);
    }

    /// @dev The exact cost and the linearised cost must both exist as separate functions, and the
    ///      difference between them -- the slippage -- must be strictly positive for any real trade.
    function test_linearisedCost_isStrictlyBelowTheExactCost() public pure {
        uint256 exact = Amm.costLongWad(A, B, 20e18);
        uint256 naive = Amm.linearisedCostLongWad(A, B, 20e18);
        assertLt(naive, exact, "linearised cost ignores the price impact");
        assertEq(naive, WadMath.mulWad(20e18, Amm.priceLongWad(A, B)), "naive is q * marginal");
    }

    // ---------------------------------------------------------------- the inverse

    function test_longReceived_invertsCostLongWad() public pure {
        uint256 longOut = 20e18;
        uint256 cost = Amm.costLongWad(A, B, longOut);
        assertApproxEqRel(Amm.longReceived(A, B, cost), longOut, 1e12, "round trip");
    }

    function test_shortReceived_invertsTheSymmetricCost() public pure {
        uint256 shortOut = 20e18;
        // By symmetry the Short cost is the Long cost with the reserves swapped.
        uint256 cost = Amm.costLongWad(B, A, shortOut);
        assertApproxEqRel(Amm.shortReceived(A, B, cost), shortOut, 1e12, "round trip");
    }

    function test_longReceived_revertsOnDegeneratePool() public {
        vm.expectRevert(Amm.PoolDepthZero.selector);
        this.externalLongReceived(0, B, 1e18);
    }

    function test_shortReceived_revertsOnDegeneratePool() public {
        vm.expectRevert(Amm.PoolDepthZero.selector);
        this.externalShortReceived(A, 0, 1e18);
    }

    // ---------------------------------------------------------------- slippage

    function test_averagePrice_revertsOnZeroQuantity() public {
        vm.expectRevert(Amm.ZeroQuantity.selector);
        this.externalAveragePriceWad(A, B, 0);
    }

    function test_slippageWad_isPositiveForARealTrade() public pure {
        assertGt(Amm.slippageWad(A, B, 20e18), 0, "trader pays above the marginal price");
        assertEq(
            Amm.slippageWad(A, B, 20e18),
            int256(Amm.averagePriceWad(A, B, 20e18)) - int256(Amm.priceLongWad(A, B)),
            "slippage is average minus marginal"
        );
    }

    function test_slippageWad_tendsToZeroWithTradeSize() public pure {
        assertLt(
            Amm.slippageWad(A, B, 1e15), Amm.slippageWad(A, B, 1e18), "slippage grows with size"
        );
    }

    // ---------------------------------------------------------------- external wrappers

    function externalPriceLongWad(uint256 a, uint256 b) external pure returns (uint256) {
        return Amm.priceLongWad(a, b);
    }

    function externalCostLongWad(uint256 a, uint256 b, uint256 q) external pure returns (uint256) {
        return Amm.costLongWad(a, b, q);
    }

    function externalLongReceived(uint256 a, uint256 b, uint256 x) external pure returns (uint256) {
        return Amm.longReceived(a, b, x);
    }

    function externalShortReceived(uint256 a, uint256 b, uint256 x)
        external
        pure
        returns (uint256)
    {
        return Amm.shortReceived(a, b, x);
    }

    function externalAveragePriceWad(uint256 a, uint256 b, uint256 q)
        external
        pure
        returns (uint256)
    {
        return Amm.averagePriceWad(a, b, q);
    }
}
