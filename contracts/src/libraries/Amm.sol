// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Constants} from "../generated/Constants.sol";
import {WadMath} from "./WadMath.sol";

/// @title Amm
/// @notice The two-claim constant-product market maker. Pure library; no storage, no events.
/// @dev The pool holds `a` long claims and `b` short claims against the invariant `k = a * b`.
///      Marginal prices are `pL = b/(a+b)` and `pS = a/(a+b)`, so `pL + pS == 1` identically and the
///      pool can never quote a set that admits a parity arbitrage (paper Eq 7, check M1).
///
///      There is deliberately no collateral/Long pair. A buyer does not swap collateral for Long:
///      she deposits collateral, the contract mints her an equal quantity of both claims, and she
///      swaps her Short leg into the pool for additional Long. The collateral therefore never leaves
///      the settlement contract, which is what keeps the sum-to-one invariant exact rather than
///      approximate (paper §4.4).
library Amm {
    /// @dev Thrown when the invariant is degenerate, i.e. one reserve is empty. With `k = 0` the
    ///      cost function is unbounded: the pool would hand over its entire reserve for an
    ///      arbitrarily small deposit.
    ///
    ///      **This is the only degenerate-input error the library declares**, and every function
    ///      that divides by a reserve checks it. There was previously a second error, `DivByZero`,
    ///      guarding a `denominator == 0` test in four places. All four were dead. In
    ///      `longReceived` and `shortReceived` the `a == 0 || b == 0` test above them already
    ///      guarantees a non-zero denominator, and in `longOutForShortIn` and `shortOutForLongIn`
    ///      the denominator is a reserve plus a quantity, which is zero only if the reserve is --
    ///      the case this error already names. An error that cannot be thrown is an untested path,
    ///      and the brief forbids those, so it was removed rather than tested around.
    error PoolDepthZero();

    /// @dev Thrown when a price is requested for a zero quantity, where the average is undefined.
    error ZeroQuantity();

    /// @notice The pool's marginal price of one Long claim, in collateral per claim.
    /// @param a long reserve at WAD scale.
    /// @param b short reserve at WAD scale.
    /// @return `b / (a + b)` at WAD scale.
    /// @dev Paper Eq (7). Together with the Short marginal price this sums to exactly one, which is
    ///      the property that makes the no-arbitrage band tight at its upper edge by construction
    ///      rather than by monitoring (paper Eq 11, check K11).
    function priceLongWad(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 depth = a + b;
        if (depth == 0) revert PoolDepthZero();
        return (b * Constants.WAD) / depth;
    }

    /// @notice The pool invariant.
    /// @return `a * b`.
    function k(uint256 a, uint256 b) internal pure returns (uint256) {
        return a * b;
    }

    /// @notice Long received for a given Short deposit, holding `k` fixed.
    /// @param a long reserve at WAD scale.
    /// @param b short reserve at WAD scale.
    /// @param shortIn short claims deposited.
    /// @return Long claims out: `a * shortIn / (b + shortIn)`.
    /// @dev From `(a - out) * (b + shortIn) = a * b`.
    ///
    ///      The depth guard is not decoration. Without it, `b == 0` and `shortIn > 0` returns
    ///      `a * shortIn / shortIn`, i.e. the *entire* long reserve, for an arbitrarily small short
    ///      deposit -- a pool-draining trade, and the same failure `PoolDepthZero` names above.
    ///      `SessionPool` rejects a zero reserve before it calls in, so this cannot be reached
    ///      through the protocol; the guard is here because a library that is only safe when its
    ///      caller is careful is not a library that is safe.
    function longOutForShortIn(uint256 a, uint256 b, uint256 shortIn)
        internal
        pure
        returns (uint256)
    {
        if (a == 0 || b == 0) revert PoolDepthZero();
        return (a * shortIn) / (b + shortIn);
    }

    /// @notice Short received for a given Long deposit, holding `k` fixed.
    /// @param a long reserve at WAD scale.
    /// @param b short reserve at WAD scale.
    /// @param longIn long claims deposited.
    /// @return Short claims out: `b * longIn / (a + longIn)`.
    /// @dev The mirror of `longOutForShortIn`, and the guard is there for the mirror reason: with
    ///      `a == 0` the expression collapses to `b`, draining the short reserve.
    function shortOutForLongIn(uint256 a, uint256 b, uint256 longIn)
        internal
        pure
        returns (uint256)
    {
        if (a == 0 || b == 0) revert PoolDepthZero();
        return (b * longIn) / (a + longIn);
    }

    /// @notice Collateral required to acquire `longOut` Long claims, in the rationalised form.
    /// @param a long reserve at WAD scale.
    /// @param b short reserve at WAD scale.
    /// @param longOut total Long claims to acquire, minted plus swapped.
    /// @return `x* = ( -(n - Q) + sqrt((n - Q)^2 + 4Qb) ) / 2` with `n = a + b`.
    /// @dev Paper Eq (8). The rationalised form is load-bearing, not cosmetic. The same quantity
    ///      computed as a difference of two nearly equal numbers loses every significant digit as
    ///      the trade falls relative to pool depth: the paper measures a maximum relative error of
    ///      2.88 for the naive arrangement at `Q/n ~ 1e-16`, against exactness here (check M10).
    ///      The subtraction below is that cancellation, and it is safe only because the numerator is
    ///      formed from the root first -- `sqrt(disc) >= |n - Q|`, so the difference is
    ///      non-negative and exact in the leading digits.
    ///
    ///      Bound: `n` and `Q` are cast to `int256` and `(n - Q)^2` is squared there, so the caller
    ///      must keep `n < 2^127`. The per-session notional cap keeps pool depth far below that; the
    ///      realistic scale is 1e24 at WAD.
    function costLongWad(uint256 a, uint256 b, uint256 longOut) internal pure returns (uint256) {
        if (a == 0 || b == 0) revert PoolDepthZero();
        // Casts to int256 are safe because pool depth and trade size are bounded by the per-session
        // notional cap, which keeps both far below 2^127; the realistic scale is 1e24 at WAD.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 offset = int256(a + b) - int256(longOut);
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 discriminant = offset * offset + int256(4 * longOut * b);
        uint256 root = WadMath.sqrt(uint256(discriminant));
        // The root is at least |offset|, so the difference is non-negative and the final cast
        // cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(int256(root) - offset) / 2;
    }

    /// @notice The naive linearised cost: `longOut` valued at the pool's marginal price.
    /// @dev Exists as a separate function, as the brief requires, because the *difference* between
    ///      it and `costLongWad` is the slippage the trader pays, and that difference is the thing
    ///      the test suite asserts the sign and monotonicity of. It is not a second implementation
    ///      of the cost: it is the first-order term the exact cost is expanded against.
    function linearisedCostLongWad(uint256 a, uint256 b, uint256 longOut)
        internal
        pure
        returns (uint256)
    {
        return WadMath.mulWad(longOut, priceLongWad(a, b));
    }

    /// @notice Total Long claims received for a collateral deposit.
    /// @param a long reserve at WAD scale.
    /// @param b short reserve at WAD scale.
    /// @param collateralIn collateral deposited.
    /// @return `Q = x * (x + a + b) / (x + b)`.
    /// @dev The exact inverse of `costLongWad`. Solving the quadratic in `x` for `Q` gives
    ///      `Q(x + b) = x^2 + x(a + b)`. Kept as the closed form rather than as a root-finder:
    ///      the paper measures the closed form at 1.80e-15 against 2.48e-08 for a numerical root
    ///      finder on the same quantity (check M2).
    ///
    ///      There is no `denominator == 0` check here, and the reason is arithmetic rather than
    ///      optimism: the depth guard above establishes `b != 0`, `collateralIn >= 0`, and Solidity
    ///      0.8 arithmetic reverts on overflow rather than wrapping, so `collateralIn + b >= 1`
    ///      always. A check that cannot fail is a branch that cannot be covered.
    function longReceived(uint256 a, uint256 b, uint256 collateralIn)
        internal
        pure
        returns (uint256)
    {
        if (a == 0 || b == 0) revert PoolDepthZero();
        return (collateralIn * (collateralIn + a + b)) / (collateralIn + b);
    }

    /// @notice Total Short claims received for a collateral deposit, by symmetry.
    /// @param a long reserve at WAD scale.
    /// @param b short reserve at WAD scale.
    /// @param collateralIn collateral deposited.
    /// @return `Q = x * (x + a + b) / (x + a)`.
    function shortReceived(uint256 a, uint256 b, uint256 collateralIn)
        internal
        pure
        returns (uint256)
    {
        if (a == 0 || b == 0) revert PoolDepthZero();
        return (collateralIn * (collateralIn + a + b)) / (collateralIn + a);
    }

    /// @notice The average price paid per Long claim.
    /// @dev `costLongWad / longOut`. Always at or above the marginal price, which is what makes the
    ///      sign of `slippageWad` well defined.
    function averagePriceWad(uint256 a, uint256 b, uint256 longOut)
        internal
        pure
        returns (uint256)
    {
        if (longOut == 0) revert ZeroQuantity();
        return (costLongWad(a, b, longOut) * Constants.WAD) / longOut;
    }

    /// @notice The slippage a trader pays, as a signed deviation from the marginal price.
    /// @return `averagePriceWad - priceLongWad`, at WAD scale.
    /// @dev Sign convention, stated because the brief's §4.1.3 wording ("positive means the trader
    ///      paid more than the average price") is not satisfiable -- a trader cannot pay more than
    ///      the average she paid. Positive here means the trader paid more than the *marginal*
    ///      price, i.e. the pool charged her a premium over the price she moved. That is the
    ///      quantity paper Eq (9) expands, `x*(Q)/Q - pL ~= (Q/n) * pL(1-pL)`, and it is
    ///      non-negative for every non-degenerate pool.
    ///
    ///      Signed rather than unsigned on purpose: the assertion that it is non-negative is a test
    ///      of the AMM, and an unsigned return would make the violation unrepresentable instead of
    ///      caught.
    function slippageWad(uint256 a, uint256 b, uint256 longOut) internal pure returns (int256) {
        return int256(averagePriceWad(a, b, longOut)) - int256(priceLongWad(a, b));
    }
}
