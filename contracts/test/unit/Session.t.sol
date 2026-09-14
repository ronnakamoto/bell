// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {Amm} from "../../src/libraries/Amm.sol";
import {ClaimToken} from "../../src/core/ClaimToken.sol";
import {Session} from "../../src/core/Session.sol";
import {SessionPool} from "../../src/core/SessionPool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

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

        _approve(bob, collateralIn);
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
