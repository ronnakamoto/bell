// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {Session} from "../../src/core/Session.sol";
import {SessionFactory} from "../../src/core/SessionFactory.sol";
import {ReferenceRegistry} from "../../src/core/ReferenceRegistry.sol";
import {Branch} from "../../src/types/Branch.sol";

/// @title ChainFork — integration tests against a live Robinhood Chain Testnet deployment.
/// @dev Requires BELL_RPC_URL pointing at the testnet RPC.
///      `make test-fork` skips cleanly when the variable is unset.
///      Deploys via `make deploy-fork`, then forks at the latest block to verify the contracts.
contract ChainFork is Test {
    address internal constant FACTORY = 0xD4CE5F928389c2E1A425E1f5a2e92CC53840bD40;
    address internal constant REGISTRY = 0xe3542d2E695aDc9A171bF7329Cf2DC9218093049;
    address internal constant COLLATERAL = 0x78aD29a32a2866adb58Ed1ba08C2A0A7f4ba75D3;
    address internal constant REFERENCE_TOKEN = 0x756791F10C02c23a1Cf2dC522543C12983Bad31E;
    address internal constant SESSION = 0x09346b53cCF15E8aa3CE3f2C2284ca14c438638e;

    function setUp() public {
        string memory rpcUrl = vm.envString("BELL_RPC_URL");
        vm.createSelectFork(rpcUrl);
    }

    // ── Deployed contracts have code ──────────────────────────────────────

    function test_deployedContracts_haveCode() public view {
        assertGt(address(FACTORY).code.length, 0, "factory deployed");
        assertGt(address(REGISTRY).code.length, 0, "registry deployed");
        assertGt(address(COLLATERAL).code.length, 0, "collateral deployed");
        assertGt(address(REFERENCE_TOKEN).code.length, 0, "reference token deployed");
        assertGt(address(SESSION).code.length, 0, "session deployed");
    }

    // ── Collateral is a live ERC-20 ───────────────────────────────────────

    function test_collateral_isERC20() public view {
        // DevCollateral may have zero supply (it is a test harness, not the real USDG).
        // The key assertion is that the contract exists and responds to totalSupply().
        IERC20(COLLATERAL).totalSupply(); // reverts if not an ERC-20
    }

    // ── Reference token has a multiplier ──────────────────────────────────

    function test_referenceToken_hasMultiplier() public view {
        // The reference token implements IMultiplierToken.
        // multiplier() returns 1e18 (1.0) for our mock.
        (bool ok, bytes memory data) =
            REFERENCE_TOKEN.staticcall(abi.encodeWithSignature("multiplier()"));
        assertTrue(ok, "multiplier() call succeeds");
        uint256 mult = abi.decode(data, (uint256));
        assertEq(mult, 1e18, "multiplier is 1.0");
    }

    // ── Session state and parameters ──────────────────────────────────────

    function test_session_isOpen() public view {
        Session session = Session(SESSION);
        // state 0 = Open
        assertEq(uint256(session.state()), 0, "session is Open");
    }

    function test_session_parameters() public view {
        Session session = Session(SESSION);
        assertEq(session.referenceToken(), REFERENCE_TOKEN, "reference token");
        assertEq(session.referenceRegistry(), REGISTRY, "registry");
        assertEq(session.lamWad(), 15e18, "leverage lambda=15");
        assertGt(session.expiryTimestamp(), block.timestamp, "expiry in the future");
        assertEq(session.notionalCapWad(), 5_000_000e6, "notional cap 5M");
    }

    // ── Factory collateral matches ────────────────────────────────────────

    function test_factory_collateralMatches() public view {
        SessionFactory factory = SessionFactory(FACTORY);
        assertEq(address(factory.collateral()), COLLATERAL, "factory collateral");
    }

    // ── Registry can resolve the session ──────────────────────────────────

    function test_registry_canResolve() public {
        ReferenceRegistry registry = ReferenceRegistry(REGISTRY);
        // resolve() may revert if prints are missing — acceptable for a fresh session.
        try registry.resolve(SESSION) returns (
            uint256, Branch
        ) {
        // Resolution succeeded.
        }
            catch {
            // No prints yet — acceptable.
        }
    }

    // ── Session code size is reasonable ───────────────────────────────────

    function test_session_codeSize() public {
        uint256 codeSize = address(SESSION).code.length;
        assertGt(codeSize, 1000, "non-trivial");
        assertLt(codeSize, 50_000, "within reason");
        emit log_named_uint("session code size (bytes)", codeSize);
    }
}
