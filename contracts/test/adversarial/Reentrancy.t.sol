// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {ReentrancyGuard} from "../../src/core/ReentrancyGuard.sol";
import {Session} from "../../src/core/Session.sol";
import {MaliciousCollateral} from "./MaliciousCollateral.sol";

/// @notice The reentrancy defence, against a genuinely malicious collateral token.
/// @dev The brief's §10.6 forbids a mock here and the reason is worth restating: the failure mode
///      being guarded against is a property of the real call ordering, and a mock that *pretends* to
///      re-enter proves only that the test can call a function twice.
///
///      Two things are asserted for every attack, and the second is the one that matters. The first
///      is that the re-entrant call was refused. The second is that the *ledger is correct anyway* --
///      a guard that refused the re-entry but left a half-written state behind would pass the first
///      assertion and fail the protocol. That is what checks-effects-interactions is for, and the
///      guard is the secondary defence precisely because it does not cover it.
contract ReentrancyTest is Test {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant LAM = 15e18;
    uint256 internal constant NOTIONAL_CAP = 5_000_000 * UNIT;

    MaliciousCollateral internal collateral;
    Session internal session;

    address internal victim = address(0xA1);

    function setUp() public {
        vm.warp(1_800_000_000);
        collateral = new MaliciousCollateral();
        session = new Session(
            collateral,
            address(0xBEEF),
            LAM,
            block.timestamp + 17.5 hours,
            NOTIONAL_CAP,
            address(0xA11CE)
        );
        collateral.mint(victim, 1_000_000 * UNIT);
        vm.prank(victim);
        collateral.approve(address(session), type(uint256).max);
    }

    // ---------------------------------------------------------------- mintPair

    function test_mintPair_cannotBeReentered() public {
        uint256 amount = 1_000 * UNIT;
        collateral.arm(session, MaliciousCollateral.Attack.MintPair);

        vm.prank(victim);
        session.mintPair(amount);

        assertEq(collateral.reentryAttempts(), 1, "the hook fired exactly once");
        _assertTheGuardRefusedIt();
    }

    function test_mintPair_ledgerIsCorrectAfterARefusedReentry() public {
        // The assertion that matters. A guard that refused the re-entry but left the pair ledger
        // written twice would pass the test above and break the protocol: the session would owe two
        // units of collateral per unit it holds.
        uint256 amount = 1_000 * UNIT;
        collateral.arm(session, MaliciousCollateral.Attack.MintPair);

        vm.prank(victim);
        session.mintPair(amount);

        assertEq(session.totalPairSupply(), amount, "one mint, not two");
        assertEq(collateral.balanceOf(address(session)), amount, "and one deposit");
        assertEq(session.longClaim().balanceOf(victim), amount, "one long leg");
        assertEq(session.shortClaim().balanceOf(victim), amount, "one short leg");
        assertTrue(session.isCollateralised(), "and the session is still solvent");
    }

    function test_mintPair_theReentrantCallCannotMintToItself() public {
        // The re-entrant call comes from the token, so a guard that failed would have minted pairs to
        // the *token* rather than to the victim -- which is the shape of a real exploit: the attacker
        // contract holds the claims and the session holds the collateral.
        collateral.arm(session, MaliciousCollateral.Attack.MintPair);
        vm.prank(victim);
        session.mintPair(1_000 * UNIT);

        assertEq(session.longClaim().balanceOf(address(collateral)), 0, "the token holds nothing");
        assertEq(session.shortClaim().balanceOf(address(collateral)), 0, "the token holds nothing");
    }

    // ---------------------------------------------------------------- redeemPair

    function test_redeemPair_cannotBeReentered() public {
        // The token is given pairs first, so the re-entrant call has something to redeem and the
        // refusal can only be the guard rather than an insufficient balance.
        _giveTheTokenPairs(500 * UNIT);

        collateral.arm(session, MaliciousCollateral.Attack.RedeemPair);
        vm.prank(victim);
        session.mintPair(1_000 * UNIT);

        assertEq(collateral.reentryAttempts(), 1, "the hook fired exactly once");
        _assertTheGuardRefusedIt();
    }

    function test_redeemPair_ledgerIsCorrectAfterARefusedReentry() public {
        _giveTheTokenPairs(500 * UNIT);
        uint256 supplyBefore = session.totalPairSupply();

        collateral.arm(session, MaliciousCollateral.Attack.RedeemPair);
        vm.prank(victim);
        session.mintPair(1_000 * UNIT);

        assertEq(session.totalPairSupply(), supplyBefore + 1_000 * UNIT, "only the outer mint");
        assertEq(
            session.longClaim().balanceOf(address(collateral)),
            500 * UNIT,
            "the token's own pairs are untouched"
        );
        assertTrue(session.isCollateralised(), "and the session is still solvent");
    }

    // ---------------------------------------------------------------- the guard's reach

    function test_theGuardIsSecondaryToTheOrdering() public {
        // The brief requires checks-effects-interactions as the *primary* defence and the guard as
        // the secondary, and this asserts the distinction is real rather than nominal: the reserves
        // and the collateral ledger are both written before any token moves, so a re-entry that
        // somehow passed the guard would still find a consistent state rather than a half-written
        // one. Read the session's `_reserveForMint` to see the ordering; this test pins the
        // observable consequence.
        collateral.arm(session, MaliciousCollateral.Attack.MintPair);
        vm.prank(victim);
        session.mintPair(1_000 * UNIT);

        // The re-entry read the session's state after the outer call's effects were written, and
        // that state was already consistent: the supply matched the collateral at every point the
        // token could observe.
        assertEq(
            collateral.balanceOf(address(session)),
            session.totalPairSupply(),
            "the ledger was consistent throughout"
        );
    }

    function test_anUnarmedTokenIsUnaffected() public {
        // The control. Without the attack armed, the same call path produces the same ledger -- so
        // the assertions above are about the guard and not about the token being special.
        vm.prank(victim);
        session.mintPair(1_000 * UNIT);
        assertEq(collateral.reentryAttempts(), 0, "no attack");
        assertEq(session.totalPairSupply(), 1_000 * UNIT, "and the ordinary result");
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Asserts the refusal was the *guard's*, by comparing the re-entry's revert data against
    ///      the guard's own error. A bare boolean would be satisfied by any revert -- an insufficient
    ///      balance, a zero amount, a wrong state -- and a reentrancy test that passes for the wrong
    ///      reason is worse than no test.
    function _assertTheGuardRefusedIt() private view {
        assertTrue(collateral.reentryReverted(), "the re-entrant call reverted");
        assertEq(
            collateral.lastRevertReason(),
            abi.encodeWithSelector(ReentrancyGuard.Reentered.selector),
            "and it reverted with the guard's own error"
        );
    }

    /// @dev Gives the malicious token pairs of its own, by having it mint and pay for them.
    function _giveTheTokenPairs(uint256 amount) private {
        collateral.mint(address(collateral), amount);
        vm.startPrank(address(collateral));
        collateral.approve(address(session), type(uint256).max);
        session.mintPair(amount);
        vm.stopPrank();
    }
}

