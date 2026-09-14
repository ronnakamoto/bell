// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../../src/interfaces/IERC20.sol";
import {Session} from "../../src/core/Session.sol";

/// @title MaliciousCollateral
/// @notice A collateral token that re-enters the session on every pull.
/// @dev The brief's §10.6 is explicit that reentrancy must be tested against a *genuinely malicious
///      contract* rather than a mock that pretends to be one, because the failure mode being guarded
///      against is a property of the real call ordering. This token is that contract: it performs a
///      real re-entrant call from inside `transferFrom`, at the exact point where the session has
///      already committed its effects and is about to interact.
///
///      It attacks through `transferFrom` rather than through a callback because that is the only
///      re-entry point the session offers -- there is no ETH transfer and no token receiver hook --
///      and it attacks on the *pull* rather than the *push* because the pull happens after the
///      session's ledger has been updated, which is precisely the window
///      checks-effects-interactions exists to close.
///
///      The token is otherwise standards-compliant, including the six decimals guard G9 requires, so
///      that the test measures the reentrancy defence rather than the decimals guard.
contract MaliciousCollateral is IERC20 {
    /// @notice Which session function the re-entrant call targets.
    enum Attack {
        None,
        MintPair,
        RedeemPair,
        BuyLong
    }

    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    /// @notice The session to re-enter. Set once, after the session exists.
    Session public target;
    /// @notice Which call to re-enter with. `None` disables the attack.
    Attack public attack;
    /// @notice How many times the hook has fired, whether or not the re-entry succeeded.
    uint256 public reentryAttempts;
    /// @notice Whether the re-entrant call reverted, so the test can assert the guard fired rather
    ///         than the outer call failing for some unrelated reason.
    bool public reentryReverted;
    /// @notice The revert data from the refused re-entry, kept whole.
    /// @dev Kept rather than reduced to a selector because a bare boolean would be satisfied by *any*
    ///      revert -- an insufficient balance, a zero amount, a wrong state -- and a reentrancy test
    ///      that passes for the wrong reason is worse than no test. The assertion compares this
    ///      against the guard's own error.
    bytes public lastRevertReason;

    constructor() {
        name = "Malicious USD";
        symbol = "mUSD";
        decimals = 6;
    }

    function arm(Session target_, Attack attack_) external {
        target = target_;
        attack = attack_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    /// @dev The attack. The re-entrant call is made *before* the transfer completes, so the session
    ///      sees a call while its own effects are already written -- which is the ordering the guard
    ///      and the checks-effects discipline both defend.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (attack != Attack.None) {
            reentryAttempts += 1;
            Attack current = attack;
            // Disarmed before the call, so a guard that failed would produce one re-entry and not an
            // infinite one. A test that hangs is not a test that reports.
            attack = Attack.None;
            Session session = target;
            if (current == Attack.MintPair) {
                try session.mintPair(1) {
                    reentryReverted = false;
                } catch (bytes memory reason) {
                    reentryReverted = true;
                    lastRevertReason = reason;
                }
            } else if (current == Attack.RedeemPair) {
                try session.redeemPair(1) {
                    reentryReverted = false;
                } catch (bytes memory reason) {
                    reentryReverted = true;
                    lastRevertReason = reason;
                }
            } else {
                try session.buyLong(1, 0) {
                    reentryReverted = false;
                } catch (bytes memory reason) {
                    reentryReverted = true;
                    lastRevertReason = reason;
                }
            }
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        uint256 available = balanceOf[from];
        require(available >= value, "insufficient");
        balanceOf[from] = available - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
