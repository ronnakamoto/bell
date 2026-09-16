// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {Payoff} from "../../src/libraries/Payoff.sol";
import {ReferenceRegistry} from "../../src/core/ReferenceRegistry.sol";
import {Session} from "../../src/core/Session.sol";
import {SessionFactory} from "../../src/core/SessionFactory.sol";
import {SessionPool} from "../../src/core/SessionPool.sol";
import {MockERC20, MockNonRevertingERC20} from "../mocks/MockERC20.sol";
import {MockReferenceToken} from "../mocks/MockProbes.sol";

/// @notice The listing gates and the deterministic deployment.
/// @dev Both gates are tested in both directions. A guard that has never been observed to fire is
///      indistinguishable from a guard that does nothing, and one that fires when it should not is
///      worse -- it refuses a legitimate listing.
contract SessionFactoryTest is Test {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant NOTIONAL_CAP = 5_000_000 * UNIT;
    uint256 internal constant TIER1_BAND = 0.05e18;
    uint256 internal constant PLAUSIBILITY_BAND = 0.25e18;
    uint256 internal constant FRESHNESS = 600;
    uint256 internal constant STALENESS = 7_200;

    address internal constant AUTHORITY = address(0xA17);

    MockERC20 internal collateral;
    MockReferenceToken internal referenceToken;
    ReferenceRegistry internal registry;
    SessionFactory internal factory;

    function setUp() public {
        collateral = new MockERC20("USD Global", "USDG", 6);
        referenceToken = new MockReferenceToken(1e18);
        registry =
            new ReferenceRegistry(AUTHORITY, PLAUSIBILITY_BAND, TIER1_BAND, FRESHNESS, STALENESS);
        factory = new SessionFactory(collateral, address(registry));
        vm.warp(1_800_000_000);
    }

    // ---------------------------------------------------------------- the lattice gate

    function test_exactlyRepresentable_acceptsWholeLeveragesOnly() public view {
        assertTrue(factory.exactlyRepresentable(1e18));
        assertTrue(factory.exactlyRepresentable(15e18));
        assertTrue(factory.exactlyRepresentable(1000e18));
        assertFalse(factory.exactlyRepresentable(0), "zero is not a leverage");
        assertFalse(factory.exactlyRepresentable(0.5e18), "half is not a leverage");
        assertFalse(factory.exactlyRepresentable(15.5e18), "off-lattice");
    }

    function test_checkListingLam_acceptsEveryPublishedLeverage() public view {
        // The canonical set of the paper's Table 13, plus the widest event leverage. A gate that
        // refused any of these would refuse a market the design publishes.
        uint256[9] memory published = [uint256(15), 11, 22, 11, 10, 16, 22, 11, 32];
        for (uint256 i = 0; i < published.length; ++i) {
            uint256 cap = factory.checkListingLam(published[i] * Constants.WAD);
            assertEq(cap, Payoff.saturationGapWad(published[i] * Constants.WAD), "cap");
        }
        assertGt(factory.checkListingLam(21 * Constants.WAD), 0, "widest event leverage");
    }

    function test_checkListingLam_refusesAnOffLatticeLeverage() public {
        // 15.5 produces a cap of 6.45% that looks entirely reasonable, which is exactly why the
        // wholeness check runs before the cap check.
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionFactory.NotOnHarmonicLattice.selector,
                (Constants.WAD * Constants.WAD) / 15.5e18
            )
        );
        factory.checkListingLam(15.5e18);
    }

    function test_checkListingLam_refusesZero() public {
        vm.expectRevert(abi.encodeWithSelector(SessionFactory.NotOnHarmonicLattice.selector, 0));
        factory.checkListingLam(0);
    }

    function test_checkListingLam_refusesACapAtOrAboveOne() public {
        // A cap of one means the claim pays linearly across the whole reachable range, so the
        // truncation never binds and the cap bounds nothing. Refused at the only place it can be.
        vm.expectRevert(
            abi.encodeWithSelector(SessionFactory.ListingGateCapNotBelowOne.selector, Constants.WAD)
        );
        factory.checkListingLam(1e18);
    }

    // ---------------------------------------------------------------- the cap gate

    function test_checkListingCap_invertsTheLattice() public view {
        for (uint256 units = 2; units <= 100; ++units) {
            uint256 cap = Payoff.saturationGapWad(units * Constants.WAD);
            assertEq(factory.checkListingCap(cap), units * Constants.WAD, "round trip");
        }
    }

    function test_checkListingCap_refusesAnOffLatticeCap() public {
        // 6.5% and 6.75% are lattice points of the rounding grid but not of the harmonic ladder:
        // neither is exactly 1/n for a whole n. The cap gate is what stops them being listed.
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionFactory.NotOnHarmonicLattice.selector, 65 * Constants.WAD / 1000
            )
        );
        factory.checkListingCap(65 * Constants.WAD / 1000);
    }

    function test_checkListingCap_refusesACapAtOrAboveOne() public {
        vm.expectRevert(
            abi.encodeWithSelector(SessionFactory.ListingGateCapNotBelowOne.selector, Constants.WAD)
        );
        factory.checkListingCap(Constants.WAD);
        vm.expectRevert(
            abi.encodeWithSelector(SessionFactory.ListingGateCapNotBelowOne.selector, 0)
        );
        factory.checkListingCap(0);
    }

    // ---------------------------------------------------------------- diagnostics

    function test_latticeCoverage_mostOfTheGridIsNotListable() public view {
        (uint256 total, uint256 exact) = factory.latticeCoverage();
        // 0.25% spacing over (0, 1) is 399 points. A point k * 0.25% is exactly 1/n only when
        // k divides 400, and 400 has fifteen divisors, one of which (400) is the excluded cap of
        // one. So exactly fourteen grid points are listable markets -- which is the measurement
        // behind the paper's conclusion that the traded strikes must be the ladder, not the grid.
        assertEq(total, 399, "grid points strictly inside the unit interval");
        assertEq(exact, 14, "divisors of 400 below 400");
    }

    function test_worstLatticeRounding_isNonTrivial() public view {
        (uint256 worst, uint256 worstLam) = factory.worstLatticeRoundingWad();
        assertGt(worst, 0, "snapping to the grid moves the leverage somewhere");
        assertGt(worstLam, 0, "and there is a leverage where it is worst");
        // The worst case cannot exceed one whole lattice step's worth of relative error at the
        // smallest listed leverage, which is a generous ceiling but a real one.
        assertLt(worst, Constants.WAD, "the error is a fraction of a leverage");
    }

    function test_listedLadder_startsAtTwoAndIsConstantLength() public view {
        uint256[] memory caps = factory.listedLadder();
        assertEq(caps.length, factory.DIAGNOSTIC_MAX_LEVERAGE() - 1, "constant length");
        assertEq(caps[0], 0.5e18, "a leverage of two has a cap of one half");
        assertEq(caps[caps.length - 1], Payoff.saturationGapWad(100e18), "ends at the bound");
        for (uint256 i = 1; i < caps.length; ++i) {
            assertLt(caps[i], caps[i - 1], "the ladder is strictly descending in cap");
        }
    }

    // ---------------------------------------------------------------- deployment

    function test_createSession_deploysAndRecordsTheListing() public {
        uint256 expiry = block.timestamp + 17.5 hours;
        address session =
            factory.createSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP, 0);

        assertGt(session.code.length, 0, "code was deployed");
        Session deployed = Session(session);
        assertEq(deployed.lamWad(), 15e18);
        assertEq(deployed.referenceToken(), address(referenceToken));
        assertEq(deployed.expiryTimestamp(), expiry);
        assertEq(deployed.notionalCapWad(), NOTIONAL_CAP);
        assertEq(deployed.factory(), address(factory));
        assertTrue(factory.sessionDeployed(factory.saltFor(address(referenceToken), 15e18, expiry)));

        // Registration is part of createSession (F93): a listed session is settleable without a
        // second transaction, and the multiplier G8 will judge against was read from the token.
        ReferenceRegistry.SessionRecord memory record = registry.sessionRecord(session);
        assertEq(record.referenceToken, address(referenceToken));
        assertEq(record.multiplierAtRegistration, 1e18, "read from the token, not supplied");
        assertEq(record.lamWad, 15e18);
        assertEq(record.expiryTimestamp, expiry);
    }

    function test_createSession_addressIsPredictableInAdvance() public {
        uint256 expiry = block.timestamp + 17.5 hours;
        address predicted =
            factory.predictSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP);
        address actual =
            factory.createSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP, 0);
        assertEq(actual, predicted, "the CREATE2 address is knowable before deployment");
    }

    function test_createSession_addressIsSensitiveToEachKey() public {
        uint256 expiry = block.timestamp + 17.5 hours;
        bytes32 base = factory.saltFor(address(referenceToken), 15e18, expiry);
        assertTrue(base != factory.saltFor(address(0xCAFE), 15e18, expiry), "reference token");
        assertTrue(base != factory.saltFor(address(referenceToken), 16e18, expiry), "leverage");
        assertTrue(base != factory.saltFor(address(referenceToken), 15e18, expiry + 1), "expiry");
    }

    function test_createSession_refusesADuplicate() public {
        uint256 expiry = block.timestamp + 17.5 hours;
        factory.createSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionFactory.DuplicateSession.selector,
                factory.saltFor(address(referenceToken), 15e18, expiry)
            )
        );
        factory.createSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP, 0);
    }

    function test_createSession_appliesTheGates() public {
        uint256 expiry = block.timestamp + 17.5 hours;
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionFactory.NotOnHarmonicLattice.selector,
                (Constants.WAD * Constants.WAD) / 15.5e18
            )
        );
        factory.createSession(address(referenceToken), 15.5e18, expiry, NOTIONAL_CAP, 0);

        vm.expectRevert(
            abi.encodeWithSelector(SessionFactory.ListingGateCapNotBelowOne.selector, Constants.WAD)
        );
        factory.createSession(address(referenceToken), 1e18, expiry, NOTIONAL_CAP, 0);
    }

    function test_createSession_refusesAnExpiryInThePast() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionFactory.ExpiryNotReached.selector, block.timestamp, block.timestamp
            )
        );
        factory.createSession(address(referenceToken), 15e18, block.timestamp, NOTIONAL_CAP, 0);
    }

    function test_createSession_refusesAZeroReferenceToken() public {
        vm.expectRevert(SessionFactory.ZeroAddress.selector);
        factory.createSession(address(0), 15e18, block.timestamp + 1 hours, NOTIONAL_CAP, 0);
    }

    function test_constructor_refusesAZeroRegistry() public {
        vm.expectRevert(SessionFactory.ZeroAddress.selector);
        new SessionFactory(collateral, address(0));
    }

    // ---------------------------------------------------------------- the seed path

    function test_createSession_seedsThePoolFromTheCallersCollateral() public {
        uint256 seed = 1_000_000 * UNIT;
        collateral.mint(address(this), seed);
        collateral.approve(address(factory), seed);

        uint256 expiry = block.timestamp + 17.5 hours;
        address session =
            factory.createSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP, seed);

        Session deployed = Session(session);
        assertEq(deployed.totalPairSupply(), seed, "the seed minted a pair per unit");
        assertEq(deployed.longReserve(), seed / 2, "split evenly");
        assertEq(deployed.shortReserve(), seed - seed / 2, "the odd unit goes to the short leg");
        assertEq(deployed.poolPriceLongWad(), 0.5e18, "an even split opens at one half");
        assertEq(collateral.balanceOf(session), seed, "the session holds the collateral");
        assertEq(collateral.balanceOf(address(this)), 0, "the caller paid for it");
    }

    function test_createSession_withAZeroSeedLeavesThePoolUnseeded() public {
        uint256 expiry = block.timestamp + 17.5 hours;
        Session deployed =
            Session(factory.createSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP, 0));
        assertEq(deployed.longReserve(), 0, "unseeded");
        assertEq(deployed.totalPairSupply(), 0, "and nothing minted");
        vm.expectRevert(SessionPool.PoolDepthZero.selector);
        deployed.poolPriceLongWad();
    }

    /// @notice A seed of one pair is refused, because it cannot be split.
    /// @dev Found by a coverage measurement: `_seedBalanced`'s `longIn == 0` guard had never
    ///      executed, and asking why led to the only input that reaches it. A probe confirmed the
    ///      consequence before any fix was written — `seed = 1` minted a pair, left the pool unseeded,
    ///      and stranded the pair in the factory, which has no function that could redeem it. The
    ///      session was therefore uncloseable once it settled, which is precisely the failure the
    ///      comment above `_seedBalanced` says the odd-unit rule exists to prevent.
    ///
    ///      The odd-unit rule handles an odd seed *above* one. This is the case below it, and the
    ///      listing gate is where it belongs: refusing before the session exists is cheaper than
    ///      refusing after, and the caller learns before spending gas on a deployment.
    function test_createSession_refusesASeedThatCannotBeSplit() public {
        collateral.mint(address(this), 1);
        collateral.approve(address(factory), 1);

        uint256 expiry = block.timestamp + 17.5 hours;
        vm.expectRevert(abi.encodeWithSelector(SessionFactory.SeedTooSmall.selector, uint256(1)));
        factory.createSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP, 1);
    }

    /// @dev The smallest seed that *can* be split is two, and it must still work: one unit to each
    ///      leg, an even split, and a pool that opens at one half. The refusal above must not have
    ///      been implemented as an off-by-one that also rejects this.
    function test_createSession_acceptsTheSmallestSplittableSeed() public {
        collateral.mint(address(this), 2);
        collateral.approve(address(factory), 2);

        uint256 expiry = block.timestamp + 17.5 hours;
        Session deployed =
            Session(factory.createSession(address(referenceToken), 15e18, expiry, NOTIONAL_CAP, 2));

        assertEq(deployed.totalPairSupply(), 2, "two pairs minted");
        assertEq(deployed.longReserve(), 1, "one unit to the long leg");
        assertEq(deployed.shortReserve(), 1, "one to the short leg");
        assertEq(deployed.poolPriceLongWad(), 0.5e18, "an even split opens at one half");
    }

    /// @dev The checked return value on the seed transfer. The factory is the one paying, so a token
    ///      that returns `false` instead of reverting would leave it believing it had funded a pool
    ///      it had not funded. `MockNonRevertingERC20` is the token that reaches this branch.
    function test_createSession_refusesACollateralThatWillNotMove() public {
        MockNonRevertingERC20 hostile = new MockNonRevertingERC20("Hostile", "HST", 6);
        SessionFactory hostileFactory = new SessionFactory(hostile, address(registry));

        uint256 expiry = block.timestamp + 17.5 hours;
        vm.expectRevert(SessionFactory.SeedTransferFailed.selector);
        hostileFactory.createSession(
            address(referenceToken), 15e18, expiry, NOTIONAL_CAP, 1_000 * UNIT
        );
    }
}
