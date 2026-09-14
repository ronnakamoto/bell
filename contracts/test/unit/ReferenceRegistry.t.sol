// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {Branch} from "../../src/types/Branch.sol";
import {Payoff} from "../../src/libraries/Payoff.sol";
import {ReferencePrintBook} from "../../src/core/ReferencePrintBook.sol";
import {ReferenceRegistry} from "../../src/core/ReferenceRegistry.sol";
import {Session} from "../../src/core/Session.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockReferenceToken, MockSequencerFeed} from "../mocks/MockProbes.sol";

/// @notice The print book, the five guards, and the branch set.
/// @dev Every guard is tested in both directions. A guard that has never been observed to fire is
///      indistinguishable from one that does nothing, and one that fires when it should not refuses a
///      legitimate settlement.
contract ReferenceRegistryTest is Test {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant LAM = 15e18;
    uint256 internal constant NOTIONAL_CAP = 5_000_000 * UNIT;

    /// @dev The Tier-1 band, which is the correct regulatory band for this universe. The design's
    ///      legacy default is 25%; correcting it makes the fallback fire roughly twice as often.
    uint256 internal constant TIER1_BAND = 0.05e18;
    uint256 internal constant PLAUSIBILITY_BAND = 0.25e18;
    uint256 internal constant FRESHNESS = 600;
    uint256 internal constant STALENESS = 7_200;

    address internal constant REPORTER = address(0x5EED);
    address internal constant AUTHORITY = address(0xA17);

    MockERC20 internal collateral;
    MockReferenceToken internal referenceToken;
    MockSequencerFeed internal sequencer;
    ReferenceRegistry internal registry;
    Session internal session;

    function setUp() public {
        vm.warp(1_800_000_000);
        collateral = new MockERC20("USD Global", "USDG", 6);
        referenceToken = new MockReferenceToken(1e18);
        sequencer = new MockSequencerFeed();

        registry =
            new ReferenceRegistry(AUTHORITY, PLAUSIBILITY_BAND, TIER1_BAND, FRESHNESS, STALENESS);

        session = new Session(
            collateral,
            address(referenceToken),
            LAM,
            block.timestamp + 17.5 hours,
            NOTIONAL_CAP,
            address(registry)
        );

        vm.prank(AUTHORITY);
        registry.setAuthorisedSource(REPORTER, true);
    }

    // ---------------------------------------------------------------- registration

    function test_registerSession_recordsTheMultiplierItWillBeJudgedAgainst() public {
        (uint256 expiry, uint256 lamWad) =
            registry.registerSession(address(session), address(referenceToken));
        assertEq(expiry, session.expiryTimestamp());
        assertEq(lamWad, LAM);

        ReferenceRegistry.SessionRecord memory record = registry.sessionRecord(address(session));
        assertEq(record.referenceToken, address(referenceToken));
        assertEq(record.multiplierAtRegistration, 1e18, "read from the token, not supplied");
        assertFalse(record.resolved);
        assertFalse(registry.sessionResolved(address(session)));
    }

    function test_registerSession_refusesADuplicate() public {
        registry.registerSession(address(session), address(referenceToken));
        vm.expectRevert(
            abi.encodeWithSelector(ReferenceRegistry.AlreadyRegistered.selector, address(session))
        );
        registry.registerSession(address(session), address(referenceToken));
    }

    // ---------------------------------------------------------------- ingestion guards

    function test_submitPrint_acceptsAPlausibleGap() public {
        _submit(0.02e18, 1, 0);
        assertEq(registry.printCount(), 1);
        ReferencePrintBook.Print memory print = registry.printAt(0);
        assertEq(print.gapWad, 0.02e18);
        assertEq(print.source, REPORTER);
    }

    function test_submitPrint_acceptsASignedGap() public {
        // The payoff is even in the gap, so a negative gap must be admitted and must settle the same
        // way as its magnitude. Refusing one sign would halve the instrument.
        _submit(-0.02e18, 1, 0);
        assertEq(registry.printAt(0).gapWad, -0.02e18);
    }

    function test_submitPrint_refusesAnUnauthorisedSource() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.NotAuthorisedSource.selector, address(0xBAD))
        );
        registry.submitPrint(address(0xBAD), 1, uint64(block.timestamp), 0.01e18);
    }

    function test_G3_refusesAPrintBeyondTheTier1HaltBand() public {
        // Guard G3, in the direction the paper records: a 4% print is admitted and a 6% print is not.
        _submit(0.04e18, 1, 0);
        assertEq(registry.printCount(), 1, "the 4% print is recorded");

        vm.prank(REPORTER);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.HaltedGap.selector, 0.06e18, TIER1_BAND)
        );
        registry.submitPrint(REPORTER, 1, uint64(block.timestamp), 0.06e18);

        vm.prank(REPORTER);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.HaltedGap.selector, -0.06e18, TIER1_BAND)
        );
        registry.submitPrint(REPORTER, 1, uint64(block.timestamp), -0.06e18);

        assertEq(registry.printCount(), 1, "the print set is unchanged");
    }

    function test_plausibility_refusesAFeedFaultAndNamesItAsOne() public {
        // A 40% gap is a feed fault, not a halt. The plausibility band is checked first precisely so
        // that the error names the real defect rather than reporting every fault as a halt.
        vm.prank(REPORTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferencePrintBook.ImplausibleGap.selector, 0.4e18, PLAUSIBILITY_BAND
            )
        );
        registry.submitPrint(REPORTER, 1, uint64(block.timestamp), 0.4e18);

        vm.prank(REPORTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferencePrintBook.ImplausibleGap.selector, -0.9e18, PLAUSIBILITY_BAND
            )
        );
        registry.submitPrint(REPORTER, 1, uint64(block.timestamp), -0.9e18);
    }

    function test_G10b_refusesAPrintWhileTheSequencerIsDown() public {
        vm.prank(AUTHORITY);
        registry.setSequencerUptimeFeed(address(sequencer), 1_800);
        sequencer.setUp(false, block.timestamp);

        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.SequencerDown.selector, 0));
        registry.submitPrint(REPORTER, 1, uint64(block.timestamp), 0.01e18);
    }

    function test_G10b_refusesAPrintInsideTheGracePeriod() public {
        // A sequencer that has just come back is replaying queued transactions, so the head of the
        // chain is not yet the head of the market. Resolving inside the window is resolving against
        // a reordering.
        vm.prank(AUTHORITY);
        registry.setSequencerUptimeFeed(address(sequencer), 1_800);
        sequencer.setUp(true, block.timestamp);

        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.SequencerDown.selector, 1_800));
        registry.submitPrint(REPORTER, 1, uint64(block.timestamp), 0.01e18);

        vm.warp(block.timestamp + 1_800);
        _submit(0.01e18, 1, 0);
        assertEq(registry.printCount(), 1, "past the grace period it is admitted");
    }

    function test_G10b_isDisabledWhenNoFeedIsConfigured() public {
        // Behaviour-preserving default: a registry deployed before the guard existed settles
        // exactly as it did before.
        _submit(0.01e18, 1, 0);
        assertEq(registry.printCount(), 1);
    }

    // ---------------------------------------------------------------- selection

    function test_selectPrint_prefersTheLowerPriority() public {
        uint64 now_ = uint64(block.timestamp);
        _submit(0.01e18, 5, 0);
        _submit(0.03e18, 1, 0);

        (uint256 index,) = registry.selectPrint(0, now_);
        assertEq(registry.printAt(index).gapWad, 0.03e18, "priority one beats priority five");
    }

    function test_selectPrint_prefersTheLaterTimestampAtEqualPriority() public {
        uint64 now_ = uint64(block.timestamp);
        _submit(0.01e18, 1, 0);
        _submit(0.03e18, 1, 10);

        (uint256 index,) = registry.selectPrint(0, now_ + 100);
        assertEq(registry.printAt(index).gapWad, 0.03e18, "the later print is closer to the open");
    }

    function test_selectPrint_breaksRemainingTiesByInsertionIndex() public {
        uint64 now_ = uint64(block.timestamp);
        _submit(0.01e18, 1, 0);
        _submit(0.03e18, 1, 0);

        (uint256 index,) = registry.selectPrint(0, now_);
        assertEq(index, 0, "the first submitted wins a tie it cannot otherwise resolve");
    }

    function test_selectPrint_refusesRatherThanReturningADefault() public {
        // Fail closed. A selector that returned index zero on an empty set would hand settlement a
        // print that was never made.
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.NoQualifyingPrint.selector, 0, 0));
        registry.selectPrint(0, block.timestamp);

        _submit(0.01e18, 1, 0);
        // `notBefore` must be strictly after the print's own timestamp for the print to be excluded.
        uint256 afterPrint = session.expiryTimestamp() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.NoQualifyingPrint.selector, afterPrint, 1)
        );
        registry.selectPrint(afterPrint, afterPrint);
    }

    function test_selectPrint_marksAPrintStaleBeyondTheFreshnessBound() public {
        _submit(0.01e18, 1, 0);
        // Measured from the print's own timestamp, not from the wall clock: the print is submitted
        // at the expiry, which is in the future, so an age measured from `block.timestamp` would
        // clamp to zero and no print would ever look stale.
        uint64 observed = uint64(session.expiryTimestamp());
        (, bool live) = registry.selectPrint(0, observed + FRESHNESS);
        assertFalse(live, "inside the freshness bound it is live");
        (, bool stale) = registry.selectPrint(0, observed + FRESHNESS + 1);
        assertTrue(stale, "beyond it, stale");
    }

    // ---------------------------------------------------------------- resolution branches

    function test_resolve_settlesOnALivePrint() public {
        _prepareSessionWithPrint(0.02e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch) = registry.resolve(address(session));
        assertEq(uint8(branch), uint8(Branch.LivePrint));
        assertEq(payoff, Payoff.longWad(LAM, 0.02e18));
        assertEq(session.payoffLongWad(), payoff, "the session was settled");
        assertEq(uint8(session.state()), uint8(Session.State.Settled));
        assertFalse(session.settledOnStaleReference());
        assertTrue(registry.sessionResolved(address(session)));
    }

    function test_resolve_settlesOnAStalePrintWithTheFlagSet() public {
        _prepareSessionWithPrint(0.02e18);
        vm.warp(session.expiryTimestamp() + FRESHNESS + 1);

        (, Branch branch) = registry.resolve(address(session));
        assertEq(uint8(branch), uint8(Branch.StalePrint));
        assertTrue(session.settledOnStaleReference(), "the degradation is visible, not inferred");
    }

    function test_resolve_defersWhenNoPrintQualifies() public {
        // Route R2, the architecture the paper recommends. The session is *not* settled: a deferral
        // is the absence of a decision, not a decision that the payoff is zero.
        registry.registerSession(address(session), address(referenceToken));
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch) = registry.resolve(address(session));
        assertEq(uint8(branch), uint8(Branch.Deferred));
        assertEq(payoff, 0);
        assertEq(uint8(session.state()), uint8(Session.State.Expired), "still unsettled");
        assertFalse(registry.sessionResolved(address(session)), "and still resolvable later");
    }

    function test_resolve_voidsAtHalfOnlyWhenTheRouteIsEnabled() public {
        // Route R1. It must never ship, and the test exists to show why the flag is off by default:
        // voiding pays half to every holder whether or not the gap was near half.
        vm.prank(AUTHORITY);
        registry.setVoidAtHalf(true);
        registry.registerSession(address(session), address(referenceToken));
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch) = registry.resolve(address(session));
        assertEq(uint8(branch), uint8(Branch.VoidAtHalf));
        assertEq(payoff, Constants.WAD / 2, "half to the long, half to the short");
        assertEq(uint8(session.state()), uint8(Session.State.Settled));
    }

    function test_resolve_takesTheCorporateActionBranchOnMultiplierDrift() public {
        // A 2% distribution produces a *negative* headline return -- the price falls -- and the
        // multiplier falls by the same factor. Dividing the gross return by the multiplier's
        // movement cancels the two exactly. A positive headline would be amplified instead, which is
        // the right behaviour and the wrong test.
        _prepareSessionWithPrint(-0.02e18);
        referenceToken.setMultiplier(0.98e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch) = registry.resolve(address(session));
        assertEq(uint8(branch), uint8(Branch.CorporateActionTerminal), "G8 routes the branch");
        assertEq(payoff, 0, "the spurious gap is fully adjusted away");
    }

    function test_resolve_refusesBeforeTheExpiry() public {
        registry.registerSession(address(session), address(referenceToken));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferenceRegistry.NotYetExpired.selector, session.expiryTimestamp(), block.timestamp
            )
        );
        registry.resolve(address(session));
    }

    /// @notice A corporate action with no usable print must route, not revert.
    /// @dev Found by a coverage measurement rather than by reading the code: `preview` handled the
    ///      absent-print case on the drifted path and `resolve` did not, so the two disagreed
    ///      *exactly* where a caller consults `preview` to decide whether to spend gas on `resolve`.
    ///      `resolve` indexed `_prints[type(uint256).max]`, the defer sentinel, which is an
    ///      out-of-bounds access: it panics with `0x32` and reports nothing. The session was then
    ///      unsettleable, because every subsequent call panicked the same way.
    ///
    ///      This is the case the registry's own comments call a designed degradation: an absent print
    ///      is a state the route answers for, not a fault.
    function test_resolve_corporateActionWithNoPrint_defersRatherThanPanicking() public {
        registry.registerSession(address(session), address(referenceToken));
        referenceToken.setMultiplier(0.98e18);
        vm.warp(session.expiryTimestamp() + 1);
        // No print was ever submitted, so `_selectOrDefer` returns its sentinel.

        (uint256 payoff, Branch branch) = registry.resolve(address(session));
        assertEq(uint8(branch), uint8(Branch.Deferred), "deferred, not a panic");
        assertEq(payoff, 0, "a deferral fixes no payoff");
        assertFalse(registry.sessionResolved(address(session)), "and nothing is marked resolved");
    }

    /// @dev The same absence with void-at-half enabled pays half to every holder, which is the
    ///      route's other answer to an absent print. Both answers must be reachable on the drifted
    ///      path, not just the one the default configuration happens to take.
    function test_resolve_corporateActionWithNoPrint_voidsAtHalfWhenEnabled() public {
        registry.registerSession(address(session), address(referenceToken));
        vm.prank(AUTHORITY);
        registry.setVoidAtHalf(true);
        referenceToken.setMultiplier(0.98e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch) = registry.resolve(address(session));
        assertEq(uint8(branch), uint8(Branch.VoidAtHalf), "voided at half");
        assertEq(payoff, Constants.WAD / 2, "half to every holder");
        assertTrue(registry.sessionResolved(address(session)), "and the session is resolved");
    }

    function test_resolve_refusesAnUnregisteredSession() public {
        vm.expectRevert(
            abi.encodeWithSelector(ReferenceRegistry.NotRegistered.selector, address(session))
        );
        registry.resolve(address(session));
    }

    function test_resolve_refusesATwiceResolvedSession() public {
        _prepareSessionWithPrint(0.02e18);
        vm.warp(session.expiryTimestamp() + 1);
        registry.resolve(address(session));
        vm.expectRevert(
            abi.encodeWithSelector(ReferenceRegistry.AlreadyResolved.selector, address(session))
        );
        registry.resolve(address(session));
    }

    // ---------------------------------------------------------------- preview

    /// @dev `preview` had no tests at all until a coverage measurement showed it. It is the public
    ///      view a caller consults to decide whether to spend gas on `resolve`, so an untested
    ///      `preview` is worse than an untested private helper: a caller's pre-flight check was the
    ///      only thing standing between them and a reverting transaction.

    function test_preview_refusesAnUnregisteredSession() public {
        vm.expectRevert(
            abi.encodeWithSelector(ReferenceRegistry.NotRegistered.selector, address(session))
        );
        registry.preview(address(session));
    }

    function test_preview_refusesBeforeTheExpiry() public {
        registry.registerSession(address(session), address(referenceToken));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferenceRegistry.NotYetExpired.selector, session.expiryTimestamp(), block.timestamp
            )
        );
        registry.preview(address(session));
    }

    function test_preview_refusesAfterResolution() public {
        _prepareSessionWithPrint(0.02e18);
        vm.warp(session.expiryTimestamp() + 1);
        registry.resolve(address(session));

        vm.expectRevert(
            abi.encodeWithSelector(ReferenceRegistry.AlreadyResolved.selector, address(session))
        );
        registry.preview(address(session));
    }

    function test_preview_reportsTheLiveBranch() public {
        _prepareSessionWithPrint(0.02e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch, bool wouldSettle) = registry.preview(address(session));
        assertEq(uint8(branch), uint8(Branch.LivePrint), "live");
        assertEq(payoff, Payoff.longWad(LAM, 0.02e18), "the payoff is the gap's");
        assertTrue(wouldSettle, "and it would settle");
    }

    function test_preview_reportsTheStaleBranch() public {
        _prepareSessionWithPrint(0.02e18);
        // Beyond the freshness bound (600s) and inside the staleness bound (7,200s).
        vm.warp(session.expiryTimestamp() + 1_000);

        (, Branch branch, bool wouldSettle) = registry.preview(address(session));
        assertEq(uint8(branch), uint8(Branch.StalePrint), "stale");
        assertTrue(wouldSettle, "a stale print still settles");
    }

    function test_preview_reportsDeferredWhenNoPrintQualifies() public {
        registry.registerSession(address(session), address(referenceToken));
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch, bool wouldSettle) = registry.preview(address(session));
        assertEq(uint8(branch), uint8(Branch.Deferred), "deferred");
        assertEq(payoff, 0, "a deferral fixes no payoff");
        assertFalse(wouldSettle, "and it would not settle");
    }

    function test_preview_reportsVoidAtHalfWhenEnabledAndNoPrintQualifies() public {
        registry.registerSession(address(session), address(referenceToken));
        vm.prank(AUTHORITY);
        registry.setVoidAtHalf(true);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch, bool wouldSettle) = registry.preview(address(session));
        assertEq(uint8(branch), uint8(Branch.VoidAtHalf), "voided at half");
        assertEq(payoff, Constants.WAD / 2, "half to every holder");
        assertTrue(wouldSettle, "a void settles");
    }

    function test_preview_reportsTheCorporateActionBranchOnDrift() public {
        _prepareSessionWithPrint(-0.02e18);
        referenceToken.setMultiplier(0.98e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch, bool wouldSettle) = registry.preview(address(session));
        assertEq(uint8(branch), uint8(Branch.CorporateActionTerminal), "G8 routes it");
        assertEq(payoff, 0, "the spurious gap adjusts away");
        assertTrue(wouldSettle, "and it would settle");
    }

    /// @dev The case that was broken. `preview` handled it and `resolve` panicked, so the two
    ///      disagreed exactly where a caller relies on the agreement.
    function test_preview_corporateActionWithNoPrint_defers() public {
        registry.registerSession(address(session), address(referenceToken));
        referenceToken.setMultiplier(0.98e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 payoff, Branch branch, bool wouldSettle) = registry.preview(address(session));
        assertEq(uint8(branch), uint8(Branch.Deferred), "deferred");
        assertEq(payoff, 0, "no payoff fixed");
        assertFalse(wouldSettle, "and it would not settle");
    }

    /// @notice `preview` and `resolve` agree, which is the property `preview`'s doc claims.
    /// @dev `preview`'s NatSpec says the three return values "are derived from the same code path
    ///      rather than a parallel one". That was not true on the drifted path, and nothing checked
    ///      it. These two tests are the check: whatever `preview` reports, `resolve` must do.
    function test_preview_agreesWithResolve() public {
        _prepareSessionWithPrint(0.02e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 previewPayoff, Branch previewBranch, bool wouldSettle) =
            registry.preview(address(session));
        (uint256 payoff, Branch branch) = registry.resolve(address(session));

        assertEq(uint8(branch), uint8(previewBranch), "the same branch");
        assertEq(payoff, previewPayoff, "the same payoff");
        assertTrue(wouldSettle, "and `wouldSettle` was honest");
    }

    /// @dev The regression case. Before the fix this call panicked with an out-of-bounds access
    ///      while `preview` reported a deferral.
    function test_preview_agreesWithResolveOnTheDriftedAbsentPrintCase() public {
        registry.registerSession(address(session), address(referenceToken));
        referenceToken.setMultiplier(0.98e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 previewPayoff, Branch previewBranch, bool wouldSettle) =
            registry.preview(address(session));
        (uint256 payoff, Branch branch) = registry.resolve(address(session));

        assertEq(uint8(branch), uint8(previewBranch), "the same branch");
        assertEq(payoff, previewPayoff, "the same payoff");
        assertFalse(wouldSettle, "and `wouldSettle` was honest: a deferral does not settle");
        assertFalse(registry.sessionResolved(address(session)), "so the session stays unresolved");
    }

    // ---------------------------------------------------------------- guard G10

    function test_G10_doesNotProbeAnUnregisteredToken() public {
        // The whole safety property of the guard. A registry that probed every reference would
        // execute the fallback of any contract that has one, which is how the paper's first
        // implementation took two passing settlement scenarios red against the real chain. An
        // unregistered token is never read, so a paused one settles exactly as before.
        _prepareSessionWithPrint(0.02e18);
        referenceToken.setPaused(true);
        vm.warp(session.expiryTimestamp() + 1);

        (, Branch branch) = registry.resolve(address(session));
        assertEq(uint8(branch), uint8(Branch.LivePrint), "an unregistered token is not probed");
    }

    function test_G10_refusesSettlementOnAPausedRegisteredToken() public {
        vm.prank(AUTHORITY);
        registry.setPauseChecked(address(referenceToken), true);
        _prepareSessionWithPrint(0.02e18);
        referenceToken.setPaused(true);
        vm.warp(session.expiryTimestamp() + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                ReferenceRegistry.ReferencePaused.selector, address(referenceToken)
            )
        );
        registry.resolve(address(session));
    }

    function test_G10_unpausingRestoresTheIdenticalPayoff() public {
        // The paper's closure test for this guard: unpausing must restore the same payoff, not merely
        // a payoff. A guard that changed the result as well as blocking it would be a mispricing.
        vm.prank(AUTHORITY);
        registry.setPauseChecked(address(referenceToken), true);
        _prepareSessionWithPrint(0.02e18);
        vm.warp(session.expiryTimestamp() + 1);

        (uint256 beforePause, Branch branchBefore,) = registry.preview(address(session));
        assertEq(uint8(branchBefore), uint8(Branch.LivePrint));

        referenceToken.setPaused(true);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferenceRegistry.ReferencePaused.selector, address(referenceToken)
            )
        );
        registry.resolve(address(session));

        referenceToken.setPaused(false);
        (uint256 payoff, Branch branch) = registry.resolve(address(session));
        assertEq(payoff, beforePause, "the same payoff as before the pause");
        assertEq(payoff, Payoff.longWad(LAM, 0.02e18), "and it is the unchanged payoff");
        assertEq(uint8(branch), uint8(Branch.LivePrint));
    }

    // ---------------------------------------------------------------- exhaustiveness

    function test_everyBranchIsHandled() public {
        // Walks every member of `Branch` and drives a real resolution through each one. This is what
        // makes an added enum member a failing test rather than a silent fall-through: the switch in
        // `_payoffForBranch` has no `default`, and its final revert is what this test would hit.
        uint256 memberCount = uint256(type(Branch).max) + 1;
        assertEq(memberCount, 5, "the branch set has five members");
        for (uint256 i = 0; i < memberCount; ++i) {
            uint256 payoff = _exerciseBranch(Branch(i));
            assertLe(payoff, Constants.WAD, "every branch pays at most the collateral unit");
        }
    }

    function test_everyBranchIsReachable() public {
        // A branch that no input can reach is a branch whose behaviour is unverified. Each of the
        // five is driven here from a clean registry, so none is dead code.
        assertEq(uint8(_branchFor(0.02e18, false, false, false, false)), uint8(Branch.LivePrint));
        assertEq(uint8(_branchFor(0.02e18, false, true, false, false)), uint8(Branch.StalePrint));
        assertEq(uint8(_branchFor(0.02e18, false, false, true, true)), uint8(Branch.VoidAtHalf));
        assertEq(uint8(_branchFor(0.02e18, false, false, false, true)), uint8(Branch.Deferred));
        assertEq(
            uint8(_branchFor(0.02e18, true, false, false, false)),
            uint8(Branch.CorporateActionTerminal)
        );
    }

    // ---------------------------------------------------------------- configuration guards

    function test_configuration_isAuthorityOnly() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferenceRegistry.NotConfigurationAuthority.selector, address(0xBAD)
            )
        );
        registry.setAuthorisedSource(address(0xBAD), true);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferenceRegistry.NotConfigurationAuthority.selector, address(0xBAD)
            )
        );
        registry.setHaltBand(0.1e18);
        vm.stopPrank();
    }

    function test_bandsMustBeUsable() public {
        // A band of zero rejects every print including a zero gap; a band at one rejects nothing.
        // Both are silent failures in opposite directions.
        vm.startPrank(AUTHORITY);
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, uint256(0)));
        registry.setHaltBand(0);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, Constants.WAD)
        );
        registry.setHaltBand(Constants.WAD);
        vm.stopPrank();
    }

    function test_constructor_refusesAnUnusableBand() public {
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, uint256(0)));
        new ReferenceRegistry(AUTHORITY, 0, TIER1_BAND, FRESHNESS, STALENESS);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, FRESHNESS - 1)
        );
        new ReferenceRegistry(AUTHORITY, PLAUSIBILITY_BAND, TIER1_BAND, FRESHNESS, FRESHNESS - 1);
    }

    /// @dev A zero configuration authority would make every setter permanently unreachable: they all
    ///      gate on `msg.sender == configurationAuthority` and no address can send from zero. Refusing
    ///      it at construction turns a registry that can never be configured into a deployment
    ///      failure.
    function test_constructor_refusesAZeroConfigurationAuthority() public {
        vm.expectRevert(ReferencePrintBook.ZeroAddress.selector);
        new ReferenceRegistry(address(0), PLAUSIBILITY_BAND, TIER1_BAND, FRESHNESS, STALENESS);
    }

    /// @dev The pause-check registry is opt-in per token, and the opt-in is the guard's whole safety
    ///      property: an unregistered reference is never probed. Zero is the mapping's "not
    ///      registered" value, so registering it would be a no-op that reads as a registration.
    function test_setPauseChecked_isAuthorityOnlyAndRefusesZero() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferenceRegistry.NotConfigurationAuthority.selector, address(0xBAD)
            )
        );
        registry.setPauseChecked(address(referenceToken), true);

        vm.prank(AUTHORITY);
        vm.expectRevert(ReferencePrintBook.ZeroAddress.selector);
        registry.setPauseChecked(address(0), true);
    }

    function test_setPauseChecked_registersAndDeregisters() public {
        vm.startPrank(AUTHORITY);
        registry.setPauseChecked(address(referenceToken), true);
        assertTrue(registry.pauseChecked(address(referenceToken)), "registered");
        registry.setPauseChecked(address(referenceToken), false);
        assertFalse(registry.pauseChecked(address(referenceToken)), "and deregistered");
        vm.stopPrank();
    }

    /// @dev A zero multiplier would divide by zero in the ex-date adjustment. The registry refuses it
    ///      at registration rather than letting every later settlement revert, which is the difference
    ///      between a listing that fails and a session that is unsettleable.
    function test_registerSession_refusesAZeroMultiplier() public {
        referenceToken.setMultiplier(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferenceRegistry.ZeroMultiplier.selector, address(referenceToken)
            )
        );
        registry.registerSession(address(session), address(referenceToken));
    }

    // ---------------------------------------------------------------- helpers

    /// @dev The timestamp is computed before the prank. `vm.prank` applies to the *next* call, and an
    ///      argument expression that calls the session would consume it -- leaving the print
    ///      submitted by the test contract and rejected as an unauthorised source.
    function _submit(int256 gapWad, uint64 priority, uint256 secondsAfterExpiry) internal {
        uint64 timestamp = uint64(session.expiryTimestamp() + secondsAfterExpiry);
        vm.prank(REPORTER);
        registry.submitPrint(REPORTER, priority, timestamp, gapWad);
    }

    function _prepareSessionWithPrint(int256 gapWad) internal {
        registry.registerSession(address(session), address(referenceToken));
        _submit(gapWad, 1, 0);
    }

    /// @dev A fresh registry and session, so that a print submitted for one branch cannot qualify for
    ///      another. The print set is global, so exercising the branches from one registry would let
    ///      the earlier submissions contaminate the later cases.
    function _freshWorld()
        internal
        returns (ReferenceRegistry freshRegistry, Session freshSession)
    {
        freshRegistry = new ReferenceRegistry(
            AUTHORITY, PLAUSIBILITY_BAND, TIER1_BAND, FRESHNESS, STALENESS
        );
        vm.prank(AUTHORITY);
        freshRegistry.setAuthorisedSource(REPORTER, true);
        freshSession = new Session(
            collateral,
            address(referenceToken),
            LAM,
            block.timestamp + 17.5 hours,
            NOTIONAL_CAP,
            address(freshRegistry)
        );
    }

    /// @dev Drives a real resolution through the branch the given inputs produce.
    function _branchFor(
        int256 gapWad,
        bool driftMultiplier,
        bool stalePrint,
        bool voidAtHalfRoute,
        bool noPrint
    ) internal returns (Branch branch) {
        referenceToken.setMultiplier(1e18);
        referenceToken.setPaused(false);
        (ReferenceRegistry freshRegistry, Session freshSession) = _freshWorld();
        freshRegistry.registerSession(address(freshSession), address(referenceToken));
        if (voidAtHalfRoute) {
            vm.prank(AUTHORITY);
            freshRegistry.setVoidAtHalf(true);
        }
        if (!noPrint) {
            // The timestamp is read before the prank: an argument expression that calls the
            // session would consume the prank and submit from the test contract instead.
            uint64 observed = uint64(freshSession.expiryTimestamp());
            vm.prank(REPORTER);
            freshRegistry.submitPrint(REPORTER, 1, observed, gapWad);
        }
        if (driftMultiplier) referenceToken.setMultiplier(0.98e18);

        vm.warp(freshSession.expiryTimestamp() + (stalePrint ? FRESHNESS + 1 : 1));
        (, branch) = freshRegistry.resolve(address(freshSession));
        return branch;
    }

    /// @dev The payoff for a branch, obtained by actually taking that branch.
    function _exerciseBranch(Branch branch) internal returns (uint256 payoff) {
        bool drift = branch == Branch.CorporateActionTerminal;
        bool stale = branch == Branch.StalePrint;
        bool voidRoute = branch == Branch.VoidAtHalf;
        // Both no-print branches need the print set empty; they differ only in the route flag.
        bool noPrint = branch == Branch.Deferred || branch == Branch.VoidAtHalf;
        (ReferenceRegistry freshRegistry, Session freshSession) = _freshWorld();
        freshRegistry.registerSession(address(freshSession), address(referenceToken));
        if (voidRoute) {
            vm.prank(AUTHORITY);
            freshRegistry.setVoidAtHalf(true);
        }
        if (!noPrint) {
            uint64 observed = uint64(freshSession.expiryTimestamp());
            vm.prank(REPORTER);
            freshRegistry.submitPrint(REPORTER, 1, observed, 0.02e18);
        }
        if (drift) referenceToken.setMultiplier(0.98e18);

        vm.warp(freshSession.expiryTimestamp() + (stale ? FRESHNESS + 1 : 1));
        Branch actual;
        (payoff, actual) = freshRegistry.resolve(address(freshSession));
        assertEq(uint8(actual), uint8(branch), "the branch is reachable and is the one expected");
    }
}
