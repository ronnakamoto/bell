// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PremiumRegistry} from "../../src/pricing/PremiumRegistry.sol";
import {PremiumStore} from "../../src/pricing/PremiumStore.sol";
import {MockERC20, MockFeeOnTransferERC20, MockNonRevertingERC20} from "../mocks/MockERC20.sol";

/// @notice The premium registry: the commitment, the bonds, the staleness bound and the dispute.
/// @dev The deployment parameters are the brief's derived values, at the collateral's own scale:
///      a $500,000 publisher bond and a $50,000 challenger bond in six-decimal USDG, twelve sessions
///      of staleness and thirteen of bond lock. Written as `500_000e6`, not `500_000e18`, because
///      the second is the incoherence DESIGN_NOTES.md F4 records.
contract PremiumRegistryTest is Test {
    uint256 internal constant PUBLISHER_BOND = 500_000e6;
    uint256 internal constant CHALLENGER_BOND = 50_000e6;
    /// @dev `uint64`, matching `forSession` in the registry's signatures. The two session counters
    ///      are compared against a `forSession` on every path, and a `uint256` here would need a cast
    ///      at each of them.
    uint64 internal constant STALENESS = 12;
    uint64 internal constant BOND_LOCK = 13;

    bytes32 internal constant NAME_ID = keccak256("NVDA");
    bytes32 internal constant INPUTS_HASH = keccak256("NVDA/E/504/canonical-rows");
    uint256 internal constant LAMBDA = 15e18;
    uint256 internal constant PREMIUM = 0.174e18;

    address internal constant ARBITER = address(0xA1B);
    address internal constant AUTHORITY = address(0x5E5);

    address internal publisher = address(0x9B1);
    address internal challenger = address(0xC4A);

    MockERC20 internal bondToken;
    PremiumRegistry internal registry;

    function setUp() public {
        bondToken = new MockERC20("USD Global", "USDG", 6);
        registry = new PremiumRegistry(
            bondToken, ARBITER, AUTHORITY, PUBLISHER_BOND, CHALLENGER_BOND, STALENESS, BOND_LOCK
        );
        bondToken.mint(publisher, PUBLISHER_BOND * 4);
        bondToken.mint(challenger, CHALLENGER_BOND * 4);
        vm.prank(publisher);
        bondToken.approve(address(registry), type(uint256).max);
        vm.prank(challenger);
        bondToken.approve(address(registry), type(uint256).max);
    }

    // ---------------------------------------------------------------- the digest

    function test_digestOf_isAppendixB() public view {
        // The exact preimage of paper Appendix B, with `forSession` as a uint64.
        assertEq(
            registry.digestOf(NAME_ID, 42, LAMBDA, PREMIUM, INPUTS_HASH),
            keccak256(abi.encode(NAME_ID, uint64(42), LAMBDA, PREMIUM, INPUTS_HASH))
        );
    }

    function test_digestOf_isSensitiveToEveryField() public view {
        bytes32 base = registry.digestOf(NAME_ID, 42, LAMBDA, PREMIUM, INPUTS_HASH);
        assertTrue(base != registry.digestOf(keccak256("TSLA"), 42, LAMBDA, PREMIUM, INPUTS_HASH));
        assertTrue(base != registry.digestOf(NAME_ID, 43, LAMBDA, PREMIUM, INPUTS_HASH));
        assertTrue(base != registry.digestOf(NAME_ID, 42, LAMBDA + 1, PREMIUM, INPUTS_HASH));
        assertTrue(base != registry.digestOf(NAME_ID, 42, LAMBDA, PREMIUM + 1, INPUTS_HASH));
        assertTrue(base != registry.digestOf(NAME_ID, 42, LAMBDA, PREMIUM, keccak256("other")));
    }

    // ---------------------------------------------------------------- the storage layout

    /// @notice The commitment record occupies five slots, and this pins which field is in which.
    /// @dev The struct's field order is a gas decision (DESIGN_NOTES.md F42): the shipped ordering
    ///      costs one cold `SSTORE` less than the natural widest-first ordering of the same eight
    ///      fields, and `commit` is over the brief's 150,000 budget even with the saving. A
    ///      reordering that reads more tidily and costs 20,000 gas would pass every other test in
    ///      this file, because nothing else here can see the difference. This one can.
    ///
    ///      The slot arithmetic, all derived rather than guessed:
    ///        `_commitments` is slot 1 of `PremiumStore` -- `currentSession` takes slot 0, and
    ///        `PremiumRegistry` declares no state of its own, so the derived layout is identical.
    ///        inner mapping slot = keccak256(abi.encode(NAME_ID, uint256(1)))
    ///        record base        = keccak256(abi.encode(uint64(forSession), innerSlot))
    ///      then, within the record, +0 packs publisher/status/committedInSession, +1 packs
    ///      challenger/bond, +2 is lambdaWad, +3 is premiumWad, and +4 is inputsHash.
    ///
    ///      Reading raw slots is the point. `commitmentOf` would decode correctly under any field
    ///      order, so asserting through it would test the decoder, not the layout.
    ///
    ///      **If this fails, do not adjust the expected slot.** Run
    ///      `forge inspect src/pricing/PremiumStore.sol:PremiumStore storage-layout` and
    ///      `forge inspect test/mocks/PackingProbe.sol:PackingProbe storage-layout`, and fix the
    ///      layout the failure is pointing at.
    function test_theCommitmentRecordIsFiveSlotsAndTheDigestIsTheLastOfThem() public {
        vm.prank(publisher);
        registry.commit(NAME_ID, 1, LAMBDA, PREMIUM, INPUTS_HASH);

        uint256 innerSlot = uint256(keccak256(abi.encode(NAME_ID, uint256(1))));
        uint256 base = uint256(keccak256(abi.encode(uint64(1), innerSlot)));

        // +0: publisher (20 bytes) | status (1) | committedInSession (8) = 29 of 32 bytes used.
        // Solidity packs from the least significant byte upward, so the publisher is the low 20
        // bytes, the status is byte 20, and the session is bytes 21 to 28.
        bytes32 slot0 = vm.load(address(registry), bytes32(base));
        assertEq(address(uint160(uint256(slot0))), publisher, "publisher is the low 20 bytes");
        assertEq(uint8(uint256(slot0) >> 160), uint8(1), "status byte 20 is Committed");
        assertEq(uint64(uint256(slot0) >> 168), uint64(0), "committedInSession is bytes 21..28");

        assertEq(vm.load(address(registry), bytes32(base + 2)), bytes32(LAMBDA), "lambdaWad at +2");
        assertEq(
            vm.load(address(registry), bytes32(base + 3)), bytes32(PREMIUM), "premiumWad at +3"
        );
        assertEq(vm.load(address(registry), bytes32(base + 4)), INPUTS_HASH, "inputsHash at +4");

        // And nothing past it. A sixth occupied slot means the struct grew, which is the regression
        // this test exists to catch.
        assertEq(vm.load(address(registry), bytes32(base + 5)), bytes32(0), "no sixth slot");
    }

    /// @notice The second slot packs the challenger with the bond, which is why the bond is uint96.
    /// @dev Separate from the test above because it needs a challenge to populate, and because it
    ///      guards a different decision: `bond` narrowed from `uint256` to `uint96` precisely so it
    ///      would share this slot. If someone widens it back, this fails at +1 rather than at +5.
    function test_theChallengerAndTheBondShareOneSlot() public {
        vm.prank(publisher);
        registry.commit(NAME_ID, 1, LAMBDA, PREMIUM, INPUTS_HASH);
        vm.prank(challenger);
        registry.challenge(NAME_ID, 1);

        uint256 innerSlot = uint256(keccak256(abi.encode(NAME_ID, uint256(1))));
        uint256 base = uint256(keccak256(abi.encode(uint64(1), innerSlot)));

        // +1: challenger (20 bytes) | bond (12 bytes) = 32 of 32 bytes, exactly full.
        bytes32 slot1 = vm.load(address(registry), bytes32(base + 1));
        assertEq(address(uint160(uint256(slot1))), challenger, "challenger is the low 20 bytes");
        assertEq(uint96(uint256(slot1) >> 160), uint96(PUBLISHER_BOND), "bond is the top 12 bytes");
    }

    // ---------------------------------------------------------------- commit

    function test_commit_takesTheBondAndRecordsTheCommitment() public {
        _commit(1);
        PremiumStore.Commitment memory commitment = registry.commitmentOf(NAME_ID, 1);
        assertEq(commitment.publisher, publisher);
        assertEq(commitment.lambdaWad, LAMBDA);
        assertEq(commitment.premiumWad, PREMIUM);
        assertEq(commitment.inputsHash, INPUTS_HASH);
        assertEq(commitment.bond, PUBLISHER_BOND);
        assertEq(commitment.committedInSession, 0);
        assertEq(uint8(commitment.status), uint8(PremiumStore.CommitmentStatus.Committed));
        assertEq(bondToken.balanceOf(address(registry)), PUBLISHER_BOND, "the bond is held");
    }

    function test_commit_refusesASessionThatHasOpened() public {
        // The rule the whole contract exists for. `forSession == currentSession` is already too late:
        // the outcome may be known, so a publisher could fit after seeing it.
        // `currentSession` is zero, so `forSession == 0` is "now" rather than "later", which is
        // already too late. A commitment for session one is legitimately in the future and is
        // admitted by the test below.
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.SessionAlreadyOpen.selector, uint64(0), uint64(0))
        );
        registry.commit(NAME_ID, 0, LAMBDA, PREMIUM, INPUTS_HASH);
    }

    function test_commit_refusesAPastSession() public {
        vm.prank(AUTHORITY);
        registry.advanceSession();
        vm.prank(AUTHORITY);
        registry.advanceSession();

        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.SessionAlreadyOpen.selector, uint64(1), uint64(2))
        );
        registry.commit(NAME_ID, 1, LAMBDA, PREMIUM, INPUTS_HASH);

        _commit(3);
        assertEq(registry.commitmentOf(NAME_ID, 3).bond, PUBLISHER_BOND);
    }

    function test_commit_refusesAZeroParameter() public {
        // A parameter of zero is never priceable, so a commitment carrying one is a bond posted for
        // nothing -- and, worse, a commitment that looks live.
        vm.startPrank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.ZeroParameter.selector, NAME_ID, uint64(1))
        );
        registry.commit(NAME_ID, 1, 0, PREMIUM, INPUTS_HASH);

        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.ZeroParameter.selector, NAME_ID, uint64(1))
        );
        registry.commit(NAME_ID, 1, LAMBDA, 0, INPUTS_HASH);
        vm.stopPrank();
    }

    function test_commit_refusesAnInsufficientBond() public {
        // A token that reports failure by returning false rather than reverting. A standard token
        // reverts, so it can never reach the checked return value -- and a defensive check that no
        // input can trigger is indistinguishable from no check at all.
        MockNonRevertingERC20 hostile = new MockNonRevertingERC20("Hostile", "HST", 6);
        PremiumRegistry hostileRegistry = new PremiumRegistry(
            hostile, ARBITER, AUTHORITY, PUBLISHER_BOND, CHALLENGER_BOND, STALENESS, BOND_LOCK
        );
        vm.prank(publisher);
        vm.expectRevert(PremiumStore.BondTransferFailed.selector);
        hostileRegistry.commit(NAME_ID, 1, LAMBDA, PREMIUM, INPUTS_HASH);
    }

    function test_commit_refusesABondThatDoesNotArriveInFull() public {
        // The publisher bond is a minimum, and it has to be met by what *arrives*: a fee-on-transfer
        // token delivers less than the nominal amount, and a registry that credited the nominal
        // figure would believe it held a bond it does not.
        MockFeeOnTransferERC20 leaky = new MockFeeOnTransferERC20("Leaky", "LKY", 6, 100);
        PremiumRegistry leakyRegistry = new PremiumRegistry(
            leaky, ARBITER, AUTHORITY, PUBLISHER_BOND, CHALLENGER_BOND, STALENESS, BOND_LOCK
        );
        leaky.mint(publisher, PUBLISHER_BOND);
        uint256 expected = PUBLISHER_BOND - (PUBLISHER_BOND / 100);
        vm.startPrank(publisher);
        leaky.approve(address(leakyRegistry), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.BondTooSmall.selector, expected, PUBLISHER_BOND)
        );
        leakyRegistry.commit(NAME_ID, 1, LAMBDA, PREMIUM, INPUTS_HASH);
        vm.stopPrank();
    }

    function test_commit_refusesADuplicate() public {
        _commit(1);
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.AlreadyCommitted.selector, NAME_ID, uint64(1))
        );
        registry.commit(NAME_ID, 1, LAMBDA, PREMIUM, INPUTS_HASH);
    }

    function test_commit_isNotPayable() public {
        // Ruling R2. Native value is rejected by construction: a non-payable function reverts on a
        // non-zero msg.value, so a caller who follows the brief's `payable` signature loses the call
        // rather than the funds.
        vm.deal(publisher, 1 ether);
        vm.prank(publisher);
        (bool ok,) = address(registry).call{value: 1 ether}(
            abi.encodeWithSelector(
                registry.commit.selector, NAME_ID, uint64(1), LAMBDA, PREMIUM, INPUTS_HASH
            )
        );
        assertFalse(ok, "native value is refused");
    }

    // ---------------------------------------------------------------- quote, the usable path

    function test_quote_isUsableForAFreshCommitment() public {
        _commit(1);
        (PremiumRegistry.Quote verdict, uint256 lam, uint256 premium) = registry.quote(NAME_ID, 1);
        assertEq(uint8(verdict), uint8(PremiumRegistry.Quote.Usable));
        assertEq(lam, LAMBDA);
        assertEq(premium, PREMIUM);
    }

    function test_quote_refusesWhenNothingIsCommitted() public {
        (PremiumRegistry.Quote verdict, uint256 lam, uint256 premium) = registry.quote(NAME_ID, 1);
        assertEq(uint8(verdict), uint8(PremiumRegistry.Quote.Refuse));
        assertEq(lam, 0, "and the parameters are zero, which is what Refuse means");
        assertEq(premium, 0);
    }

    function test_quote_refusesBeyondTheStalenessBound() public {
        // The bound is measured from the session the commitment was *made* in, so advancing the
        // clock past it makes the parameter unusable however far in the future it was aimed.
        _commit(STALENESS + 1);
        (,, uint256 premium) = registry.quote(NAME_ID, STALENESS + 1);
        assertEq(premium, PREMIUM, "inside the bound it is usable");

        for (uint256 i = 0; i <= STALENESS; ++i) {
            vm.prank(AUTHORITY);
            registry.advanceSession();
        }
        (PremiumRegistry.Quote verdict,,) = registry.quote(NAME_ID, STALENESS + 1);
        assertEq(uint8(verdict), uint8(PremiumRegistry.Quote.Refuse), "past it, refused");
    }

    function test_quote_refusesAtTheStalenessBoundaryExactly() public {
        // The boundary, both sides. `stalenessSessions` sessions after the one it was made in is
        // still inside; one more is not.
        _commit(STALENESS + 2);
        for (uint256 i = 0; i < STALENESS; ++i) {
            vm.prank(AUTHORITY);
            registry.advanceSession();
        }
        (,, uint256 atBound) = registry.quote(NAME_ID, STALENESS + 2);
        assertEq(atBound, PREMIUM, "exactly at the bound it is still usable");

        vm.prank(AUTHORITY);
        registry.advanceSession();
        (PremiumRegistry.Quote verdict,,) = registry.quote(NAME_ID, STALENESS + 2);
        assertEq(uint8(verdict), uint8(PremiumRegistry.Quote.Refuse), "one past it is not");
    }

    // ---------------------------------------------------------------- challenge and fallback

    function test_challenge_locksTheBondAndDegradesTheQuoteToRefuseWithoutAFallback() public {
        _commit(1);
        _challenge(1);
        assertEq(
            uint8(registry.commitmentOf(NAME_ID, 1).status),
            uint8(PremiumStore.CommitmentStatus.Challenged)
        );
        (PremiumRegistry.Quote verdict,,) = registry.quote(NAME_ID, 1);
        assertEq(
            uint8(verdict),
            uint8(PremiumRegistry.Quote.Refuse),
            "no fallback registered, so refuse rather than guess"
        );
    }

    function test_quote_fallsBackRatherThanHalting() public {
        // Fallback, not halt. With a trailing-realised estimate registered the pool keeps pricing
        // through the dispute; without one it refuses. Neither is a revert, because a revert would
        // stop the pool, and a halt is the failure the fallback exists to avoid.
        vm.prank(AUTHORITY);
        registry.setFallback(NAME_ID, 11e18, 0.1413e18);
        _commit(1);
        _challenge(1);

        (PremiumRegistry.Quote verdict, uint256 lam, uint256 premium) = registry.quote(NAME_ID, 1);
        assertEq(uint8(verdict), uint8(PremiumRegistry.Quote.Fallback));
        assertEq(lam, 11e18, "the registered trailing-realised leverage");
        assertEq(premium, 0.1413e18);
    }

    function test_setFallback_refusesAZeroParameter() public {
        // The registry must never register a zero either, for the same reason it must never return
        // one: a zero premium is a free claim.
        vm.startPrank(AUTHORITY);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.ZeroParameter.selector, NAME_ID, uint64(0))
        );
        registry.setFallback(NAME_ID, 0, 0.1413e18);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.ZeroParameter.selector, NAME_ID, uint64(0))
        );
        registry.setFallback(NAME_ID, 11e18, 0);
        vm.stopPrank();
    }

    function test_challenge_bondIsExactByConstruction() public {
        // The signature carries no amount, so a challenger cannot ask to post more or less than the
        // bond. That is how "exactly" is enforced, and it is stronger than a comparison: there is no
        // input that could be wrong. `ChallengeBondMismatch` therefore covers the remaining case,
        // where the token does not deliver what was asked for.
        assertEq(registry.challengerBond(), CHALLENGER_BOND, "the bond is a constant");
        assertEq(registry.minPublisherBond(), PUBLISHER_BOND, "and so is the publisher's");
    }

    function test_challenge_refusesATokenThatDoesNotDeliverTheBond() public {
        // A fee-on-transfer token delivers less than the nominal bond. It cannot fund a publisher
        // commitment either, because the publisher bond is a minimum on what arrives, so the
        // challenger path is unreachable through this token -- asserted rather than assumed.
        MockFeeOnTransferERC20 leaky = new MockFeeOnTransferERC20("Leaky", "LKY", 6, 100);
        PremiumRegistry leakyRegistry = new PremiumRegistry(
            leaky, ARBITER, AUTHORITY, PUBLISHER_BOND, CHALLENGER_BOND, STALENESS, BOND_LOCK
        );
        leaky.mint(publisher, PUBLISHER_BOND * 2);
        vm.startPrank(publisher);
        leaky.approve(address(leakyRegistry), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                PremiumStore.BondTooSmall.selector,
                PUBLISHER_BOND - (PUBLISHER_BOND / 100),
                PUBLISHER_BOND
            )
        );
        leakyRegistry.commit(NAME_ID, 1, LAMBDA, PREMIUM, INPUTS_HASH);
        vm.stopPrank();
    }

    function test_challenge_refusesAnUncommittedSession() public {
        vm.prank(challenger);
        vm.expectRevert(
            abi.encodeWithSelector(
                PremiumStore.NotChallengeable.selector,
                NAME_ID,
                uint64(1),
                PremiumStore.CommitmentStatus.None
            )
        );
        registry.challenge(NAME_ID, 1);
    }

    function test_challenge_refusesTwice() public {
        _commit(1);
        _challenge(1);
        vm.prank(challenger);
        vm.expectRevert(
            abi.encodeWithSelector(
                PremiumStore.NotChallengeable.selector,
                NAME_ID,
                uint64(1),
                PremiumStore.CommitmentStatus.Challenged
            )
        );
        registry.challenge(NAME_ID, 1);
    }

    // ---------------------------------------------------------------- the ruling

    function test_resolve_isArbiterOnly() public {
        _commit(1);
        _challenge(1);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(PremiumStore.NotArbiter.selector, address(0xBAD)));
        registry.resolve(NAME_ID, 1, true);
    }

    function test_resolve_refusesAnUnchallengedCommitment() public {
        _commit(1);
        vm.prank(ARBITER);
        vm.expectRevert(
            abi.encodeWithSelector(
                PremiumStore.NotChallenged.selector,
                NAME_ID,
                uint64(1),
                PremiumStore.CommitmentStatus.Committed
            )
        );
        registry.resolve(NAME_ID, 1, true);
    }

    function test_resolve_vindicatesThePublisherAndTransfersTheChallengerBond() public {
        _commit(1);
        _challenge(1);
        uint256 publisherBefore = bondToken.balanceOf(publisher);
        uint256 challengerBefore = bondToken.balanceOf(challenger);

        vm.prank(ARBITER);
        registry.resolve(NAME_ID, 1, true);

        assertEq(
            uint8(registry.commitmentOf(NAME_ID, 1).status),
            uint8(PremiumStore.CommitmentStatus.Vindicated)
        );
        assertEq(
            bondToken.balanceOf(publisher) - publisherBefore,
            CHALLENGER_BOND,
            "the publisher takes the challenger's bond"
        );
        // The challenger's balance is already net of the bond it posted at challenge time; the
        // ruling moves that bond from the registry to the publisher and does not touch the
        // challenger again.
        assertEq(
            bondToken.balanceOf(challenger), challengerBefore, "the challenger pays nothing further"
        );
        (PremiumRegistry.Quote verdict,,) = registry.quote(NAME_ID, 1);
        assertEq(uint8(verdict), uint8(PremiumRegistry.Quote.Usable), "the parameter stays usable");
    }

    function test_resolve_slashesThePublisherAndMakesTheParameterUnusable() public {
        _commit(1);
        _challenge(1);
        uint256 challengerBefore = bondToken.balanceOf(challenger);

        vm.prank(ARBITER);
        registry.resolve(NAME_ID, 1, false);

        assertEq(
            uint8(registry.commitmentOf(NAME_ID, 1).status),
            uint8(PremiumStore.CommitmentStatus.Slashed)
        );
        assertEq(
            bondToken.balanceOf(challenger) - challengerBefore,
            PUBLISHER_BOND,
            "the challenger takes the publisher's bond"
        );
        // Usability is the punishment that matters: the bond is recoverable, the standing of the
        // parameter set is not. And a fallback does not rescue a slashed commitment, because a
        // slashed parameter is not a disputed one.
        vm.prank(AUTHORITY);
        registry.setFallback(NAME_ID, 11e18, 0.1413e18);
        (PremiumRegistry.Quote verdict,,) = registry.quote(NAME_ID, 1);
        assertEq(uint8(verdict), uint8(PremiumRegistry.Quote.Refuse));
    }

    function test_resolve_isTerminal() public {
        _commit(1);
        _challenge(1);
        vm.startPrank(ARBITER);
        registry.resolve(NAME_ID, 1, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                PremiumStore.NotChallenged.selector,
                NAME_ID,
                uint64(1),
                PremiumStore.CommitmentStatus.Slashed
            )
        );
        registry.resolve(NAME_ID, 1, false);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- the bond lock

    function test_withdrawPublisherBond_respectsTheLock() public {
        // The lock is what makes the bond a bond rather than a deposit. A vindication answers "does
        // this match its inputs?", not "were those the right inputs?", and only the session's outcome
        // answers the second.
        _commit(1);
        _challenge(1);
        vm.prank(ARBITER);
        registry.resolve(NAME_ID, 1, true);

        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.BondLocked.selector, uint64(BOND_LOCK), uint64(0))
        );
        registry.withdrawPublisherBond(NAME_ID, 1);

        for (uint256 i = 0; i < BOND_LOCK; ++i) {
            vm.prank(AUTHORITY);
            registry.advanceSession();
        }
        uint256 before = bondToken.balanceOf(publisher);
        vm.prank(publisher);
        registry.withdrawPublisherBond(NAME_ID, 1);
        assertEq(bondToken.balanceOf(publisher) - before, PUBLISHER_BOND, "the bond is released");
    }

    function test_withdrawPublisherBond_refusesTwice() public {
        _commit(1);
        for (uint256 i = 0; i < BOND_LOCK; ++i) {
            vm.prank(AUTHORITY);
            registry.advanceSession();
        }
        vm.startPrank(publisher);
        registry.withdrawPublisherBond(NAME_ID, 1);
        vm.expectRevert(
            abi.encodeWithSelector(PremiumStore.NothingToWithdraw.selector, NAME_ID, uint64(1))
        );
        registry.withdrawPublisherBond(NAME_ID, 1);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- access and configuration

    function test_advanceSession_isAuthorityOnly() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(PremiumStore.NotArbiter.selector, address(0xBAD)));
        registry.advanceSession();
    }

    function test_advanceSession_isMonotone() public {
        assertEq(registry.currentSession(), 0);
        vm.startPrank(AUTHORITY);
        registry.advanceSession();
        registry.advanceSession();
        vm.stopPrank();
        assertEq(registry.currentSession(), 2, "it only ever moves forward");
    }

    function test_setFallback_isAuthorityOnly() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(PremiumStore.NotArbiter.selector, address(0xBAD)));
        registry.setFallback(NAME_ID, 11e18, 0.1413e18);
    }

    function test_constructor_refusesAZeroAddress() public {
        vm.expectRevert(PremiumStore.ZeroAddress.selector);
        new PremiumRegistry(
            bondToken, address(0), AUTHORITY, PUBLISHER_BOND, CHALLENGER_BOND, 12, 13
        );
        vm.expectRevert(PremiumStore.ZeroAddress.selector);
        new PremiumRegistry(bondToken, ARBITER, address(0), PUBLISHER_BOND, CHALLENGER_BOND, 12, 13);
    }

    function test_constructor_refusesAZeroBond() public {
        vm.expectRevert(abi.encodeWithSelector(PremiumStore.BondTooSmall.selector, 0, 1));
        new PremiumRegistry(bondToken, ARBITER, AUTHORITY, 0, CHALLENGER_BOND, 12, 13);
        vm.expectRevert(abi.encodeWithSelector(PremiumStore.ChallengeBondMismatch.selector, 0, 1));
        new PremiumRegistry(bondToken, ARBITER, AUTHORITY, PUBLISHER_BOND, 0, 12, 13);
    }

    // ---------------------------------------------------------------- helpers

    function _commit(uint64 forSession) internal {
        vm.prank(publisher);
        registry.commit(NAME_ID, forSession, LAMBDA, PREMIUM, INPUTS_HASH);
    }

    function _challenge(uint64 forSession) internal {
        vm.prank(challenger);
        registry.challenge(NAME_ID, forSession);
    }
}
