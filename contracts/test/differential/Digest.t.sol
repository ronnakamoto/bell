// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PremiumRegistry} from "../../src/pricing/PremiumRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice The cross-language commitment digest, verified against the shared fixture.
/// @dev Paper Appendix B defines the contract as
///      `keccak256(abi.encode(nameId, forSession, lambdaWad, premiumWad, inputsHash))`, and
///      `calibrator/tests/contract/test_digest_contract.py` reads the same fixture and recomputes
///      the same values from the Python side's byte layout. If the two ever disagree, every honest
///      challenge fails, which is why this is a differential test rather than a round-trip one.
///
///      `inputsHash` is taken from the fixture as an opaque 32-byte value. Its *contents* are the
///      publisher's canonical serialisation of the raw fit inputs, which the chain never inspects --
///      the registry compares digests, and a challenge re-runs the fit off-chain. The serialisation
///      itself is therefore tested on the Python side, where it is produced.
contract DigestTest is Test {
    string internal constant FIXTURE = "../spec/digest.json";

    function test_commitmentDigestMatchesTheSharedFixture() public view {
        string memory json = vm.readFile(FIXTURE);
        uint256 caseCount = vm.parseJsonUint(json, ".caseCount");
        assertGt(caseCount, 0, "the fixture carries at least one case");

        for (uint256 i = 0; i < caseCount; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            bytes32 nameId = vm.parseJsonBytes32(json, string.concat(base, ".nameId"));
            uint256 forSession = vm.parseJsonUint(json, string.concat(base, ".forSession"));
            uint256 lambdaWad = vm.parseJsonUint(json, string.concat(base, ".lambdaWad"));
            uint256 premiumWad = vm.parseJsonUint(json, string.concat(base, ".premiumWad"));
            bytes32 inputsHash = vm.parseJsonBytes32(json, string.concat(base, ".inputsHash"));
            bytes32 expected = vm.parseJsonBytes32(json, string.concat(base, ".digest"));

            bytes32 computed = keccak256(
                abi.encode(nameId, uint64(forSession), lambdaWad, premiumWad, inputsHash)
            );
            assertEq(
                computed,
                expected,
                string.concat("commitment digest mismatch at case ", vm.toString(i))
            );
        }
    }

    /// @dev The same fixture, through the contract that actually stores the digest. The test above
    ///      builds the preimage inline, which checks the encoding; this one checks that
    ///      `PremiumRegistry.digestOf` is that encoding and not something adjacent to it. Two
    ///      assertions over one fixture because a contract can be wrong in a way an inline
    ///      `abi.encode` is not, and the failure mode -- every honest challenge failing -- looks
    ///      exactly like a dishonest publisher.
    function test_premiumRegistryDigestMatchesTheSharedFixture() public {
        MockERC20 bondToken = new MockERC20("USD Global", "USDG", 6);
        PremiumRegistry registry = new PremiumRegistry(
            bondToken, address(0xA1B), address(0x5E5), 500_000e6, 50_000e6, 12, 13
        );

        string memory json = vm.readFile(FIXTURE);
        uint256 caseCount = vm.parseJsonUint(json, ".caseCount");
        assertGt(caseCount, 0, "the fixture carries at least one case");

        for (uint256 i = 0; i < caseCount; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            bytes32 nameId = vm.parseJsonBytes32(json, string.concat(base, ".nameId"));
            uint64 forSession = uint64(vm.parseJsonUint(json, string.concat(base, ".forSession")));
            uint256 lambdaWad = vm.parseJsonUint(json, string.concat(base, ".lambdaWad"));
            uint256 premiumWad = vm.parseJsonUint(json, string.concat(base, ".premiumWad"));
            bytes32 inputsHash = vm.parseJsonBytes32(json, string.concat(base, ".inputsHash"));
            bytes32 expected = vm.parseJsonBytes32(json, string.concat(base, ".digest"));

            assertEq(
                registry.digestOf(nameId, forSession, lambdaWad, premiumWad, inputsHash),
                expected,
                string.concat("digestOf mismatch at case ", vm.toString(i))
            );
        }
    }

    /// @dev The preimage is five 32-byte words, so its length is fixed and the fixture records it.
    ///      A length drift is the cheapest possible symptom of an encoding change, and it is worth
    ///      asserting separately from the hash because a length change would otherwise only show up
    ///      as an opaque mismatch.
    function test_commitmentPreimageIsFiveWords() public view {
        string memory json = vm.readFile(FIXTURE);
        uint256 caseCount = vm.parseJsonUint(json, ".caseCount");
        for (uint256 i = 0; i < caseCount; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            uint256 recorded = vm.parseJsonUint(json, string.concat(base, ".preimageLength"));
            assertEq(recorded, 160, "five 32-byte words");
        }
    }
}
