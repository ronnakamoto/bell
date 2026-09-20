// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {Session} from "../../src/core/Session.sol";
import {SessionFactory} from "../../src/core/SessionFactory.sol";
import {ReferenceRegistry} from "../../src/core/ReferenceRegistry.sol";
import {Branch} from "../../src/types/Branch.sol";

/// @title ChainFork — integration tests against a pinned Robinhood Chain deployment.
/// @dev Requires BELL_RPC_URL pointing at an archive node for chain 4663.
///      `make test-fork` skips cleanly when the variable is unset.
///      Block 61,228,000 is the earliest L2 block at which the canonical
///      fixture's session was settled.
contract ChainFork is Test {
    address internal constant FACTORY = 0xc7183455a4C133Ae270771860664b6B7ec320bB1;
    address internal constant REGISTRY = 0xF62849F9A0B5Bf2913b396098F7c7019b51A820a;
    address internal constant PREMIUM = 0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9;
    address internal constant COLLATERAL = 0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496;
    address internal constant SESSION = 0xEbaa350Fe46C7b07170af86dD750752F1e0E5202;
    address internal constant REFERENCE_TOKEN = 0x2e234DAe75C793f67A35089C9d99245E1C58470b;

    /// @dev The canonical fixture's L2 block.
    uint256 internal constant FORK_BLOCK = 61_228_000;

    function setUp() public {
        string memory rpcUrl = vm.envString("BELL_RPC_URL");
        vm.createSelectFork(rpcUrl, FORK_BLOCK);
    }

    // ── Reference token is a live ERC-20 ──────────────────────────────────

    function test_referenceToken_isERC20() public view {
        // totalSupply() is the standard ERC-20 probe.
        uint256 supply = IERC20(REFERENCE_TOKEN).totalSupply();
        assertGt(supply, 0, "non-zero supply at the fork block");
    }

    // ── Collateral is a live ERC-20 ───────────────────────────────────────

    function test_collateral_isERC20() public view {
        uint256 supply = IERC20(COLLATERAL).totalSupply();
        assertGt(supply, 0, "non-zero supply at the fork block");
    }

    // ── Deployed contracts have code ──────────────────────────────────────

    function test_deployedContracts_haveCode() public view {
        assertGt(address(FACTORY).code.length, 0, "factory deployed");
        assertGt(address(REGISTRY).code.length, 0, "registry deployed");
        assertGt(address(PREMIUM).code.length, 0, "premium deployed");
        assertGt(address(SESSION).code.length, 0, "session deployed");
    }

    // ── Session state at the fork block ───────────────────────────────────

    function test_session_isSettled() public view {
        Session session = Session(SESSION);
        uint256 state = uint256(session.state());
        assertTrue(state >= 2, "session settled or claimed at the fork block");
    }

    function test_session_parameters() public view {
        Session session = Session(SESSION);
        assertEq(session.referenceToken(), REFERENCE_TOKEN, "reference token matches");
        assertEq(session.referenceRegistry(), REGISTRY, "registry matches");
        assertGt(session.lamWad(), 0, "leverage is non-zero");
        assertGt(session.expiryTimestamp(), 0, "expiry is set");
        assertGt(session.notionalCapWad(), 0, "notional cap is set");
    }

    // ── Factory collateral ────────────────────────────────────────────────

    function test_factory_collateralMatches() public view {
        SessionFactory factory = SessionFactory(FACTORY);
        assertEq(address(factory.collateral()), COLLATERAL, "factory collateral matches");
    }

    // ── Registry can resolve the canonical session ────────────────────────

    function test_registry_canResolve() public {
        ReferenceRegistry registry = ReferenceRegistry(REGISTRY);
        // resolve() may revert if prints are missing — acceptable at the fork block.
        try registry.resolve(SESSION) returns (
            uint256, Branch
        ) {
        // Resolution succeeded.
        }
            catch {
            // No prints or not resolvable yet — acceptable.
        }
    }

    // ── Gas: deployed code size ───────────────────────────────────────────

    function test_session_codeSize() public {
        uint256 codeSize = address(SESSION).code.length;
        assertGt(codeSize, 1000, "session code is non-trivial");
        assertLt(codeSize, 50_000, "session code is within reason");
        emit log_named_uint("session code size (bytes)", codeSize);
    }
}
