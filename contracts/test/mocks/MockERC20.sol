// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @title MockERC20
/// @notice A minimal ERC-20 for tests, with configurable decimals.
/// @dev Exists so that guard G9 can be exercised in both directions: the real collateral is six
///      decimals, and a session constructed against an eighteen-decimal token must revert rather
///      than produce a session wrong by 1e12 with no signal. A mock is acceptable here because the
///      property under test is the *session's* response to a decimal count, not any behaviour of the
///      real token. Where the real token's behaviour is the thing being guarded against -- the pause
///      flag, the multiplier, the sequencer feed -- the brief forbids a mock and requires a fork.
contract MockERC20 is IERC20 {
    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);
    error ZeroAddress();

    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 available = allowance[from][msg.sender];
        if (available != type(uint256).max) {
            if (available < value) revert InsufficientAllowance(available, value);
            allowance[from][msg.sender] = available - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = balanceOf[from];
        if (available < value) revert InsufficientBalance(available, value);
        balanceOf[from] = available - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @title MockNonRevertingERC20
/// @notice An ERC-20 that reports failure by returning `false` instead of reverting.
/// @dev Exists so that the `BondTransferFailed` path is reachable and therefore testable. The
///      standard-compliant mock above reverts on a failure, which means a caller that checks the
///      return value never observes `false` from it -- and a defensive check that no input can
///      trigger is indistinguishable from no check at all. Non-reverting tokens are not hypothetical:
///      the ERC-20 specification permits a `false` return, which is exactly why every transfer in
///      this codebase is checked rather than assumed.
contract MockNonRevertingERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (balanceOf[msg.sender] < value) return false;
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// @dev Always reports failure, so that every caller's checked return value is exercised.
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @title MockFeeOnTransferERC20
/// @notice An ERC-20 that delivers less than it is asked to transfer.
/// @dev Exists so that the bond checks have a reachable path. `PremiumRegistry` measures what
///      actually arrives rather than assuming the nominal amount, because a bond smaller than the
///      advertised one is worth less as a deterrent, and the registry would otherwise credit the
///      nominal figure and believe it held a bond it does not. Both `BondTooSmall` and
///      `ChallengeBondMismatch` are reachable only through a token like this, and an error path with
///      no input that triggers it is indistinguishable from no check at all.
contract MockFeeOnTransferERC20 is IERC20 {
    /// @dev The fee, in basis points, retained by the token on every transfer.
    uint256 public immutable feeBasisPoints;

    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 feeBasisPoints_
    ) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        feeBasisPoints = feeBasisPoints_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        uint256 fee = (value * feeBasisPoints) / 10_000;
        balanceOf[from] -= value;
        balanceOf[to] += value - fee;
        totalSupply -= fee;
        emit Transfer(from, to, value - fee);
    }
}
