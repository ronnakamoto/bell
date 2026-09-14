// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {WadMath} from "../../src/libraries/WadMath.sol";
import {Amm} from "../../src/libraries/Amm.sol";

/// @notice The AMM invariants, as fuzz tests over generated inputs (brief §10.3).
contract AmmInvariants is Test {
    /// @dev `k` never decreases as a result of a swap; fees only increase it. Tested for the
    ///      fee-free swap here, where the invariant is preserved exactly -- the fee path adds to it
    ///      and is covered by the settlement suite.
    function testFuzz_kNeverDecreasesUnderASwap(uint256 a, uint256 b, uint256 shortIn) public pure {
        a = bound(a, 1e18, 1e27);
        b = bound(b, 1e18, 1e27);
        shortIn = bound(shortIn, 1e15, a / 2);

        uint256 out = Amm.longOutForShortIn(a, b, shortIn);
        uint256 afterK = Amm.k(a - out, b + shortIn);
        assertGe(afterK, Amm.k(a, b), "k never decreases");
    }

    /// @dev The trader always pays at least the marginal price. This is the sign assertion the brief
    ///      requires of the exact-versus-linearised difference.
    ///
    ///      The pool ratio is restricted to within two orders of magnitude. That is not a
    ///      convenience: a pool at a 1e9 ratio is priced at `pL ~ 1`, i.e. already saturated, which
    ///      is not a state a session can open in -- the listing gates and the notional cap both
    ///      prevent it. Outside that domain the integer divisions that form the average and the
    ///      marginal price can each floor by a wei and leave the difference a few wei negative,
    ///      which measures the truncation rather than the AMM.
    function testFuzz_slippageIsNeverNegative(uint256 a, uint256 b, uint256 q) public pure {
        a = bound(a, 1e20, 1e26);
        b = bound(b, a / 100, a * 100);
        q = bound(q, 1e15, a / 4);
        // The exact cost floors its integer square root, and `averagePriceWad` divides by the trade
        // size, so a one-wei cost error becomes `WAD / q` wei of price error. The slack is that
        // quotient plus a wei for each of the two divisions, and it is derived rather than chosen.
        int256 slack = int256(Constants.WAD / q + 2);
        assertGe(
            Amm.slippageWad(a, b, q),
            -slack,
            "the exact cost is at least the linearised cost, to within fixed-point rounding"
        );
    }

    /// @dev Slippage is monotone in trade size, which is what makes the depth condition of paper
    ///      Eq (10) meaningful.
    function testFuzz_slippageIsMonotoneInTradeSize(uint256 a, uint256 b, uint256 q) public pure {
        a = bound(a, 1e21, 1e27);
        b = bound(b, 1e21, 1e27);
        q = bound(q, 1e15, a / 4);
        assertLe(Amm.slippageWad(a, b, q), Amm.slippageWad(a, b, 2 * q), "slippage grows");
    }

    /// @dev The cost function and its inverse must round-trip. A divergence here would mean the
    ///      quoted price and the delivered quantity describe different trades.
    function testFuzz_costAndQuantityAreInverses(uint256 a, uint256 b, uint256 q) public pure {
        a = bound(a, 1e21, 1e27);
        b = bound(b, 1e21, 1e27);
        q = bound(q, 1e15, a / 2);
        uint256 cost = Amm.costLongWad(a, b, q);
        // The round trip is exact up to the two integer divisions, so the tolerance is one wei per
        // division plus the relative error of the recovered quantity.
        assertApproxEqRel(Amm.longReceived(a, b, cost), q, 1e12, "round trip");
    }

    /// @dev The invariant is preserved by the swap used to acquire Long, which is the pool's only
    ///      price-moving path. The cost function floors its integer square root, so `k` is preserved
    ///      to within the floor rather than bit-exactly.
    function testFuzz_costPathPreservesK(uint256 a, uint256 b, uint256 q) public pure {
        a = bound(a, 1e21, 1e27);
        b = bound(b, 1e21, 1e27);
        q = bound(q, 1e15, a / 2);

        uint256 collateralIn = Amm.costLongWad(a, b, q);
        uint256 longFromSwap = q - collateralIn;
        // The pool receives the minted Short leg and pays out the swapped Long leg.
        assertApproxEqRel(
            Amm.k(a - longFromSwap, b + collateralIn), Amm.k(a, b), 1e6, "invariant preserved"
        );
    }

    /// @dev Marginal prices sum to one for every pool, so no set of quotes admits a parity
    ///      arbitrage (paper Eq 7, check M1). The paper's 2.22e-16 is floating-point exact; at WAD
    ///      fixed point each price is floored, so the tolerance is one wei.
    function testFuzz_parityBandIsTightAtItsUpperEdge(uint256 a, uint256 b) public pure {
        a = bound(a, 1e15, 1e30);
        b = bound(b, 1e15, 1e30);
        uint256 sum = Amm.priceLongWad(a, b) + Amm.priceLongWad(b, a);
        assertApproxEqAbs(sum, Constants.WAD, 1, "pL + pS == 1");
    }
}
