// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IERC20
/// @notice The subset of the ERC-20 surface this protocol uses.
/// @dev Deliberately not a full standard interface. `transfer` and `transferFrom` return `bool` and
///      every caller must check it, because a token that returns `false` instead of reverting is a
///      real failure mode and treating the call as successful would credit a deposit that never
///      arrived. The adapter layer is where those quirks are contained; this interface is the
///      contract the rest of the protocol codes against.
interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 value) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 value) external returns (bool);

    function transferFrom(address from, address to, uint256 value) external returns (bool);

    /// @dev Read at construction and asserted against the session's expectation. An 18-decimal
    ///      collateral against a 6-decimal expectation produces a session wrong by 1e12 with no
    ///      revert, no event and no signal, which is the largest silent assumption in the contract
    ///      (paper §9.5, guard G9).
    function decimals() external view returns (uint8);
}
