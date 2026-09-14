// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Constants} from "../src/generated/Constants.sol";
import {Amm} from "../src/libraries/Amm.sol";
import {FeeModel} from "../src/libraries/FeeModel.sol";
import {Payoff} from "../src/libraries/Payoff.sol";
import {Stat} from "../src/libraries/Stat.sol";
import {WadMath} from "../src/libraries/WadMath.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {SessionFactory} from "../src/core/SessionFactory.sol";

/// @title PrintDiagnostics
/// @notice Prints the numbers the protocol is calibrated on, read from the deployed code.
/// @dev Run with `forge script script/PrintDiagnostics.s.sol`. No broadcast and no state: every value
///      is computed by the same library the protocol calls, so this is a check that the arithmetic
///      still produces the published figures rather than a restatement of them.
///
///      It reads `spec/fixtures/canonical.json`, so a change to the constants file or to `Stat` shows
///      up here as a changed number rather than as a failing test three layers away.
contract PrintDiagnostics is Script {
    string internal constant CANONICAL_FIXTURE = "../spec/fixtures/canonical.json";

    /// @dev The fixture's cell count. A constant rather than a read of the JSON array's length,
    ///      which `vm.parseJson` gives no way to ask for.
    uint256 internal constant CANONICAL_CELL_COUNT = 9;

    function run() external {
        _printLattice();
        _printCanonical();
        _printAmmWorkedExample();
        _printFees();
    }

    // ---------------------------------------------------------------- lattice

    function _printLattice() internal {
        // A local instance, never broadcast. The diagnostics are `pure` and never read the token, so
        // the collateral argument is a placeholder rather than a configuration.
        SessionFactory factory = new SessionFactory(IERC20(address(0xDEAD)), address(0xA11CE));
        (uint256 total, uint256 exact) = factory.latticeCoverage();
        (uint256 worst, uint256 worstLam) = factory.worstLatticeRoundingWad();

        console2.log("");
        console2.log("=== leverage lattice ===");
        console2.log("rounding grid (wad)     ", Constants.ROUNDING_LATTICE_WAD);
        console2.log("grid points in (0,1)    ", total);
        console2.log("listable (exactly 1/n)  ", exact);
        console2.log("worst rounding error wad", worst);
        console2.log("  at leverage           ", worstLam / Constants.WAD);
        console2.log("");
        console2.log("the traded ladder, first ten entries (cap at WAD scale):");
        for (uint256 units = 2; units <= 11; ++units) {
            console2.log(units, Payoff.saturationGapWad(units * Constants.WAD));
        }
    }

    // ---------------------------------------------------------------- canonical parameters

    /// @dev Reproduces the paper's Table 13 leverage and Table 18 Gaussian premium for every cell
    ///      of the canonical fixture. The empirical premium the paper publishes is a measurement of a
    ///      sample this repository does not hold, so what is checked here is the Gaussian column --
    ///      a function of `(sigma, lambda)` alone and therefore fully reproducible.
    ///
    ///      Fields are read one path at a time rather than through an `abi.decode` of the whole
    ///      array. The decode reverts under `forge script` even though the identical call succeeds
    ///      under `forge test`, and the indexed form is what every other fixture consumer in this
    ///      repository uses. See DESIGN_NOTES.md F35.
    function _printCanonical() internal view {
        string memory json = vm.readFile(CANONICAL_FIXTURE);
        console2.log("");
        console2.log("=== canonical parameters (paper Table 13 / Table 18) ===");
        for (uint256 i = 0; i < CANONICAL_CELL_COUNT; ++i) {
            string memory base = string.concat(".cells[", vm.toString(i), "]");
            uint256 lambdaWad = vm.parseJsonUint(json, string.concat(base, ".lambdaWad"));
            uint256 sigmaWad = vm.parseJsonUint(json, string.concat(base, ".sigmaWad"));
            uint256 gaussian =
                WadMath.mulWad(lambdaWad, Stat.truncatedAbsMoment(lambdaWad, 0, sigmaWad));
            console2.log(
                string.concat(
                    vm.parseJsonString(json, string.concat(base, ".name")),
                    " ",
                    vm.parseJsonString(json, string.concat(base, ".session")),
                    " lambda"
                ),
                lambdaWad / Constants.WAD
            );
            console2.log("   cap", vm.parseJsonUint(json, string.concat(base, ".capWad")));
            console2.log("   gaussian pL", gaussian);
            console2.log("   empirical pL", vm.parseJsonUint(json, string.concat(base, ".pLWad")));
        }
        console2.log("");
        console2.log("The Gaussian column is the differential reference: Eq (12) applied to");
        console2.log("(sigma, lambda) alone. The empirical column is the measured seed model,");
        console2.log("and this repository does not hold the sample it was measured from.");
    }

    // ---------------------------------------------------------------- the AMM

    /// @dev The paper's worked example from its §4.4: with a = 1,000, b = 200 and Q = 20 the exact
    ///      cost is 3.3801, the average price 0.1690 and the marginal price 0.167.
    function _printAmmWorkedExample() internal pure {
        uint256 a = 1_000e18;
        uint256 b = 200e18;
        uint256 q = 20e18;
        uint256 cost = Amm.costLongWad(a, b, q);

        console2.log("");
        console2.log("=== AMM worked example (paper section 4.4) ===");
        console2.log("pool long     ", a);
        console2.log("pool short    ", b);
        console2.log("long out      ", q);
        console2.log("exact cost    ", cost);
        console2.log("   paper says 3.3801e18");
        console2.log("average price ", Amm.averagePriceWad(a, b, q));
        console2.log("   paper says 0.1690e18");
        console2.log("marginal price", Amm.priceLongWad(a, b));
        console2.log("   paper says 0.1667e18");
        console2.log("slippage      ", Amm.slippageWad(a, b, q));
        console2.log("k before      ", Amm.k(a, b));
        console2.log("k after       ", Amm.k(a - (q - cost), b + cost));
    }

    // ---------------------------------------------------------------- fees

    /// @dev Named rather than written inline. `17.5e18` is a rational literal, so
    ///      `console2.log("...", 17.5e18)` does not resolve to an overload -- and a named constant is
    ///      the right shape for a session term in any case.
    uint256 internal constant OVERNIGHT_HOURS_WAD = 17.5e18;
    uint256 internal constant WEEKEND_HOURS_WAD = 65.5e18;
    /// @dev The premium the paper uses to illustrate the fee cap not binding: at 0.228 the guardrail
    ///      permits 114 bp against a 9.0 bp charge.
    uint256 internal constant EXAMPLE_PREMIUM_WAD = 0.228e18;

    function _printFees() internal pure {
        console2.log("");
        console2.log("=== fees ===");
        console2.log("overnight term (wad hours)", OVERNIGHT_HOURS_WAD);
        console2.log(
            "  uncapped protocol fee   ", FeeModel.protocolFeeUncappedWad(OVERNIGHT_HOURS_WAD)
        );
        console2.log("  cap at pL = 0.228       ", FeeModel.protocolFeeCapWad(EXAMPLE_PREMIUM_WAD));
        console2.log(
            "  cap binds?              ",
            FeeModel.protocolFeeIsCapped(EXAMPLE_PREMIUM_WAD, OVERNIGHT_HOURS_WAD)
        );
        console2.log("weekend term (wad hours)  ", WEEKEND_HOURS_WAD);
        console2.log(
            "  uncapped protocol fee   ", FeeModel.protocolFeeUncappedWad(WEEKEND_HOURS_WAD)
        );
        console2.log("trading fee at the close  ", FeeModel.tradingFeeWad(0, OVERNIGHT_HOURS_WAD));
        console2.log(
            "trading fee at the open   ",
            FeeModel.tradingFeeWad(OVERNIGHT_HOURS_WAD, OVERNIGHT_HOURS_WAD)
        );
        console2.log("ramp average ceiling      ", Constants.RAMP_TIME_AVERAGE_CEILING_WAD);
        console2.log("blended target (bp, wad)  ", Constants.BLENDED_FEE_TARGET_BP_WAD);
    }
}
