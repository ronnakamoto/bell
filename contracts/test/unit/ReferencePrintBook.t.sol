// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {ReferencePrintBook} from "../../src/core/ReferencePrintBook.sol";
import {MockSequencerFeed} from "../mocks/MockProbes.sol";

/// @notice A minimal concrete `ReferencePrintBook`.
/// @dev The contract under test is abstract because `_requireConfigurationAuthority` is declared
///      virtual and implemented by `ReferenceRegistry`, which owns the configuration authority. This
///      harness supplies the smallest possible implementation so the book can be tested on its own,
///      without standing up a session, a reference token and a registry to reach it.
contract PrintBookHarness is ReferencePrintBook {
    /// @dev Mirrors `ReferenceRegistry`'s own error rather than inventing a second spelling of the
    ///      same refusal.
    error NotConfigurationAuthority(address caller);

    address public configurationAuthority;

    constructor(
        address configurationAuthority_,
        uint256 plausibilityBandWad_,
        uint256 haltBandWad_,
        uint256 freshnessBoundSeconds_,
        uint256 staleBoundSeconds_
    )
        ReferencePrintBook(
            plausibilityBandWad_, haltBandWad_, freshnessBoundSeconds_, staleBoundSeconds_
        )
    {
        configurationAuthority = configurationAuthority_;
    }

    function _requireConfigurationAuthority() internal view override {
        if (msg.sender != configurationAuthority) revert NotConfigurationAuthority(msg.sender);
    }

    /// @dev Exposes the non-reverting selector, which is `internal` in the book and reached through
    ///      the registry in production. Without this the "no print qualifies" path can only be
    ///      observed as a revert, and the *non-reverting* form is the one the settlement routes call.
    function trySelect(uint256 notBefore, uint256 nowTimestamp)
        external
        view
        returns (bool found, uint256 index, bool stale)
    {
        return _trySelect(notBefore, nowTimestamp);
    }
}

