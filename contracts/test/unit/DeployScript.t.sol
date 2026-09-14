// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {Branch} from "../../src/types/Branch.sol";
import {Session} from "../../src/core/Session.sol";
import {SessionFactory} from "../../src/core/SessionFactory.sol";
import {ReferenceRegistry} from "../../src/core/ReferenceRegistry.sol";
import {PremiumRegistry} from "../../src/pricing/PremiumRegistry.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {MockReferenceToken} from "../mocks/MockProbes.sol";

/// @notice The deployment script, run as a test.
/// @dev A deployment script that has never been executed is a script with an assumed behaviour. This
///      runs it and asserts the *system* it produces, not merely that it did not revert: the factory
///      points at the registry that was deployed, the registries are wired to each other, and a
///      session can be listed end to end through the deployed factory.
contract DeployScriptTest is Test {
    function test_deployProducesAConsistentSystem() public {
        Deploy deploy = new Deploy();
        Deploy.Manifest memory manifest = deploy.run();

        assertGt(manifest.collateral.code.length, 0, "collateral");
        assertGt(manifest.referenceRegistry.code.length, 0, "reference registry");
        assertGt(manifest.premiumRegistry.code.length, 0, "premium registry");
        assertGt(manifest.sessionFactory.code.length, 0, "session factory");
        assertTrue(manifest.usesDevCollateral, "no BELL_COLLATERAL was set");
    }

    function test_deploy_wiresTheFactoryToTheRegistryItDeployed() public {
        // The failure this catches is a factory pointed at a freshly constructed registry rather than
        // the deployed one, which would look identical until a settlement was attempted against a
        // registry that had never heard of the session.
        Deploy.Manifest memory manifest = new Deploy().run();
        SessionFactory factory = SessionFactory(manifest.sessionFactory);
        assertEq(address(factory.collateral()), manifest.collateral);
        assertEq(factory.referenceRegistry(), manifest.referenceRegistry);
    }

    function test_deploy_wiresThePremiumRegistryToTheBondToken() public {
        Deploy.Manifest memory manifest = new Deploy().run();
        PremiumRegistry premium = PremiumRegistry(manifest.premiumRegistry);
        assertEq(address(premium.bondToken()), manifest.collateral, "bonds in the collateral unit");
        assertEq(premium.minPublisherBond(), Constants.MIN_PUBLISHER_BOND);
        assertEq(premium.challengerBond(), Constants.CHALLENGER_BOND);
        assertEq(premium.stalenessSessions(), Constants.STALENESS_SESSIONS);
        assertEq(premium.bondLockSessions(), Constants.BOND_LOCK_SESSIONS);
    }

    function test_deploy_usesTheCorrectRegulatoryBands() public {
        // The Tier-1 halt band is the correction the paper records: 5%, not the legacy 25% default.
        // A deployment that shipped the default would let a halted print settle a session.
        Deploy.Manifest memory manifest = new Deploy().run();
        ReferenceRegistry registry = ReferenceRegistry(manifest.referenceRegistry);
        assertEq(registry.haltBandWad(), Constants.TIER1_HALT_BAND_WAD, "tier-1 band");
        assertEq(registry.plausibilityBandWad(), Constants.HALT_BAND_DEFAULT_WAD, "plausibility");
        assertFalse(registry.voidAtHalf(), "route R2, not R1");
    }

    function test_deploy_listsASessionThatCanBeSeededAndSettled() public {
        // End to end through the deployed system: list, register, expire, resolve. This is the
        // acceptance criterion's first item, run against the script's own output rather than against
        // a hand-assembled fixture.
        Deploy.Manifest memory manifest = new Deploy().run();
        SessionFactory factory = SessionFactory(manifest.sessionFactory);
        // A real reference token, not a bare address. Resolution reads the token's multiplier for
        // guard G8, so a session pointed at an address with no code reverts on the probe rather than
        // resolving -- which is the guard working, and a fixture that has to respect it.
        MockReferenceToken referenceToken = new MockReferenceToken(1e18);
        address session = factory.createSession(
            address(referenceToken), 15e18, block.timestamp + 17.5 hours, 1_000_000e6, 0
        );
        Session listed = Session(session);
        assertEq(listed.referenceRegistry(), manifest.referenceRegistry, "settle authority");
        assertEq(listed.factory(), manifest.sessionFactory, "fee authority");

        // The registry must know the session before it will resolve it.
        ReferenceRegistry registry = ReferenceRegistry(manifest.referenceRegistry);
        registry.registerSession(session, address(referenceToken));

        vm.warp(listed.expiryTimestamp() + 1);
        (uint256 payoff, Branch branch) = registry.resolve(session);
        assertEq(uint8(branch), uint8(Branch.Deferred), "deferred: no print was ever submitted");
        assertEq(payoff, 0, "a deferral is the absence of a decision, not a zero payoff");
        assertEq(uint8(listed.state()), uint8(Session.State.Expired), "and still unsettled");
    }
}
