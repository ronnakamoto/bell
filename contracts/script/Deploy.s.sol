// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Constants} from "../src/generated/Constants.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {Payoff} from "../src/libraries/Payoff.sol";
import {Session} from "../src/core/Session.sol";
import {SessionFactory} from "../src/core/SessionFactory.sol";
import {ReferenceRegistry} from "../src/core/ReferenceRegistry.sol";
import {PremiumRegistry} from "../src/pricing/PremiumRegistry.sol";
import {DevCollateral} from "./DevCollateral.sol";

/// @title Deploy
/// @notice Deploys the full system and prints a deployment manifest.
/// @dev Run against a fork with `forge script script/Deploy.s.sol --rpc-url $BELL_RPC_URL`. See
///      DESIGN_NOTES.md F6: no RPC endpoint is configured in this repository, so the fork path is
///      untested here and the script has to run against a development chain in the meantime.
///
///      Environment:
///        BELL_COLLATERAL       the reference collateral. Required on a fork; a dev collateral is
///                              deployed when unset, and the manifest says so.
///        BELL_ARBITER          the dispute arbiter. Defaults to the broadcaster.
///        BELL_SESSION_AUTHORITY the session counter and fallback authority. Defaults to the
///                              broadcaster.
///        BELL_REFERENCE_TOKEN  optional; when set, a session is listed for it.
contract Deploy is Script {
    /// @dev A print older than this is stale rather than live. Ten minutes is comfortably longer than
    ///      the interval between the open and the first consolidated print, and short enough that a
    ///      feed frozen for an hour is visibly stale rather than quietly usable.
    uint256 internal constant FRESHNESS_BOUND_SECONDS = 600;

    /// @dev A print older than this does not qualify at all, so the session defers or voids.
    ///      Two hours: past it, the open is old enough that a fresh print is more likely to arrive
    ///      than the old one is to be right.
    uint256 internal constant STALE_BOUND_SECONDS = 7_200;

    /// @dev The canonical overnight leverage for NVDA, used when a session is listed without one.
    uint256 internal constant DEFAULT_SESSION_LEVERAGE = 15;

    /// @dev The default notional cap for a listed session, in collateral units.
    uint256 internal constant DEFAULT_NOTIONAL_CAP = 5_000_000 * 10 ** 6;

    /// @dev The deployed addresses, so a caller can consume them programmatically rather than by
    ///      parsing the log.
    struct Manifest {
        address collateral;
        address referenceRegistry;
        address premiumRegistry;
        address sessionFactory;
        address arbiter;
        address sessionAuthority;
        address session;
        bool usesDevCollateral;
    }

    function run() external returns (Manifest memory manifest) {
        manifest = _deploy();
        _printManifest(manifest);
        _printLatticeDiagnostics(SessionFactory(manifest.sessionFactory));
        _printGuardSummary();
    }

    // ---------------------------------------------------------------- deployment

    function _deploy() internal returns (Manifest memory manifest) {
        manifest.usesDevCollateral = vm.envOr("BELL_COLLATERAL", address(0)) == address(0);
        manifest.arbiter = vm.envOr("BELL_ARBITER", msg.sender);
        manifest.sessionAuthority = vm.envOr("BELL_SESSION_AUTHORITY", msg.sender);

        vm.startBroadcast();

        if (manifest.usesDevCollateral) {
            manifest.collateral = address(new DevCollateral("USD Global (dev)", "USDG"));
        } else {
            manifest.collateral = vm.envAddress("BELL_COLLATERAL");
        }

        manifest.referenceRegistry = address(
            new ReferenceRegistry(
                manifest.arbiter,
                Constants.HALT_BAND_DEFAULT_WAD,
                Constants.TIER1_HALT_BAND_WAD,
                FRESHNESS_BOUND_SECONDS,
                STALE_BOUND_SECONDS
            )
        );

        manifest.premiumRegistry = address(
            new PremiumRegistry(
                IERC20(manifest.collateral),
                manifest.arbiter,
                manifest.sessionAuthority,
                // Six-decimal USDG, per ruling R2. The brief's `500,000e18` is the incoherence
                // DESIGN_NOTES.md F4 records; the derivation that produced $500,000 is preserved and
                // only the unit changes.
                Constants.MIN_PUBLISHER_BOND,
                Constants.CHALLENGER_BOND,
                Constants.STALENESS_SESSIONS,
                Constants.BOND_LOCK_SESSIONS
            )
        );

        manifest.sessionFactory =
            address(new SessionFactory(IERC20(manifest.collateral), manifest.referenceRegistry));

        address referenceToken = vm.envOr("BELL_REFERENCE_TOKEN", address(0));
        if (referenceToken != address(0)) {
            manifest.session = SessionFactory(manifest.sessionFactory)
                .createSession(
                    referenceToken,
                    DEFAULT_SESSION_LEVERAGE * Constants.WAD,
                    block.timestamp + 17.5 hours,
                    DEFAULT_NOTIONAL_CAP,
                    0
                );
        }

        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- the manifest

    function _printManifest(Manifest memory manifest) internal pure {
        console2.log("");
        console2.log("======================================================================");
        console2.log("BELL deployment manifest");
        console2.log("======================================================================");
        console2.log("addresses");
        console2.log("  collateral          ", manifest.collateral);
        console2.log("  reference registry  ", manifest.referenceRegistry);
        console2.log("  premium registry    ", manifest.premiumRegistry);
        console2.log("  session factory     ", manifest.sessionFactory);
        if (manifest.session != address(0)) {
            console2.log("  session             ", manifest.session);
        }
        console2.log("  arbiter             ", manifest.arbiter);
        console2.log("  session authority   ", manifest.sessionAuthority);

        console2.log("");
        console2.log("parameters");
        console2.log("  collateral decimals ", Constants.COLLATERAL_DECIMALS);
        console2.log("  alpha (saturation)  ", Constants.ALPHA_WAD);
        console2.log("  tier-1 halt band    ", Constants.TIER1_HALT_BAND_WAD);
        console2.log("  plausibility band   ", Constants.HALT_BAND_DEFAULT_WAD);
        console2.log("  freshness bound (s) ", FRESHNESS_BOUND_SECONDS);
        console2.log("  stale bound (s)     ", STALE_BOUND_SECONDS);
        console2.log("  publisher bond      ", Constants.MIN_PUBLISHER_BOND);
        console2.log("  challenger bond     ", Constants.CHALLENGER_BOND);
        console2.log("  staleness sessions  ", Constants.STALENESS_SESSIONS);
        console2.log("  bond lock sessions  ", Constants.BOND_LOCK_SESSIONS);
        console2.log("  rounding lattice    ", Constants.ROUNDING_LATTICE_WAD);

        if (manifest.usesDevCollateral) {
            console2.log("");
            console2.log("  WARNING: BELL_COLLATERAL was unset, so a development collateral was");
            console2.log("  deployed. This deployment is not a deployment of the protocol; it is a");
            console2.log("  harness. Set BELL_COLLATERAL to the real reference token.");
        }
    }

    // ---------------------------------------------------------------- the diagnostics

    /// @dev The lattice diagnostics the brief's §4.1.6 requires the deployment script to print.
    ///      They are printed rather than merely available because the lattice is the one parameter
    ///      the design originally left implicit, and an unstated rounding grid is an unstated
    ///      instrument: the same measured quantile publishes three different leverages on a 1%, a
    ///      0.5% and a 0.25% grid.
    function _printLatticeDiagnostics(SessionFactory factory) internal pure {
        (uint256 total, uint256 exact) = factory.latticeCoverage();
        (uint256 worst, uint256 worstLam) = factory.worstLatticeRoundingWad();
        uint256[] memory ladder = factory.listedLadder();

        console2.log("");
        console2.log("lattice diagnostics");
        console2.log("  rounding grid       ", Constants.ROUNDING_LATTICE_WAD);
        console2.log("  grid points         ", total);
        console2.log("  listable points     ", exact);
        console2.log("  worst rounding (wad)", worst);
        console2.log("  at leverage         ", worstLam / Constants.WAD);
        console2.log("  traded strikes      ", ladder.length);
        console2.log("  widest cap (wad)    ", ladder[0]);
        console2.log("  narrowest cap (wad) ", ladder[ladder.length - 1]);
        console2.log("");
        console2.log("  The traded strikes are the harmonic ladder, not the grid: most grid");
        console2.log("  points are not markets. The rounding grid is stated because the");
        console2.log("  published leverage depends on it.");
    }

    /// @dev A one-line reminder of where each guard lives, so an operator reading the manifest knows
    ///      which component to look at when one fires. Guard G9 is not listed separately because it
    ///      is asserted in the session's constructor, and a deployment that got this far passed it.
    function _printGuardSummary() internal pure {
        console2.log("");
        console2.log("guards");
        console2.log("  G3   tier-1 halt band    reference registry, at ingestion");
        console2.log("  G8   multiplier drift    reference registry, at resolution");
        console2.log("  G9   collateral decimals session constructor");
        console2.log("  G10  issuer pause        reference registry, opt-in per token");
        console2.log("  G10b sequencer uptime    reference registry, at both");
        console2.log("       plausibility         reference registry, at ingestion");
        console2.log("======================================================================");
    }

    /// @dev Exposed so that a test can assert the diagnostic arithmetic without parsing logs.
    function saturationGapFor(uint256 leverage) external pure returns (uint256) {
        return Payoff.saturationGapWad(leverage * Constants.WAD);
    }
}
