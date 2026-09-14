// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title ClaimToken
/// @notice One leg of a BELL claim pair: a transferable ERC-20 claim on a session's collateral.
/// @dev The paper's abstract specifies *"a pair of complementary ERC-20 claims -- GAP-L and GAP-S"*,
///      and this is that token. One instance per leg, both deployed by the session that owns them.
///      Mint and burn are restricted to the session, because the sum-to-one invariant is a property
///      of the *pair*: a leg minted outside the session would break `PI_L + PI_S == 1` for the
///      session's own accounting without any visible symptom.
///
///      Decimals follow the collateral rather than being fixed at 18. A claim is a claim on
///      collateral units, so the two must share a scale; fixing the claims at 18 against a
///      6-decimal collateral would introduce a 1e12 factor between a pool reserve and a payout.
///
///      Deliberately absent: `permit`, `increaseAllowance`, `_beforeTokenTransfer` hooks, and any
///      transfer restriction. The claims are meant to be transferable and composable -- that is the
///      product -- and every added mechanism is another thing the settlement path has to reason
///      about.
contract ClaimToken is IERC20 {
    /// @dev Thrown when a caller other than the owning session tries to mint or burn.
    error NotSession(address caller);
    /// @dev Thrown on a transfer or approval from an account with insufficient balance.
    error InsufficientBalance(uint256 available, uint256 required);
    /// @dev Thrown on a transferFrom exceeding the allowance.
    error InsufficientAllowance(uint256 available, uint256 required);
    /// @dev Thrown on a transfer to the zero address, which would burn without reducing supply.
    error ZeroAddress();

    /// @notice The token name. See `IERC20`.
    string public name;
    /// @notice The token symbol. See `IERC20`.
    string public symbol;
    /// @notice The session that may mint and burn this leg.
    address public immutable session;
    /// @notice The token's decimals, inherited from the collateral. See `IERC20`.
    /// @dev `@inheritdoc` is not usable here: these are public state variables satisfying an
    ///      interface, not function overrides, and the tag fails to resolve against them.
    uint8 public immutable decimals;

    /// @notice Total supply. See `IERC20`.
    uint256 public totalSupply;
    /// @notice Balances. See `IERC20`.
    mapping(address account => uint256) public balanceOf;
    /// @notice Allowances. See `IERC20`.
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    /// @dev Slot layout, declared mutable before immutable per the brief's §7.2 ordering rule:
    ///        slot 0: name (string, short form)
    ///        slot 1: symbol (string, short form)
    ///        slot 2: totalSupply
    ///        slots 3..: balanceOf
    ///        slots after: allowance
    ///      `session` and `decimals` are immutable and therefore not in storage at all.
    constructor(string memory name_, string memory symbol_, uint8 decimals_, address session_) {
        if (session_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        session = session_;
    }

    /// @inheritdoc IERC20
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    /// @inheritdoc IERC20
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// @inheritdoc IERC20
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 available = allowance[from][msg.sender];
        if (available != type(uint256).max) {
            if (available < value) revert InsufficientAllowance(available, value);
            allowance[from][msg.sender] = available - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Mint to an account. Session only.
    /// @dev Called exactly when the session mints a pair, so supply and collateral stay in step.
    function mint(address to, uint256 value) external {
        if (msg.sender != session) revert NotSession(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    /// @notice Burn from an account. Session only.
    /// @dev Called exactly when the session redeems or settles, so supply and collateral stay in
    ///      step in the other direction too.
    function burn(address from, uint256 value) external {
        if (msg.sender != session) revert NotSession(msg.sender);
        uint256 available = balanceOf[from];
        if (available < value) revert InsufficientBalance(available, value);
        balanceOf[from] = available - value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
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
