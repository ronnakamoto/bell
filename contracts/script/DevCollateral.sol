// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../src/interfaces/IERC20.sol";

/// @title DevCollateral
/// @notice A six-decimal ERC-20 for running the deployment script without a fork.
/// @dev **Development only.** A real deployment takes the collateral's address from the environment,
///      because the collateral is the tokenised treasury product the protocol custodies and a
///      protocol that deployed its own would be custodying something it invented.
///
///      The decimal count is six and not a parameter, because guard G9 rejects any session whose
///      collateral is not six decimals -- so a dev collateral that could be configured to eighteen
///      would produce a deployment that cannot list a single session, and the failure would appear
///      at the first `createSession` rather than at the point of the mistake.
///
///      This lives in `script/` rather than being imported from `test/mocks/`, because a deployment
///      script that depends on test code is a script that can be broken by a change to a fixture.
contract DevCollateral is IERC20 {
    /// @dev The only decimal count the protocol accepts. See guard G9.
    uint8 internal constant DECIMALS = 6;

    string public name;
    string public symbol;
    uint8 public immutable decimals = DECIMALS;

    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    /// @notice Mint to an account. Permissionless, because this is a development fixture.
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
            if (available < value) return false;
            allowance[from][msg.sender] = available - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (balanceOf[from] < value) return;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