/// @notice The print book: the two magnitude guards, the sequencer guard, the configuration surface
///         and the deterministic selection.
/// @dev This file did not exist until a coverage measurement showed `ReferencePrintBook` at 83.33%
///      lines with **zero** hits on `setHaltBand`, `setPlausibilityBand`, `setFreshnessBounds` and
///      the `bandIsUsable` modifier. The registry's own 31 tests exercised the *reading* of those
///      bands on every settlement path but never once configured them, so the entire configuration
///      surface — which is what the guards are set by — was unverified.
contract ReferencePrintBookTest is Test {
    uint256 internal constant TIER1_BAND = 0.05e18;
    uint256 internal constant PLAUSIBILITY_BAND = 0.25e18;
    uint256 internal constant FRESHNESS = 600;
    uint256 internal constant STALENESS = 7_200;

    address internal constant AUTHORITY = address(0xA17);
    address internal constant STRANGER = address(0xBAD);
    address internal constant FEED_A = address(0xF11);
    address internal constant FEED_B = address(0xF22);

    /// @dev The moment selection is evaluated at. Prints are placed relative to it so every age in
    ///      these tests is a stated number rather than a subtraction the reader has to do.
    uint256 internal constant NOW = 100_000;
    /// @dev Age 100: inside the freshness bound, so not stale.
    uint64 internal constant T_FRESH = uint64(NOW - 100);
    /// @dev Age 1,000: beyond freshness, inside staleness.
    uint64 internal constant T_STALE = uint64(NOW - 1_000);
    /// @dev Age 10,000: beyond staleness, so not a candidate at all.
    uint64 internal constant T_TOO_OLD = uint64(NOW - 10_000);

    PrintBookHarness internal book;

    function setUp() public {
        vm.warp(NOW);
        book = new PrintBookHarness(AUTHORITY, PLAUSIBILITY_BAND, TIER1_BAND, FRESHNESS, STALENESS);
    }

    // ---------------------------------------------------------------- the constructor

    function test_constructor_recordsTheBandsAndBounds() public view {
        assertEq(book.plausibilityBandWad(), PLAUSIBILITY_BAND, "plausibility");
        assertEq(book.haltBandWad(), TIER1_BAND, "halt");
        assertEq(book.freshnessBoundSeconds(), FRESHNESS, "freshness");
        assertEq(book.staleBoundSeconds(), STALENESS, "staleness");
        assertEq(book.printCount(), 0, "and starts empty");
    }

    /// @dev A zero band rejects every print including a zero gap; a band at or above one rejects
    ///      nothing. Both are silent failures in opposite directions, so neither is accepted.
    function test_constructor_refusesAnUnusableBand() public {
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, uint256(0)));
        new PrintBookHarness(AUTHORITY, 0, TIER1_BAND, FRESHNESS, STALENESS);

        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, Constants.WAD)
        );
        new PrintBookHarness(AUTHORITY, PLAUSIBILITY_BAND, Constants.WAD, FRESHNESS, STALENESS);
    }

    /// @dev The staleness bound below the freshness bound would make every fresh print also
    ///      not-qualifying, which is a contradiction rather than a configuration.
    function test_constructor_refusesStalenessBelowFreshness() public {
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, uint256(100))
        );
        new PrintBookHarness(AUTHORITY, PLAUSIBILITY_BAND, TIER1_BAND, 600, 100);
    }

    // ---------------------------------------------------------------- configuration

    function test_setAuthorisedSource_isAuthorityOnly() public {
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(PrintBookHarness.NotConfigurationAuthority.selector, STRANGER)
        );
        book.setAuthorisedSource(STRANGER, true);
    }

    function test_setAuthorisedSource_togglesBothWays() public {
        vm.prank(AUTHORITY);
        book.setAuthorisedSource(FEED_A, true);
        assertTrue(book.authorisedSource(FEED_A), "authorised");

        vm.prank(AUTHORITY);
        book.setAuthorisedSource(FEED_A, false);
        assertFalse(book.authorisedSource(FEED_A), "and revoked");
    }

    /// @dev Zero would authorise nothing but reads as "no source", which is the value the mapping
    ///      uses for "never authorised". Refusing it keeps the two distinguishable.
    function test_setAuthorisedSource_refusesZero() public {
        vm.prank(AUTHORITY);
        vm.expectRevert(ReferencePrintBook.ZeroAddress.selector);
        book.setAuthorisedSource(address(0), true);
    }

    /// @dev The modifier runs before the body, so a caller who is neither authorised nor passing a
    ///      usable band is told about the *band*. That order is deliberate and this pins it: band
    ///      validity is public knowledge, so the ordering leaks nothing, and a misconfigured band is
    ///      the failure that matters.
    function test_setHaltBand_reportsTheBandBeforeTheAuthority() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, uint256(0)));
        book.setHaltBand(0);
    }

    function test_setHaltBand_isAuthorityOnlyAndRefusesUnusableBands() public {
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(PrintBookHarness.NotConfigurationAuthority.selector, STRANGER)
        );
        book.setHaltBand(0.03e18);

        vm.prank(AUTHORITY);
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, uint256(0)));
        book.setHaltBand(0);

        vm.prank(AUTHORITY);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, Constants.WAD)
        );
        book.setHaltBand(Constants.WAD);
    }

    function test_setHaltBand_takesAUsableValue() public {
        vm.prank(AUTHORITY);
        book.setHaltBand(0.07e18);
        assertEq(book.haltBandWad(), 0.07e18, "the halt band moved");
    }

    function test_setPlausibilityBand_isAuthorityOnlyAndRefusesUnusableBands() public {
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(PrintBookHarness.NotConfigurationAuthority.selector, STRANGER)
        );
        book.setPlausibilityBand(0.3e18);

        vm.prank(AUTHORITY);
        vm.expectRevert(abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, uint256(0)));
        book.setPlausibilityBand(0);

        vm.prank(AUTHORITY);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, Constants.WAD)
        );
        book.setPlausibilityBand(Constants.WAD);
    }

    function test_setPlausibilityBand_takesAUsableValue() public {
        vm.prank(AUTHORITY);
        book.setPlausibilityBand(0.3e18);
        assertEq(book.plausibilityBandWad(), 0.3e18, "the plausibility band moved");
    }

    function test_setFreshnessBounds_isAuthorityOnly() public {
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(PrintBookHarness.NotConfigurationAuthority.selector, STRANGER)
        );
        book.setFreshnessBounds(300, 7_200);
    }

    /// @dev The same contradiction the constructor refuses, reachable again after deployment.
    function test_setFreshnessBounds_refusesStalenessBelowFreshness() public {
        vm.prank(AUTHORITY);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.InvalidBand.selector, uint256(100))
        );
        book.setFreshnessBounds(600, 100);
    }

    function test_setFreshnessBounds_takesAnOrderedPair() public {
        vm.prank(AUTHORITY);
        book.setFreshnessBounds(300, 3_600);
        assertEq(book.freshnessBoundSeconds(), 300, "freshness moved");
        assertEq(book.staleBoundSeconds(), 3_600, "staleness moved");
    }

    /// @dev Equal bounds are allowed: a print is then either fresh-and-qualifying or not a
    ///      candidate, with no stale-but-qualifying band between them.
    function test_setFreshnessBounds_allowsEqualBounds() public {
        vm.prank(AUTHORITY);
        book.setFreshnessBounds(600, 600);
        assertEq(book.freshnessBoundSeconds(), 600, "freshness");
        assertEq(book.staleBoundSeconds(), 600, "staleness");
    }

    function test_setSequencerUptimeFeed_isAuthorityOnlyAndSetsBothValues() public {
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(PrintBookHarness.NotConfigurationAuthority.selector, STRANGER)
        );
        book.setSequencerUptimeFeed(FEED_A, 900);

        vm.prank(AUTHORITY);
        book.setSequencerUptimeFeed(FEED_A, 900);
        assertEq(book.sequencerUptimeFeed(), FEED_A, "feed recorded");
        assertEq(book.sequencerGraceSeconds(), 900, "grace recorded");
    }

    // ---------------------------------------------------------------- ingestion

    function test_submitPrint_refusesAnUnauthorisedCaller() public {
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.NotAuthorisedSource.selector, STRANGER)
        );
        book.submitPrint(STRANGER, 1, T_FRESH, 0.01e18);
    }

    function test_submitPrint_recordsThePrintAndItsIndex() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, T_FRESH, -0.012e18);

        assertEq(book.printCount(), 1, "one print");
        ReferencePrintBook.Print memory print = book.printAt(0);
        assertEq(print.source, FEED_A, "source");
        assertEq(print.priority, 1, "priority");
        assertEq(print.timestamp, T_FRESH, "timestamp");
        assertEq(print.gapWad, -0.012e18, "gap, signed and preserved");
        assertEq(print.insertionIndex, 0, "insertion index");
    }

    /// @dev The guards bound the *magnitude*, so a negative gap is guarded exactly as its positive
    ///      twin is. Testing only the positive direction would leave a sign-dependent hole open.
    function test_submitPrint_guardsTheMagnitudeOfANegativeGap() public {
        _authorise(FEED_A);
        vm.prank(FEED_A);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferencePrintBook.ImplausibleGap.selector, -0.4e18, PLAUSIBILITY_BAND
            )
        );
        book.submitPrint(FEED_A, 1, T_FRESH, -0.4e18);
    }

    /// @dev F31, pinned. The plausibility band (25%) is wider than the Tier-1 halt band (5%), and a
    ///      40% feed fault is outside both. Checking the halt band first would report a 40% fault as
    ///      a *halt*, naming the wrong defect to whoever has to act on it.
    function test_submitPrint_namesTheFaultNotTheHalt() public {
        _authorise(FEED_A);
        vm.prank(FEED_A);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReferencePrintBook.ImplausibleGap.selector, 0.4e18, PLAUSIBILITY_BAND
            )
        );
        book.submitPrint(FEED_A, 1, T_FRESH, 0.4e18);
    }

    /// @dev A gap inside plausibility but outside the halt band is a halt, and the two errors are
    ///      distinguishable. Together with the test above this pins the *order* of the two checks
    ///      rather than merely the existence of both.
    function test_submitPrint_reportsAHaltBetweenTheTwoBands() public {
        _authorise(FEED_A);
        vm.prank(FEED_A);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.HaltedGap.selector, 0.1e18, TIER1_BAND)
        );
        book.submitPrint(FEED_A, 1, T_FRESH, 0.1e18);
    }

    function test_submitPrint_acceptsAGapInsideBothBands() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, T_FRESH, 0.04e18);
        assertEq(book.printCount(), 1, "inside both bands");
    }

    /// @dev A print at exactly the halt band is accepted, because the guard is `>` not `>=`. The
    ///      boundary is the interesting value: it is the one a fuzzer finds and a reader assumes.
    function test_submitPrint_acceptsAGapExactlyAtTheHaltBand() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, T_FRESH, int256(TIER1_BAND));
        assertEq(book.printCount(), 1, "the band is inclusive");
    }

    // ---------------------------------------------------------------- the sequencer guard, G10b

    /// @dev A zero feed disables the guard, and that default is load-bearing: a registry deployed
    ///      before the guard existed settles exactly as it did before.
    function test_sequencerGuard_isDisabledWhenNoFeedIsSet() public view {
        assertEq(book.sequencerUptimeFeed(), address(0), "no feed configured");
        book.requireSequencerUp();
    }

    function test_sequencerGuard_refusesWhileTheSequencerIsDown() public {
        MockSequencerFeed feed = new MockSequencerFeed();
        feed.setUp(false, NOW);
        vm.prank(AUTHORITY);
        book.setSequencerUptimeFeed(address(feed), 900);

        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.SequencerDown.selector, uint256(0))
        );
        book.requireSequencerUp();
    }

    /// @dev Inside the grace window the guard still refuses, and it reports how long is left. The
    ///      grace period exists because a sequencer that has just come back has not yet produced the
    ///      prints the session settles on.
    function test_sequencerGuard_refusesInsideTheGraceWindowAndReportsTheRemainder() public {
        MockSequencerFeed feed = new MockSequencerFeed();
        feed.setUp(true, NOW - 300);
        vm.prank(AUTHORITY);
        book.setSequencerUptimeFeed(address(feed), 900);

        // lastUp + grace = NOW - 300 + 900 = NOW + 600, so 600 seconds remain.
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.SequencerDown.selector, uint256(600))
        );
        book.requireSequencerUp();
    }

    function test_sequencerGuard_allowsOnceTheGraceWindowHasPassed() public {
        MockSequencerFeed feed = new MockSequencerFeed();
        feed.setUp(true, NOW - 900);
        vm.prank(AUTHORITY);
        book.setSequencerUptimeFeed(address(feed), 900);

        book.requireSequencerUp();
    }

    /// @dev The guard is applied on the ingestion path too, so a print cannot enter the set while
    ///      the sequencer is down even though the book would otherwise accept it.
    function test_submitPrint_isRefusedWhileTheSequencerIsDown() public {
        MockSequencerFeed feed = new MockSequencerFeed();
        feed.setUp(false, NOW);
        vm.prank(AUTHORITY);
        book.setSequencerUptimeFeed(address(feed), 900);
        _authorise(FEED_A);

        vm.prank(FEED_A);
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.SequencerDown.selector, uint256(0))
        );
        book.submitPrint(FEED_A, 1, T_FRESH, 0.01e18);
        assertEq(book.printCount(), 0, "and nothing entered the set");
    }

    // ---------------------------------------------------------------- selection

    function test_selectPrint_revertsRatherThanReturningADefault() public {
        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.NoQualifyingPrint.selector, uint256(0), 0)
        );
        book.selectPrint(0, NOW);
    }

    /// @dev The non-reverting form reports the same absence as a boolean. It exists because the
    ///      settlement routes need to route an absent print to void-or-defer rather than to a fault.
    function test_trySelect_reportsAbsenceWithoutReverting() public view {
        (bool found, uint256 index, bool stale) = book.trySelect(0, NOW);
        assertFalse(found, "nothing found");
        assertEq(index, 0, "index is meaningless");
        assertFalse(stale, "and so is staleness");
    }

    function test_selectPrint_prefersTheLowerPriority() public {
        _authorise(FEED_A);
        _authorise(FEED_B);
        // Submitted first, but the higher priority number, so it must lose.
        _submit(FEED_B, 9, T_FRESH, 0.01e18);
        _submit(FEED_A, 1, T_FRESH, 0.02e18);

        (uint256 index,) = book.selectPrint(0, NOW);
        assertEq(book.printAt(index).source, FEED_A, "lower priority wins");
    }

    /// @dev Priority first, then recency: a better-priority print from long ago still beats a worse
    ///      one from just now.
    function test_selectPrint_prefersPriorityOverRecency() public {
        _authorise(FEED_A);
        _authorise(FEED_B);
        _submit(FEED_A, 1, T_STALE, 0.01e18);
        _submit(FEED_B, 2, T_FRESH, 0.02e18);

        (uint256 index,) = book.selectPrint(0, NOW);
        assertEq(book.printAt(index).source, FEED_A, "priority outranks recency");
    }

    /// @dev Within one priority, the later print is closer to the open the session settles on.
    function test_selectPrint_breaksAPriorityTieByRecency() public {
        _authorise(FEED_A);
        _authorise(FEED_B);
        _submit(FEED_A, 1, T_STALE, 0.01e18);
        _submit(FEED_B, 1, T_FRESH, 0.02e18);

        (uint256 index,) = book.selectPrint(0, NOW);
        assertEq(book.printAt(index).source, FEED_B, "the later print wins");
    }

    /// @dev Same priority and same timestamp: two prints from one source at one moment are the same
    ///      observation, so the rule is "first submitted" rather than a preference. `insertionIndex`
    ///      is what makes the ordering total rather than merely acyclic.
    function test_selectPrint_breaksARemainingTieByInsertionOrder() public {
        _authorise(FEED_A);
        _authorise(FEED_B);
        _submit(FEED_A, 1, T_FRESH, 0.01e18);
        _submit(FEED_B, 1, T_FRESH, 0.02e18);

        (uint256 index,) = book.selectPrint(0, NOW);
        assertEq(index, 0, "the first submitted wins");
        assertEq(book.printAt(index).source, FEED_A, "which is FEED_A");
    }

    /// @dev `notBefore` excludes by timestamp, not by insertion order.
    function test_selectPrint_respectsNotBefore() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, T_STALE, 0.01e18);

        vm.expectRevert(
            abi.encodeWithSelector(ReferencePrintBook.NoQualifyingPrint.selector, T_STALE + 1, 1)
        );
        book.selectPrint(T_STALE + 1, NOW);
    }

    /// @dev A print at exactly `notBefore` is a candidate: the bound is inclusive.
    function test_selectPrint_includesAPrintExactlyAtNotBefore() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, T_STALE, 0.01e18);

        (uint256 index,) = book.selectPrint(T_STALE, NOW);
        assertEq(index, 0, "the bound is inclusive");
    }

    function test_selectPrint_marksAPrintBeyondFreshnessAsStale() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, T_STALE, 0.01e18);

        (, bool stale) = book.selectPrint(0, NOW);
        assertTrue(stale, "past the freshness bound");
    }

    function test_selectPrint_doesNotMarkAFreshPrintAsStale() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, T_FRESH, 0.01e18);

        (, bool stale) = book.selectPrint(0, NOW);
        assertFalse(stale, "inside the freshness bound");
    }

    /// @dev A print beyond the staleness bound is not a candidate at all, even though it is in the
    ///      set. This is the difference between the two bounds: stale-but-usable versus unusable.
    function test_selectPrint_excludesAPrintBeyondStaleness() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, T_TOO_OLD, 0.01e18);

        (bool found,,) = book.trySelect(0, NOW);
        assertFalse(found, "beyond staleness is not a candidate");
    }

    /// @dev A print dated in the future is read as age zero rather than underflowing, so clock skew
    ///      defers it on the freshness bound instead of reverting the whole selection.
    function test_selectPrint_treatsAFutureDatedPrintAsAgeZero() public {
        _authorise(FEED_A);
        _submit(FEED_A, 1, uint64(NOW + 5_000), 0.01e18);

        (bool found, uint256 index, bool stale) = book.trySelect(0, NOW);
        assertTrue(found, "still a candidate");
        assertEq(index, 0, "selected");
        assertFalse(stale, "read as age zero, so not stale");
    }

    /// @dev Two prints, the older of which is beyond staleness. The newer must be selected rather
    ///      than the older one poisoning the set.
    function test_selectPrint_skipsTheUnusableAndTakesTheNext() public {
        _authorise(FEED_A);
        _authorise(FEED_B);
        _submit(FEED_A, 1, T_TOO_OLD, 0.01e18);
        _submit(FEED_B, 9, T_FRESH, 0.02e18);

        (uint256 index,) = book.selectPrint(0, NOW);
        assertEq(book.printAt(index).source, FEED_B, "the only usable print");
    }

    // ---------------------------------------------------------------- helpers

    function _authorise(address source) private {
        vm.prank(AUTHORITY);
        book.setAuthorisedSource(source, true);
    }

    /// @dev The caller *is* the source, because `submitPrint` authorises on `msg.sender` while
    ///      recording `source` separately for the audit trail.
    function _submit(address source, uint64 priority, uint256 timestamp, int256 gapWad) private {
        vm.prank(source);
        book.submitPrint(source, priority, uint64(timestamp), gapWad);
    }
}
