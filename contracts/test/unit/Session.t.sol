// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {Amm} from "../../src/libraries/Amm.sol";
import {WadMath} from "../../src/libraries/WadMath.sol";
import {ClaimToken} from "../../src/core/ClaimToken.sol";
import {Session} from "../../src/core/Session.sol";
import {SessionPool} from "../../src/core/SessionPool.sol";
import {MockERC20, MockNonRevertingERC20} from "../mocks/MockERC20.sol";

/// @notice The session lifecycle, the collateral ledger and the pool.
/// @dev One file per unit under test. Revert assertions use the exact selector and the exact
///      parameters, because an error path that has never been observed to fire is indistinguishable
///      from one that does nothing.
contract SessionTest is Test {
    /// @dev Six decimals, matching USDG. The unit is 1e6, so "one dollar" is `1e6`.
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant LAM = 15e18;
    uint256 internal constant NOTIONAL_CAP = 5_000_000 * UNIT;
    uint256 internal constant HOURS_17_5 = 17.5e18;

    /// @dev The canonical seed, named so that a test asserting on `totalPairSupply` does not have to
    ///      re-derive the pair count from two amounts and get it wrong.
    uint256 internal constant SEED_LONG = 1_000_000 * UNIT;
    uint256 internal constant SEED_SHORT = 200_000 * UNIT;

    address internal constant REFERENCE_TOKEN = address(0xBEEF);
    address internal constant REFERENCE_REGISTRY = address(0xA11CE);
    address internal constant FACTORY = address(0xFAC);

    MockERC20 internal collateral;
    Session internal session;

    address internal alice = address(0xA1);
    address internal bob = address(0xB0);

    function setUp() public {
        collateral = new MockERC20("USD Global", "USDG", 6);
        vm.warp(1_800_000_000);
        vm.prank(FACTORY);
        session = new Session(
            collateral,
            REFERENCE_TOKEN,
            LAM,
            block.timestamp + 17.5 hours,
            NOTIONAL_CAP,
            REFERENCE_REGISTRY
        );
        // Funded well above the largest seed any test performs, so that an `InsufficientBalance` in
        // a test is always a finding about the contract rather than about the fixture.
        _fund(alice, 10_000_000 * UNIT);
        _fund(bob, 10_000_000 * UNIT);
        _fund(address(this), 10_000_000 * UNIT);
    }

    // ---------------------------------------------------------------- construction

    function test_constructor_createsBothClaimLegs() public view {
        ClaimToken longClaim = session.longClaim();
        ClaimToken shortClaim = session.shortClaim();
        assertEq(longClaim.symbol(), "GAP-L");
        assertEq(shortClaim.symbol(), "GAP-S");
        assertEq(longClaim.session(), address(session));
        assertEq(shortClaim.session(), address(session));
        assertEq(longClaim.decimals(), 6, "claims share the collateral's scale");
    }

    function test_constructor_revertsOnUnexpectedCollateralDecimals() public {
        // Guard G9. An 18-decimal collateral against a 6-decimal expectation produces a session wrong
        // by 1e12 with no revert, no event and no signal, which is why it is asserted here.
        MockERC20 eighteen = new MockERC20("Bad", "BAD", 18);
        vm.prank(FACTORY);
        vm.expectRevert(
            abi.encodeWithSelector(SessionPool.CollateralDecimalsUnsupported.selector, 18, 6)
        );
        new Session(
            eighteen,
            REFERENCE_TOKEN,
            LAM,
            block.timestamp + 1 hours,
            NOTIONAL_CAP,
            REFERENCE_REGISTRY
        );
    }

    function test_constructor_revertsOnZeroLeverage() public {
        vm.prank(FACTORY);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        new Session(
            collateral,
            REFERENCE_TOKEN,
            0,
            block.timestamp + 1 hours,
            NOTIONAL_CAP,
            REFERENCE_REGISTRY
        );
    }

    function test_constructor_revertsOnAnExpiryInThePast() public {
        vm.prank(FACTORY);
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.ExpiryNotReached.selector, block.timestamp, block.timestamp
            )
        );
        new Session(
            collateral, REFERENCE_TOKEN, LAM, block.timestamp, NOTIONAL_CAP, REFERENCE_REGISTRY
        );
    }

    function test_termIsSeventeenAndAHalfHours() public view {
        // WAD-scale hours, because a whole-hour term would misprice the flagship session by 3%.
        assertEq(session.termHoursWad(), HOURS_17_5);
    }

    // ---------------------------------------------------------------- mint and redeem

    function test_mintPair_mintsBothLegsAndPullsCollateral() public {
        uint256 amount = 1_000 * UNIT;
        _mintPairAs(alice, amount);

        assertEq(session.longClaim().balanceOf(alice), amount);
        assertEq(session.shortClaim().balanceOf(alice), amount);
        assertEq(session.totalPairSupply(), amount);
        assertEq(collateral.balanceOf(address(session)), amount);
        assertTrue(session.isCollateralised());
    }

    function test_mintPair_enforcesTheNotionalCap() public {
        uint256 over = NOTIONAL_CAP + 1;
        _approve(alice, over);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Session.NotionalCapExceeded.selector, over, NOTIONAL_CAP)
        );
        session.mintPair(over);
        assertEq(session.totalPairSupply(), 0, "the cap is checked before any state mutation");
    }

    function test_mintPair_rejectsZero() public {
        vm.prank(alice);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.mintPair(0);
    }

    function test_mintPair_isClosedOnceExpired() public {
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        _approve(alice, 100 * UNIT);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.WrongState.selector, Session.State.Expired, Session.State.Open
            )
        );
        session.mintPair(100 * UNIT);
    }

    function test_redeemPair_returnsCollateralLessTheProtocolFee() public {
        uint256 amount = 10_000 * UNIT;
        _seed(alice, 5_000 * UNIT, 1_000 * UNIT);
        _mintPairAs(bob, amount);

        uint256 before = collateral.balanceOf(bob);
        uint256 supplyBefore = session.totalPairSupply();
        vm.prank(bob);
        session.redeemPair(amount);

        uint256 fee = session.collectedFees();
        assertEq(collateral.balanceOf(bob) - before, amount - fee, "collateral less fee");
        // The fee is the term-prorated annualised rate: 12% * 17.5h / 8760h = 2.397 bp. The tolerance
        // is one part in a thousand, derived from the published figure's four significant figures
        // rather than chosen: the exact proration is 2.397260273972603 bp, so a comparison against a
        // four-figure 2.397 carries a 1.1e-4 relative rounding uncertainty of its own.
        assertApproxEqRel(fee, (amount * 2.397e14) / Constants.WAD, 1e15, "overnight fee");
        assertEq(session.totalPairSupply(), supplyBefore - amount, "pairs retired");
    }

    // ---------------------------------------------------------------- the pool

    function test_seedPool_setsTheInitialPrice() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        assertEq(session.longReserve(), 1_000 * UNIT);
        assertEq(session.shortReserve(), 200 * UNIT);
        assertEq(session.poolPriceLongWad(), (200 * Constants.WAD) / 1_200, "b / (a + b)");
        assertEq(session.totalPoolShares(), 1_200 * UNIT);
        assertEq(session.poolShares(alice), 1_200 * UNIT);
    }

    function test_seedPool_refusesADepositThatWouldMoveThePrice() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        _approve(bob, 200 * UNIT);
        _approveClaims(bob, 200 * UNIT);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionPool.PoolRatioMismatch.selector,
                50 * UNIT,
                200 * UNIT,
                1_000 * UNIT,
                200 * UNIT
            )
        );
        session.seedPool(50 * UNIT, 200 * UNIT);
    }

    function test_seedPool_acceptsAProportionalDeposit() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        _seed(bob, 500 * UNIT, 100 * UNIT);
        assertEq(session.longReserve(), 1_500 * UNIT);
        assertEq(session.shortReserve(), 300 * UNIT);
        assertEq(session.poolShares(bob), 600 * UNIT, "one share is one claim unit of pool");
    }

    function test_poolPriceIsOneMinusItself() public {
        // The parity band is tight at its upper edge by construction, to one wei of fixed-point
        // rounding: the two marginal prices are each floored by an integer division.
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        uint256 priceLong = session.poolPriceLongWad();
        uint256 priceShort = Amm.priceLongWad(session.shortReserve(), session.longReserve());
        assertApproxEqAbs(priceLong + priceShort, Constants.WAD, 1, "pL + pS == 1");
    }

    function test_poolPrice_revertsOnAnUnseededPool() public {
        vm.expectRevert(SessionPool.PoolDepthZero.selector);
        session.poolPriceLongWad();
    }

    // ---------------------------------------------------------------- trading

    function test_buyLong_deliversTheMintedLegPlusTheSwappedOne() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        uint256 collateralIn = 1_000 * UNIT;
        uint256 expectedSwap =
            Amm.longOutForShortIn(session.longReserve(), session.shortReserve(), collateralIn);
        uint256 before = session.longClaim().balanceOf(bob);

        // The trading fee is pulled with the collateral, so the allowance covers the deposit and
        // the fee; the fee itself is asserted by the dedicated fee tests.
        _approve(bob, collateralIn * 2);
        vm.prank(bob);
        session.buyLong(collateralIn, 0);

        assertEq(
            session.longClaim().balanceOf(bob) - before,
            collateralIn + expectedSwap,
            "minted plus swapped"
        );
        // The seed minted SEED_LONG + SEED_SHORT pairs before the trade.
        assertEq(session.totalPairSupply(), SEED_LONG + SEED_SHORT + collateralIn);
        assertTrue(session.isCollateralised(), "solvency holds through a trade");
    }

    function test_buyLong_enforcesTheSlippageFloor() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        uint256 collateralIn = 1_000 * UNIT;
        uint256 expectedSwap =
            Amm.longOutForShortIn(session.longReserve(), session.shortReserve(), collateralIn);
        uint256 impossible = collateralIn + expectedSwap + 1;

        _approve(bob, collateralIn);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionPool.SlippageExceeded.selector, collateralIn + expectedSwap, impossible
            )
        );
        session.buyLong(collateralIn, impossible);
    }

    function test_swapShortForLong_movesThePoolAndPreservesK() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        _mintPairAs(bob, 5_000 * UNIT);
        _approveClaims(bob, 5_000 * UNIT);

        uint256 kBefore = Amm.k(session.longReserve(), session.shortReserve());
        uint256 longBefore = session.longClaim().balanceOf(bob);
        vm.prank(bob);
        session.swapShortForLong(5_000 * UNIT, 0);

        assertGt(session.longClaim().balanceOf(bob), longBefore, "received long");
        assertApproxEqRel(
            Amm.k(session.longReserve(), session.shortReserve()), kBefore, 1e6, "k preserved"
        );
    }

    /// @notice The Short side of the trade, which is the mirror of `buyLong` and was untested.
    /// @dev Found by reading the branch-coverage report rather than by reading the tests: the whole
    ///      of `SessionPool._acquireShort` had zero hits, because nothing in the unit suite ever
    ///      bought a Short. The invariant suite calls `buyShort`, but an invariant handler picks a
    ///      branch per run, so a path can stay cold for a long time and report as covered only in
    ///      the aggregate. A mirror of the Long test is cheap and it is the only thing that pins the
    ///      direction.
    function test_buyShort_deliversTheMintedLegPlusTheSwappedOne() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        uint256 collateralIn = 1_000 * UNIT;
        uint256 expectedSwap =
            Amm.shortOutForLongIn(session.longReserve(), session.shortReserve(), collateralIn);
        uint256 before = session.shortClaim().balanceOf(bob);

        _approve(bob, collateralIn * 2);
        vm.prank(bob);
        session.buyShort(collateralIn, 0);

        assertEq(
            session.shortClaim().balanceOf(bob) - before,
            collateralIn + expectedSwap,
            "minted plus swapped"
        );
        assertEq(session.totalPairSupply(), SEED_LONG + SEED_SHORT + collateralIn);
        assertTrue(session.isCollateralised(), "solvency holds through a short-side trade");
    }

    function test_buyShort_enforcesTheSlippageFloor() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        uint256 collateralIn = 1_000 * UNIT;
        uint256 expectedSwap =
            Amm.shortOutForLongIn(session.longReserve(), session.shortReserve(), collateralIn);
        uint256 impossible = collateralIn + expectedSwap + 1;

        _approve(bob, collateralIn);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionPool.SlippageExceeded.selector, collateralIn + expectedSwap, impossible
            )
        );
        session.buyShort(collateralIn, impossible);
    }

    /// @notice Buying a Short moves the pool the opposite way from buying a Long.
    /// @dev The assertion that makes this test worth having rather than a second copy of the one
    ///      above: it pins the *direction* of each reserve. A sign error in `_acquireShort` --
    ///      `longReserve -= collateralIn` instead of `+=` -- would satisfy every other test in this
    ///      file, because each of them only ever checks the leg the trader received and the
    ///      invariant `k`, and `k` is preserved by the wrong sign too.
    function test_buyShort_movesThePoolTheOppositeWayFromBuyLong() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        uint256 collateralIn = 1_000 * UNIT;
        uint256 a = session.longReserve();
        uint256 b = session.shortReserve();
        uint256 swap = Amm.shortOutForLongIn(a, b, collateralIn);

        _approve(bob, collateralIn * 2);
        vm.prank(bob);
        session.buyShort(collateralIn, 0);

        assertEq(session.longReserve(), a + collateralIn, "the long reserve grows by the deposit");
        assertEq(session.shortReserve(), b - swap, "the short reserve falls by what was paid out");
    }

    // ---------------------------------------------------------------- trading fee (F97)

    /// @dev Seeds the pool at the reference premium, so the fee's volatility multiplier is exactly
    ///      one and the fee is the pure ramp. The long price is `b / (a + b)`, so a premium of
    ///      `pLRef` needs `a / b = (1 - pLRef) / pLRef`.
    function _seedAtReferencePremium(address who) internal {
        uint256 pLRef = session.pLRefWad();
        uint256 shortIn = 1_000_000 * UNIT;
        uint256 longIn = WadMath.mulWad(shortIn, WadMath.divWad(Constants.WAD - pLRef, pLRef));
        _seed(who, longIn, shortIn);
    }

    function test_buyLong_chargesTheTradingFeeToThePool() public {
        _seedAtReferencePremium(alice);
        uint256 collateralIn = 1_000 * UNIT;
        _approve(bob, collateralIn * 2);
        vm.prank(bob);
        session.buyLong(collateralIn, 0);

        // At the reference premium and elapsed zero the fee is the ramp's close value, phi_0.
        uint256 expectedFee = WadMath.mulWad(collateralIn, Constants.RAMP_PHI_0_WAD);
        assertEq(session.poolFees(), expectedFee, "the fee accrues to the pool");
        assertEq(session.collectedFees(), 0, "not protocol margin");
    }

    function test_buyShort_chargesTheTradingFeeToThePool() public {
        _seedAtReferencePremium(alice);
        uint256 collateralIn = 1_000 * UNIT;
        _approve(bob, collateralIn * 2);
        vm.prank(bob);
        session.buyShort(collateralIn, 0);

        uint256 expectedFee = WadMath.mulWad(collateralIn, Constants.RAMP_PHI_0_WAD);
        assertEq(session.poolFees(), expectedFee, "the fee accrues to the pool");
    }

    /// @dev The volatility multiplier is Eq (20)'s ratio with the pool price as the on-chain
    ///      volatility signal: doubling the price doubles the fee, below the cap.
    function test_tradingFee_scalesWithThePoolPrice() public {
        uint256 pLRef = session.pLRefWad();
        uint256 shortIn = 1_000_000 * UNIT;
        uint256 longIn =
            WadMath.mulWad(shortIn, WadMath.divWad(Constants.WAD - 2 * pLRef, 2 * pLRef));
        _seed(alice, longIn, shortIn);

        uint256 collateralIn = 1_000 * UNIT;
        _approve(bob, collateralIn * 2);
        vm.prank(bob);
        session.buyLong(collateralIn, 0);

        uint256 expectedFee = WadMath.mulWad(collateralIn, 2 * Constants.RAMP_PHI_0_WAD);
        assertEq(session.poolFees(), expectedFee, "linear in the premium");
    }

    /// @dev The fee is a collateral line, never claims, so the reserves move only by the swap and
    ///      the marginal price is untouched by it -- the fee cannot distort the volatility signal
    ///      it scales with.
    function test_tradingFee_isPriceNeutral() public {
        _seedAtReferencePremium(alice);
        uint256 a = session.longReserve();
        uint256 b = session.shortReserve();
        uint256 collateralIn = 1_000 * UNIT;
        uint256 swap = Amm.longOutForShortIn(a, b, collateralIn);

        _approve(bob, collateralIn * 2);
        vm.prank(bob);
        session.buyLong(collateralIn, 0);

        assertEq(session.longReserve(), a - swap, "long reserve moves by the swap only");
        assertEq(
            session.shortReserve(), b + collateralIn, "short reserve moves by the deposit only"
        );
    }

    /// @dev The trading fee is liquidity-provider compensation: at settlement the whole fee line
    ///      reaches the pool's share holders with the claims.
    function test_withdrawPool_distributesPoolFeesToLiquidityProviders() public {
        _seedAtReferencePremium(alice);
        uint256 collateralIn = 1_000 * UNIT;
        _approve(bob, collateralIn * 2);
        vm.prank(bob);
        session.buyLong(collateralIn, 0);
        uint256 fees = session.poolFees();
        assertGt(fees, 0, "the trade accrued a fee");

        uint256 poolLong = session.longClaim().balanceOf(address(session));
        uint256 poolShort = session.shortClaim().balanceOf(address(session));

        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.4e18, false);

        uint256 before = collateral.balanceOf(alice);
        vm.prank(alice);
        session.withdrawPool();
        uint256 payout = collateral.balanceOf(alice) - before;

        // Alice holds every share, so the withdrawal is the pool's claims at the settled payoff
        // plus the whole fee line.
        uint256 claimsPayout =
            WadMath.mulWad(poolLong, 0.4e18) + WadMath.mulWad(poolShort, Constants.WAD - 0.4e18);
        assertEq(payout, claimsPayout + fees, "the fee reaches the LP");
        assertEq(session.poolFees(), 0, "the fee line is exhausted");
    }

    function test_swapLongForShort_movesThePoolAndPreservesK() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        _mintPairAs(bob, 5_000 * UNIT);
        _approveClaims(bob, 5_000 * UNIT);

        uint256 kBefore = Amm.k(session.longReserve(), session.shortReserve());
        uint256 shortBefore = session.shortClaim().balanceOf(bob);
        vm.prank(bob);
        session.swapLongForShort(5_000 * UNIT, 0);

        assertGt(session.shortClaim().balanceOf(bob), shortBefore, "received short");

        // `k` can only rise, because the pool floors the payout it hands over. That inequality is
        // the invariant; the relative bound below is the floor's contribution and nothing more.
        //
        // It is looser here than in `swapShortForLong` above, and the reason is not sloppiness: the
        // seeded pool's short reserve is about five times smaller than its long reserve, so a payout
        // drawn from it floors a correspondingly larger fraction. Measured drift is 3.1e-10% against
        // 1e-10% for the other direction, which is why one tolerance cannot serve both.
        uint256 kAfter = Amm.k(session.longReserve(), session.shortReserve());
        assertGe(kAfter, kBefore, "k never decreases");
        assertApproxEqRel(kAfter, kBefore, 1e8, "k is preserved to within the integer floor");
    }

    /// @notice `poolDepth()` is the denominator of the slippage law, so it must be the sum.
    function test_poolDepth_isTheSumOfTheReserves() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        assertEq(
            session.poolDepth(), session.longReserve() + session.shortReserve(), "depth is a + b"
        );
    }

    /// @notice Every path that prices against the pool refuses an unseeded one.
    /// @dev Found by coverage, and the four are worth grouping because they are one rule: a pool with
    ///      an empty reserve has no price, so every entry point that would derive one must refuse
    ///      rather than quote. Three of these four guards are the ones added in this session after
    ///      `Amm` began refusing the degenerate case — adding a guard and not testing it would have
    ///      been the same mistake one layer up.
    ///
    ///      `_acquireLong` and `_acquireShort` already had theirs; `_swapShortForLong` and
    ///      `_swapLongForShort` did not, which is how a trade could have taken a whole reserve.
    function test_buyLong_revertsOnAnUnseededPool() public {
        _approve(bob, 100 * UNIT);
        vm.prank(bob);
        vm.expectRevert(SessionPool.PoolDepthZero.selector);
        session.buyLong(100 * UNIT, 0);
    }

    function test_buyShort_revertsOnAnUnseededPool() public {
        _approve(bob, 100 * UNIT);
        vm.prank(bob);
        vm.expectRevert(SessionPool.PoolDepthZero.selector);
        session.buyShort(100 * UNIT, 0);
    }

    function test_swapShortForLong_revertsOnAnUnseededPool() public {
        // Holding a pair is not the same as a seeded pool: `mintPair` mints both legs to the caller
        // and moves nothing into the reserves.
        _mintPairAs(bob, 1_000 * UNIT);
        _approveClaims(bob, 1_000 * UNIT);
        assertEq(session.longReserve(), 0, "the pool is still empty");

        vm.prank(bob);
        vm.expectRevert(SessionPool.PoolDepthZero.selector);
        session.swapShortForLong(100 * UNIT, 0);
    }

    function test_swapLongForShort_revertsOnAnUnseededPool() public {
        _mintPairAs(bob, 1_000 * UNIT);
        _approveClaims(bob, 1_000 * UNIT);

        vm.prank(bob);
        vm.expectRevert(SessionPool.PoolDepthZero.selector);
        session.swapLongForShort(100 * UNIT, 0);
    }

    function test_seedPool_refusesAZeroDeposit() public {
        _mintPairAs(alice, 1_000 * UNIT);
        _approveClaims(alice, 1_000 * UNIT);
        vm.prank(alice);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.seedPool(0, 100 * UNIT);
    }

    // ---------------------------------------------------------------- the pool's withdrawal

    /// @notice A withdrawal that is not the last one takes a proportional slice.
    /// @dev The only withdrawal test in this file had a single liquidity provider, so
    ///      `shares == totalPoolShares` was always true and the proportional branch — the one every
    ///      non-final withdrawal takes — had never executed. The final withdrawal is deliberately a
    ///      different rule: it takes the remainder rather than a slice, so integer rounding cannot
    ///      strand a claim and make `close()` unreachable. Both rules are now exercised, in order.
    function test_withdrawPool_partialWithdrawalTakesAProportionalSlice() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        _seed(bob, 500 * UNIT, 100 * UNIT);
        // Alice holds 1,200 of 1,800 shares; Bob holds 600.
        uint256 aliceShares = session.poolShares(alice);

        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.4e18, false);

        uint256 poolLong = session.longClaim().balanceOf(address(session));
        uint256 poolShort = session.shortClaim().balanceOf(address(session));
        uint256 aliceBefore = collateral.balanceOf(alice);

        vm.prank(alice);
        session.withdrawPool();

        // The slice is proportional: 1,200/1,800 of each reserve.
        uint256 longOut = (poolLong * aliceShares) / (aliceShares + session.poolShares(bob));
        uint256 shortOut = (poolShort * aliceShares) / (aliceShares + session.poolShares(bob));
        uint256 expected =
            WadMath.mulWad(longOut, 0.4e18) + WadMath.mulWad(shortOut, Constants.WAD - 0.4e18);

        assertEq(session.poolShares(alice), 0, "her shares are gone");
        assertEq(collateral.balanceOf(alice) - aliceBefore, expected, "paid the proportional slice");
        assertEq(session.totalPoolShares(), 600 * UNIT, "and Bob's remain");
    }

    /// @dev The two withdrawals together are worth exactly what the pool held, which is the
    ///      property the remainder rule exists to preserve.
    function test_withdrawPool_theTwoWithdrawalsConserveThePool() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        _seed(bob, 500 * UNIT, 100 * UNIT);

        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.4e18, false);

        uint256 aliceBefore = collateral.balanceOf(alice);
        uint256 bobBefore = collateral.balanceOf(bob);

        vm.prank(alice);
        session.withdrawPool();
        vm.prank(bob);
        session.withdrawPool();

        uint256 total =
            (collateral.balanceOf(alice) - aliceBefore) + (collateral.balanceOf(bob) - bobBefore);
        uint256 poolValue = WadMath.mulWad(1_500 * UNIT, 0.4e18)
            + WadMath.mulWad(300 * UNIT, Constants.WAD - 0.4e18);

        assertEq(total, poolValue, "the pool's whole value was distributed");
        assertEq(session.totalPoolShares(), 0, "and no shares remain");
        assertEq(session.longClaim().balanceOf(address(session)), 0, "no claim stranded");
    }

    function test_withdrawPool_refusesASecondWithdrawal() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.4e18, false);

        vm.prank(alice);
        session.withdrawPool();

        vm.prank(alice);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.withdrawPool();
    }

    // ---------------------------------------------------------------- lifecycle

    function test_expire_revertsBeforeTheExpiry() public {
        uint256 expiry = session.expiryTimestamp();
        vm.expectRevert(
            abi.encodeWithSelector(Session.ExpiryNotReached.selector, expiry, block.timestamp)
        );
        session.expire();
    }

    function test_expire_isPermissionlessAfterTheExpiry() public {
        vm.warp(block.timestamp + 18 hours);
        vm.prank(address(0xDEAD));
        session.expire();
        assertEq(uint8(session.state()), uint8(Session.State.Expired));
    }

    function test_settle_isReferenceRegistryOnly() public {
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Session.NotReferenceRegistry.selector, alice));
        session.settle(0.5e18, false);
    }

    function test_settle_refusesAPayoffAboveTheCollateralUnit() public {
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        vm.expectRevert(
            abi.encodeWithSelector(Session.PayoffAboveCollateral.selector, 1e18 + 1, 1e18)
        );
        session.settle(1e18 + 1, false);
    }

    function test_settle_thenClaimPaysThePayoff() public {
        _seed(alice, SEED_LONG, SEED_SHORT);
        _mintPairAs(bob, 1_000 * UNIT);

        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.25e18, false);
        assertEq(uint8(session.state()), uint8(Session.State.Settled));

        // A pair is worth exactly one unit whatever the payoff, which is the sum-to-one invariant.
        uint256 before = collateral.balanceOf(bob);
        vm.prank(bob);
        session.claim();
        assertEq(collateral.balanceOf(bob) - before, 1_000 * UNIT, "a pair pays one unit");
    }

    function test_claim_isClosedBeforeSettlement() public {
        _mintPairAs(bob, 100 * UNIT);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.WrongState.selector, Session.State.Open, Session.State.Settled
            )
        );
        session.claim();
    }

    function test_close_requiresEveryClaimRedeemed() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.25e18, false);

        vm.expectRevert(
            abi.encodeWithSelector(Session.ClaimsOutstanding.selector, 1_200 * UNIT, 1_200 * UNIT)
        );
        session.close();
    }

    function test_close_drainsCollateralToExactlyZero() public {
        // The full lifecycle: seed, settle, redeem every claim, then close. The paper's check C8:
        // settlement drains the collateral to exactly zero, and every balance ends at zero.
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.4e18, false);

        vm.prank(alice);
        session.withdrawPool();
        vm.prank(alice);
        session.claim();

        assertEq(session.longClaim().totalSupply(), 0, "every long redeemed");
        assertEq(session.shortClaim().totalSupply(), 0, "every short redeemed");
        assertEq(collateral.balanceOf(address(session)), session.collectedFees(), "only fees left");

        vm.prank(FACTORY);
        session.collectFees(FACTORY);
        assertEq(collateral.balanceOf(address(session)), 0, "collateral drained to exactly zero");
        session.close();
        assertEq(uint8(session.state()), uint8(Session.State.Claimed));
    }

    function test_noTransitionMovesBackwards() public {
        // Every entry point that requires `Open` must refuse once the session has settled.
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.4e18, false);

        _approve(alice, 100 * UNIT);
        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.WrongState.selector, Session.State.Settled, Session.State.Open
            )
        );
        session.mintPair(100 * UNIT);
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.WrongState.selector, Session.State.Settled, Session.State.Open
            )
        );
        session.buyLong(100 * UNIT, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.WrongState.selector, Session.State.Settled, Session.State.Open
            )
        );
        session.expire();
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- refusals

    /// @dev One block for every guarded path that had no negative test, because they are the same
    ///      finding repeated: a refusal that has never been observed to fire is indistinguishable
    ///      from one that does nothing, and the coverage report is what said which ones had never
    ///      fired. Grouping them here rather than scattering them keeps the narrative sections above
    ///      about behaviour and this one about the edges.

    function test_constructor_refusesAZeroReferenceToken() public {
        vm.expectRevert(Session.ZeroAddress.selector);
        new Session(
            collateral,
            address(0),
            LAM,
            block.timestamp + 17.5 hours,
            NOTIONAL_CAP,
            REFERENCE_REGISTRY
        );
    }

    function test_constructor_refusesAZeroReferenceRegistry() public {
        vm.expectRevert(Session.ZeroAddress.selector);
        new Session(
            collateral, REFERENCE_TOKEN, LAM, block.timestamp + 17.5 hours, NOTIONAL_CAP, address(0)
        );
    }

    /// @dev The factory path exists so the factory can seed a pool without holding the collateral
    ///      itself. The permission is explicit rather than implied by `msg.sender`, and this is the
    ///      test that says so.
    function test_mintPairFromFactory_isFactoryOnly() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Session.NotFactory.selector, bob));
        session.mintPairFromFactory(bob, 100 * UNIT);
    }

    function test_mintPairFromFactory_letsTheFactoryMintToAnotherAccount() public {
        // The factory pays: `_mintPair` pulls the collateral from `msg.sender`, so the factory must
        // both hold it and have approved. That is the point of the path — the factory seeds a pool
        // without the recipient having to hold anything first.
        _fund(FACTORY, 1_000 * UNIT);
        _approve(FACTORY, 1_000 * UNIT);

        vm.prank(FACTORY);
        session.mintPairFromFactory(bob, 100 * UNIT);

        assertEq(session.longClaim().balanceOf(bob), 100 * UNIT, "long minted to Bob");
        assertEq(session.shortClaim().balanceOf(bob), 100 * UNIT, "short minted to Bob");
        assertEq(collateral.balanceOf(FACTORY), 900 * UNIT, "and the factory paid for it");
    }

    function test_collectFees_isFactoryOnly() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Session.NotFactory.selector, bob));
        session.collectFees(bob);
    }

    function test_redeemPair_refusesZero() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.prank(alice);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.redeemPair(0);
    }

    function test_buyLong_refusesZero() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        _approve(bob, 0);
        vm.prank(bob);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.buyLong(0, 0);
    }

    function test_buyShort_refusesZero() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.prank(bob);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.buyShort(0, 0);
    }

    /// @dev `_reserveForMint` carries its own cap check, separate from `mintPair`'s. Only the latter
    ///      had a test, so the cap was enforced on one of the two paths that can breach it.
    function test_buyLong_enforcesTheNotionalCap() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        uint256 wouldBe = session.totalPairSupply() + NOTIONAL_CAP;

        _approve(bob, NOTIONAL_CAP);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(Session.NotionalCapExceeded.selector, wouldBe, NOTIONAL_CAP)
        );
        session.buyLong(NOTIONAL_CAP, 0);
    }

    function test_buyShort_enforcesTheNotionalCap() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        uint256 wouldBe = session.totalPairSupply() + NOTIONAL_CAP;

        _approve(bob, NOTIONAL_CAP);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(Session.NotionalCapExceeded.selector, wouldBe, NOTIONAL_CAP)
        );
        session.buyShort(NOTIONAL_CAP, 0);
    }

    function test_swapShortForLong_refusesZero() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.prank(bob);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.swapShortForLong(0, 0);
    }

    /// @dev The slippage floor on the swap path. `buyLong` had one tested and the swaps did not,
    ///      which left the two swap entry points as the only trades a caller could not protect.
    function test_swapShortForLong_enforcesTheSlippageFloor() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        _mintPairAs(bob, 1_000 * UNIT);
        _approveClaims(bob, 1_000 * UNIT);

        uint256 shortIn = 100 * UNIT;
        uint256 longOut =
            Amm.longOutForShortIn(session.longReserve(), session.shortReserve(), shortIn);
        uint256 impossible = longOut + 1;

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(SessionPool.SlippageExceeded.selector, longOut, impossible)
        );
        session.swapShortForLong(shortIn, impossible);
    }

    function test_swapLongForShort_refusesZero() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.prank(bob);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.swapLongForShort(0, 0);
    }

    function test_swapLongForShort_enforcesTheSlippageFloor() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        _mintPairAs(bob, 1_000 * UNIT);
        _approveClaims(bob, 1_000 * UNIT);

        uint256 longIn = 100 * UNIT;
        uint256 shortOut =
            Amm.shortOutForLongIn(session.longReserve(), session.shortReserve(), longIn);
        uint256 impossible = shortOut + 1;

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(SessionPool.SlippageExceeded.selector, shortOut, impossible)
        );
        session.swapLongForShort(longIn, impossible);
    }

    /// @dev The checked return value on the collateral pull. A token that returns `false` instead of
    ///      reverting is permitted by the ERC-20 spec, and crediting the deposit anyway would mint a
    ///      pair against collateral that never arrived. This is the only input that reaches the
    ///      branch, which is why it needs its own session rather than a prank on the existing one.
    function test_mintPair_refusesWhenTheCollateralTransferFails() public {
        MockNonRevertingERC20 hostile = new MockNonRevertingERC20("Hostile", "HOST", 6);
        Session hostileSession = new Session(
            hostile,
            REFERENCE_TOKEN,
            LAM,
            block.timestamp + 17.5 hours,
            NOTIONAL_CAP,
            REFERENCE_REGISTRY
        );

        vm.expectRevert(SessionPool.ClaimTransferFailed.selector);
        hostileSession.mintPair(1 * UNIT);
    }

    function test_expire_refusesASecondCall() public {
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.WrongState.selector, Session.State.Expired, Session.State.Open
            )
        );
        session.expire();
    }

    /// @dev Settlement is gated on `Expired`, so a registry that skipped the clock cannot fix a
    ///      payoff on a session that is still trading.
    function test_settle_refusesWhileStillOpen() public {
        vm.prank(REFERENCE_REGISTRY);
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.WrongState.selector, Session.State.Open, Session.State.Expired
            )
        );
        session.settle(0.4e18, false);
    }

    function test_claim_refusesWhenNothingIsHeld() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.4e18, false);

        vm.prank(bob);
        vm.expectRevert(SessionPool.ZeroAmount.selector);
        session.claim();
    }

    function test_close_refusesBeforeSettlement() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                Session.WrongState.selector, Session.State.Open, Session.State.Settled
            )
        );
        session.close();
    }

    /// @dev The residual check in `close`. A session that closes with collateral stranded is a
    ///      session whose sum-to-one arithmetic did not hold, so the check is what catches an
    ///      accounting error rather than a user error. Reached by donating collateral the session
    ///      never earned, which is exactly the shape of the bug it guards against.
    function test_close_refusesWhenCollateralIsStranded() public {
        _seed(alice, 1_000 * UNIT, 200 * UNIT);
        vm.warp(block.timestamp + 18 hours);
        session.expire();
        vm.prank(REFERENCE_REGISTRY);
        session.settle(0.4e18, false);
        vm.prank(alice);
        session.withdrawPool();
        vm.prank(alice);
        session.claim();

        collateral.mint(address(session), 7);
        uint256 fees = session.collectedFees();

        vm.expectRevert(
            abi.encodeWithSelector(Session.InsufficientCollateral.selector, fees + 7, fees)
        );
        session.close();
    }

    // ---------------------------------------------------------------- helpers

    function _fund(address who, uint256 amount) internal {
        collateral.mint(who, amount);
    }

    function _approve(address who, uint256 amount) internal {
        vm.prank(who);
        collateral.approve(address(session), amount);
    }

    function _approveClaims(address who, uint256 amount) internal {
        vm.startPrank(who);
        session.longClaim().approve(address(session), amount);
        session.shortClaim().approve(address(session), amount);
        vm.stopPrank();
    }

    function _mintPairAs(address who, uint256 amount) internal {
        _approve(who, amount);
        vm.prank(who);
        session.mintPair(amount);
    }

    /// @dev Seeds the pool from `who`, which must already hold both legs.
    function _seed(address who, uint256 longIn, uint256 shortIn) internal {
        _mintPairAs(who, longIn + shortIn);
        _approveClaims(who, longIn + shortIn);
        vm.prank(who);
        session.seedPool(longIn, shortIn);
    }
}
