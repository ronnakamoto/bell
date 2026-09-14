// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {ClaimToken} from "../../src/core/ClaimToken.sol";

/// @notice The claim leg: the session gate, the ERC-20 refusals, and the allowance arithmetic.
/// @dev This file did not exist until a coverage measurement showed `ClaimToken` at **11.11%
///      branches (1/9)** with 100% lines. Every one of the eight uncovered branches was a *refusal*
///      path, and the most important of them is `NotSession`: the gate that stops anyone but the
///      owning session from minting a leg. The session's own tests exercised mint and burn on the
///      happy path only, so the access control was unverified — the contract's central security
///      property was assumed rather than tested.
contract ClaimTokenTest is Test {
    address internal constant SESSION = address(0x5E55);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant STRANGER = address(0xBAD);

    uint8 internal constant DECIMALS = 6;

    ClaimToken internal token;

    function setUp() public {
        token = new ClaimToken("BELL GAP-L", "bGAPL", DECIMALS, SESSION);
    }

    // ---------------------------------------------------------------- construction

    function test_constructor_recordsTheMetadata() public view {
        assertEq(token.name(), "BELL GAP-L", "name");
        assertEq(token.symbol(), "bGAPL", "symbol");
        assertEq(token.decimals(), DECIMALS, "decimals follow the collateral");
        assertEq(token.session(), SESSION, "the owning session");
        assertEq(token.totalSupply(), 0, "and starts empty");
    }

    /// @dev A zero session would make the token permanently unmintable: `mint` is gated on
    ///      `msg.sender == session` and no address can send from zero. Refusing it at construction
    ///      turns a token that can never mint into a deployment failure.
    function test_constructor_refusesAZeroSession() public {
        vm.expectRevert(ClaimToken.ZeroAddress.selector);
        new ClaimToken("BELL GAP-L", "bGAPL", DECIMALS, address(0));
    }

    // ---------------------------------------------------------------- mint

    /// @dev The gate the whole pair accounting rests on. A leg minted outside the session would
    ///      break `PI_L + PI_S == 1` for the session's own ledger with no visible symptom.
    function test_mint_isSessionOnly() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ClaimToken.NotSession.selector, STRANGER));
        token.mint(ALICE, 1_000_000);
        assertEq(token.totalSupply(), 0, "and nothing was minted");
    }

    function test_mint_refusesTheZeroAddress() public {
        vm.prank(SESSION);
        vm.expectRevert(ClaimToken.ZeroAddress.selector);
        token.mint(address(0), 1_000_000);
    }

    function test_mint_updatesSupplyAndBalanceAndEmitsFromZero() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(address(0), ALICE, 1_000_000);

        vm.prank(SESSION);
        token.mint(ALICE, 1_000_000);

        assertEq(token.totalSupply(), 1_000_000, "supply");
        assertEq(token.balanceOf(ALICE), 1_000_000, "balance");
    }

    /// @dev Minting to the session itself is how the pool comes to hold its claims, so it must be
    ///      permitted. A zero-address-only guard would have made the pool's leg unreachable.
    function test_mint_allowsTheSessionToHoldItsOwnClaims() public {
        vm.prank(SESSION);
        token.mint(SESSION, 2_000_000);
        assertEq(token.balanceOf(SESSION), 2_000_000, "the pool holds claims");
    }

    // ---------------------------------------------------------------- burn

    function test_burn_isSessionOnly() public {
        _mint(ALICE, 1_000_000);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ClaimToken.NotSession.selector, STRANGER));
        token.burn(ALICE, 1);
        assertEq(token.balanceOf(ALICE), 1_000_000, "and nothing was burned");
    }

    function test_burn_refusesMoreThanTheBalance() public {
        _mint(ALICE, 1_000_000);
        vm.prank(SESSION);
        vm.expectRevert(
            abi.encodeWithSelector(ClaimToken.InsufficientBalance.selector, 1_000_000, 1_000_001)
        );
        token.burn(ALICE, 1_000_001);
    }

    function test_burn_updatesSupplyAndBalanceAndEmitsToZero() public {
        _mint(ALICE, 1_000_000);

        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(ALICE, address(0), 400_000);

        vm.prank(SESSION);
        token.burn(ALICE, 400_000);

        assertEq(token.totalSupply(), 600_000, "supply fell");
        assertEq(token.balanceOf(ALICE), 600_000, "balance fell");
    }

    /// @dev Burning exactly the balance is allowed, so the last holder can be cleared and `close()`
    ///      can reach zero supply.
    function test_burn_allowsTheEntireBalance() public {
        _mint(ALICE, 1_000_000);
        vm.prank(SESSION);
        token.burn(ALICE, 1_000_000);
        assertEq(token.totalSupply(), 0, "supply is zero");
        assertEq(token.balanceOf(ALICE), 0, "and so is the balance");
    }

    // ---------------------------------------------------------------- transfer

    function test_transfer_movesTheBalance() public {
        _mint(ALICE, 1_000_000);
        vm.prank(ALICE);
        assertTrue(token.transfer(BOB, 250_000), "returns true");

        assertEq(token.balanceOf(ALICE), 750_000, "sender");
        assertEq(token.balanceOf(BOB), 250_000, "recipient");
        assertEq(token.totalSupply(), 1_000_000, "supply is unchanged by a transfer");
    }

    /// @dev A transfer to zero would destroy the claim without reducing supply, so the supply would
    ///      stop matching the pair ledger.
    function test_transfer_refusesTheZeroAddress() public {
        _mint(ALICE, 1_000_000);
        vm.prank(ALICE);
        vm.expectRevert(ClaimToken.ZeroAddress.selector);
        token.transfer(address(0), 1);
    }

    function test_transfer_refusesMoreThanTheBalance() public {
        _mint(ALICE, 1_000_000);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(ClaimToken.InsufficientBalance.selector, 1_000_000, 1_000_001)
        );
        token.transfer(BOB, 1_000_001);
    }

    function test_transfer_toSelfIsANoOp() public {
        _mint(ALICE, 1_000_000);
        vm.prank(ALICE);
        token.transfer(ALICE, 1_000_000);
        assertEq(token.balanceOf(ALICE), 1_000_000, "balance unchanged");
    }

    // ---------------------------------------------------------------- approve and transferFrom

    function test_approve_setsTheAllowanceAndEmits() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Approval(ALICE, BOB, 500_000);

        vm.prank(ALICE);
        assertTrue(token.approve(BOB, 500_000), "returns true");
        assertEq(token.allowance(ALICE, BOB), 500_000, "allowance recorded");
    }

    function test_transferFrom_spendsTheAllowance() public {
        _mint(ALICE, 1_000_000);
        vm.prank(ALICE);
        token.approve(BOB, 500_000);

        vm.prank(BOB);
        assertTrue(token.transferFrom(ALICE, BOB, 300_000), "returns true");

        assertEq(token.balanceOf(BOB), 300_000, "recipient paid");
        assertEq(token.balanceOf(ALICE), 700_000, "owner debited");
        assertEq(token.allowance(ALICE, BOB), 200_000, "allowance decremented");
    }

    function test_transferFrom_refusesBeyondTheAllowance() public {
        _mint(ALICE, 1_000_000);
        vm.prank(ALICE);
        token.approve(BOB, 500_000);

        vm.prank(BOB);
        vm.expectRevert(
            abi.encodeWithSelector(ClaimToken.InsufficientAllowance.selector, 500_000, 500_001)
        );
        token.transferFrom(ALICE, BOB, 500_001);
    }

    /// @dev The infinite allowance is a deliberate escape hatch: it is *not* decremented, which is
    ///      the branch that makes `available != type(uint256).max` load-bearing. A version that
    ///      decremented it would silently spend a "permanent" approval after one transfer.
    function test_transferFrom_doesNotSpendAnInfiniteAllowance() public {
        _mint(ALICE, 1_000_000);
        vm.prank(ALICE);
        token.approve(BOB, type(uint256).max);

        vm.prank(BOB);
        token.transferFrom(ALICE, BOB, 400_000);

        assertEq(
            token.allowance(ALICE, BOB), type(uint256).max, "an infinite approval is not spent"
        );

        // And a second transfer still works, which is the property a session relies on when it
        // pulls a trader's leg more than once.
        vm.prank(BOB);
        token.transferFrom(ALICE, BOB, 400_000);
        assertEq(token.balanceOf(BOB), 800_000, "and remains usable");
    }

    function test_transferFrom_refusesWithNoAllowanceAtAll() public {
        _mint(ALICE, 1_000_000);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(ClaimToken.InsufficientAllowance.selector, 0, 1));
        token.transferFrom(ALICE, BOB, 1);
    }

    /// @dev The allowance is checked before the balance, so a spender who is short on *both* is told
    ///      about the allowance. That is the refusal they can act on: the owner can raise it.
    function test_transferFrom_checksTheAllowanceBeforeTheBalance() public {
        _mint(ALICE, 100);
        vm.prank(ALICE);
        token.approve(BOB, 50);

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(ClaimToken.InsufficientAllowance.selector, 50, 200));
        token.transferFrom(ALICE, BOB, 200);
    }

    // ---------------------------------------------------------------- helpers

    function _mint(address to, uint256 amount) private {
        vm.prank(SESSION);
        token.mint(to, amount);
    }
}
