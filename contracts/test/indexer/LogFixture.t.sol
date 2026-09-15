// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {Session} from "../../src/core/Session.sol";
import {SessionFactory} from "../../src/core/SessionFactory.sol";
import {ReferenceRegistry} from "../../src/core/ReferenceRegistry.sol";
import {PremiumRegistry} from "../../src/pricing/PremiumRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockReferenceToken} from "../mocks/MockProbes.sol";

/// @title LogFixture
/// @notice Emits `spec/fixtures/logs.json`: the raw logs a real session lifecycle produces.
/// @dev **The indexer's oracle.** The indexer decodes and folds event logs, and a decoder verified
///      against logs the indexer's own encoder produced proves nothing — the two would agree while
///      both being wrong about the wire format. This test runs the contracts and captures what they
///      actually emitted, so the fixture comes from the producer rather than from the consumer.
///
///      The capture is `vm.getRecordedLogsJson()`, which returns forge's own rendering of
///      `Vm.Log[]` as `[{"topics": [...], "data": "0x..", "emitter": "0x.."}]`. Two properties of
///      that rendering are load-bearing for the decoder and were observed rather than assumed:
///      `topics` and `data` are lower-case hex while `emitter` is EIP-55 checksummed, so address
///      comparison has to be case-insensitive; and calling `getRecordedLogsJson` drains the buffer,
///      so `getRecordedLogs` afterwards returns an empty array.
///
///      **The lifecycle is run inside the recorded region on purpose.** It emits `Transfer` logs
///      from the collateral and from the two claim tokens, which a real indexer watching a session
///      sees as well. The fixture therefore contains events the indexer must ignore, and the
///      "unknown topic0 is skipped" path is exercised by the fixture rather than only by a unit
///      test written to exercise it.
///
///      **Staleness is a failure, and the rewrite is opt-in.** The fixture is compared against the
///      committed bytes and a mismatch fails the test. Regeneration is `BELL_WRITE_FIXTURES=1`, which
///      is the same `--check`/write split the three Node generators use, expressed as an environment
///      variable because the producer here is Solidity rather than a tool that can take a flag.
///
///      **The write is opt-in rather than write-then-revert, and that is a fix rather than a
///      preference.** The earlier form rewrote the file *before* reverting, so any run that failed
///      left a modified fixture behind -- including `forge coverage`, whose instrumentation changes
///      `Session`'s creation code, and therefore the CREATE2 address `SessionFactory` derives for it,
///      and therefore every session and claim-token address in the corpus. A coverage run is a
///      different build, and a fixture that records an address derived from bytecode cannot be
///      byte-stable across two builds. See DESIGN_NOTES.md F95. With the write behind a flag, an
///      unintended run can only fail, never corrupt.
contract LogFixtureTest is Test {
    /// @dev Six decimals, matching USDG: the unit is 1e6, so "one dollar" is `1e6`.
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant LAM = 15e18;
    uint256 internal constant NOTIONAL_CAP = 5_000_000 * UNIT;
    uint256 internal constant TIER1_BAND = 0.05e18;
    uint256 internal constant PLAUSIBILITY_BAND = 0.25e18;
    uint256 internal constant FRESHNESS = 600;
    uint256 internal constant STALE_BOUND = 7_200;

    bytes32 internal constant NAME_ID = keccak256("NVDA");
    bytes32 internal constant INPUTS_HASH = keccak256("NVDA/E/504/canonical-rows");
    uint256 internal constant LAMBDA = 15e18;
    uint256 internal constant PREMIUM = 0.174e18;

    address internal constant REPORTER = address(0x5EED);
    address internal constant AUTHORITY = address(0xA17);
    address internal constant ARBITER = address(0xA1B);
    address internal publisher = address(0x9B1);
    address internal challenger = address(0xC4A);

    /// @dev Relative to `contracts/`, which is the working directory forge runs in.
    string internal constant FIXTURE = "../spec/fixtures/logs.json";

    /// @dev Carries the remedy, because a bare `LogFixtureStale()` names the symptom and not the
    ///      command, and the command is the only thing the reader needs.
    error LogFixtureStale(string regenerateWith);

    MockERC20 internal collateral;
    MockReferenceToken internal referenceToken;
    ReferenceRegistry internal registry;
    PremiumRegistry internal premium;
    SessionFactory internal factory;
    /// @dev Deployed by the factory inside the lifecycle, so the test can only see it as state.
    Session internal session;

    function setUp() public {
        vm.warp(1_800_000_000);

        collateral = new MockERC20("USD Global", "USDG", 6);
        referenceToken = new MockReferenceToken(1e18);

        registry =
            new ReferenceRegistry(AUTHORITY, PLAUSIBILITY_BAND, TIER1_BAND, FRESHNESS, STALE_BOUND);
        premium = new PremiumRegistry(
            IERC20(address(collateral)),
            ARBITER,
            AUTHORITY,
            Constants.MIN_PUBLISHER_BOND,
            Constants.CHALLENGER_BOND,
            Constants.STALENESS_SESSIONS,
            Constants.BOND_LOCK_SESSIONS
        );
        factory = new SessionFactory(IERC20(address(collateral)), address(registry));

        vm.prank(AUTHORITY);
        registry.setAuthorisedSource(REPORTER, true);

        vm.prank(publisher);
        collateral.approve(address(premium), type(uint256).max);
        vm.prank(challenger);
        collateral.approve(address(premium), type(uint256).max);
    }

    /// @notice Emit the fixture, or fail if the committed one is stale.
    /// @dev The settling assertion runs before the comparison, so a lifecycle that stops settling
    ///      reports that rather than reporting a byte difference whose cause it cannot name.
    function test_theLogFixtureIsCurrent() public {
        vm.recordLogs();
        _runLifecycle();
        string memory fixture = _render(vm.getRecordedLogsJson());

        assertEq(
            uint256(session.state()), uint256(Session.State.Settled), "the session did not settle"
        );

        if (vm.envOr("BELL_WRITE_FIXTURES", false)) {
            vm.writeFile(FIXTURE, fixture);
            return;
        }

        string memory committed = vm.exists(FIXTURE) ? vm.readFile(FIXTURE) : "";
        if (keccak256(bytes(committed)) != keccak256(bytes(fixture))) {
            revert LogFixtureStale("BELL_WRITE_FIXTURES=1 forge test --match-path test/indexer/LogFixture.t.sol");
        }
    }

    // ---------------------------------------------------------------- the lifecycle

    /// @dev Every event the indexer's taxonomy claims, in the order a real session produces them,
    ///      plus the ERC-20 traffic that comes with it.
    function _runLifecycle() internal {
        // Funding: collateral `Transfer`s, which the indexer must ignore.
        collateral.mint(address(this), 10_000_000 * UNIT);
        collateral.mint(publisher, Constants.MIN_PUBLISHER_BOND * 2);
        collateral.mint(challenger, Constants.CHALLENGER_BOND * 2);

        // 1. SessionCreated, and the factory's SessionRegistered.
        uint256 expiry = block.timestamp + 17.5 hours;
        address sessionAddress =
            factory.createSession(address(referenceToken), LAM, expiry, NOTIONAL_CAP, 0);
        session = Session(sessionAddress);

        // The factory deploys the session and hands it the registry, but does **not** register it
        // with that registry: `registerSession` is permissionless and nothing calls it internally,
        // so a created session is unsettleable until somebody sends this transaction. Recorded as
        // DESIGN_NOTES.md F93; the fixture performs it because a real lifecycle has to.
        registry.registerSession(sessionAddress, address(referenceToken));

        // The session is deployed by the factory, so its address is only known now -- and it is the
        // session, not the factory, that pulls collateral and claims.
        collateral.approve(sessionAddress, type(uint256).max);

        // 2. PoolSeeded, plus the claim tokens' Transfer logs from minting the pair. The pool takes
        //    *claims*, not collateral, so the seeder mints a pair and approves both legs first --
        //    the mintPair/approveClaims/seedPool sequence a UI has to batch.
        session.mintPair(1_200_000 * UNIT);
        session.longClaim().approve(sessionAddress, type(uint256).max);
        session.shortClaim().approve(sessionAddress, type(uint256).max);
        session.seedPool(1_000_000 * UNIT, 200_000 * UNIT);

        // 3. Traded.
        session.buyLong(50_000 * UNIT, 0);

        // 4. Committed.
        vm.prank(publisher);
        premium.commit(NAME_ID, 1, LAMBDA, PREMIUM, INPUTS_HASH);

        // 5. Challenged.
        vm.prank(challenger);
        premium.challenge(NAME_ID, 1);

        // 6. Resolved -- PremiumStore's, which is not the same event as the registry's below.
        vm.prank(ARBITER);
        premium.resolve(NAME_ID, 1, true);

        // 7. The close, the reference print, then the session's Settled and the registry's Resolved.
        //
        // The print is submitted *after* the warp, and the order is load-bearing rather than
        // incidental. `ReferencePrintBook._trySelect` skips every candidate whose `timestamp` is
        // below `notBefore` -- the session's expiry -- so a print taken before the close can never
        // be the reference print however fresh it is. It also skips every candidate older than
        // `staleBoundSeconds` at the moment of selection. A print submitted before the close is
        // therefore disqualified twice over, `_selectOrDefer` reports absence, and the session lands
        // on `Deferred`: `settle` is not called and no `Settled` is emitted.
        //
        // This fixture was written the other way round first, and it produced a log corpus that
        // looked complete while containing no `Settled` at all -- while the provenance note below
        // asserted one. The note was a claim that nothing checked. See DESIGN_NOTES.md F94.
        vm.warp(expiry + 1);
        vm.prank(REPORTER);
        registry.submitPrint(REPORTER, 1, uint64(block.timestamp), 0.02e18);
        registry.resolve(sessionAddress);
    }

    // ---------------------------------------------------------------- rendering

    /// @dev The provenance header, then forge's array verbatim. The logs are not re-rendered: a
    ///      fixture this test had reshaped would be a place for the consumer's assumptions to enter
    ///      the producer's output.
    function _render(string memory logsJson) internal pure returns (string memory) {
        return string.concat(
            "{\n",
            '  "_generated": "GENERATED FILE - DO NOT EDIT BY HAND.",\n',
            '  "_source": "contracts/test/indexer/LogFixture.t.sol, via vm.getRecordedLogsJson()",\n',
            '  "_note": "Raw logs in emission order from a full session lifecycle: SessionCreated, ',
            "SessionRegistered, PoolSeeded, PoolSharesMinted, Traded, Committed, Challenged, ",
            "PremiumStore.Resolved, PrintSubmitted, Settled and ReferenceRegistry.Resolved. Also ",
            "carries the collateral and claim-token Transfers and Approvals that come with it, which ",
            "an indexer must ignore. topics and data are lower-case hex; emitter is EIP-55 ",
            "checksummed. Regenerate with BELL_WRITE_FIXTURES=1 and the LogFixture test; ",
            '`make check-generated` fails if this file is stale.",\n',
            '  "logs": ',
            logsJson,
            "\n}\n"
        );
    }
}
