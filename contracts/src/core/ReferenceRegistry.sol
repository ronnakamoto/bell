// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Constants} from "../generated/Constants.sol";
import {Branch} from "../types/Branch.sol";
import {Payoff} from "../libraries/Payoff.sol";
import {Session} from "./Session.sol";
import {ReferencePrintBook} from "./ReferencePrintBook.sol";
import {IIssuerPauseOracle, IMultiplierToken} from "../interfaces/ExternalProbes.sol";

/// @title ReferenceRegistry
/// @notice Registers sessions, selects the settlement print, and fixes the payoff.
/// @dev The session does not evaluate its own payoff. This contract selects the print and computes
///      the payoff, and the split is deliberate: it keeps the settlement procedure -- the protocol's
///      entire residual risk -- in one auditable place rather than spread across the contracts that
///      depend on its output.
///
///      Four of the five guards live here. G3 (the Tier-1 halt band) and the plausibility check are
///      applied at ingestion by `ReferencePrintBook`; G10b (sequencer uptime) is applied both there
///      and here; G10 (issuer pause) and G8 (multiplier drift) are applied here, because both are
///      properties of the moment of settlement rather than of the moment of submission. G9
///      (collateral decimals) is asserted in the session's constructor.
contract ReferenceRegistry is ReferencePrintBook {
    /// @notice What the registry recorded about a session at registration.
    /// @dev The multiplier is recorded at registration and compared at resolution, which is what
    ///      turns a corporate action from a silent mispricing into a branch.
    struct SessionRecord {
        address referenceToken;
        uint256 lamWad;
        uint256 expiryTimestamp;
        uint256 multiplierAtRegistration;
        bool resolved;
    }

    /// @dev Thrown when a caller without configuration authority attempts a configuration change.
    error NotConfigurationAuthority(address caller);
    /// @dev Thrown when a session is registered twice.
    error AlreadyRegistered(address session);
    /// @dev Thrown when a session has not been registered.
    error NotRegistered(address session);
    /// @dev Thrown when a session is resolved twice.
    error AlreadyResolved(address session);
    /// @dev Thrown when resolution is attempted before the session's expiry.
    error NotYetExpired(uint256 expiry, uint256 nowTimestamp);
    /// @dev Thrown when the issuer has paused a reference token that is being checked, guard G10.
    error ReferencePaused(address referenceToken);
    /// @dev Thrown when the reference token reports a zero multiplier, which would make the adjusted
    ///      gap undefined.
    error ZeroMultiplier(address referenceToken);
    /// @dev Thrown by the branch switch if it is ever reached with a member it does not handle. It is
    ///      unreachable while the chain below covers every member of `Branch`, and it exists so that
    ///      an added member is a failing test rather than a silent fall-through.
    error UnreachableBranch(Branch branch);

    /// @dev Emitted when a session is registered, with the multiplier it will be judged against.
    event SessionRegistered(
        address indexed session, address indexed referenceToken, uint256 lamWad, uint256 multiplier
    );
    /// @dev Emitted on every resolution, with the branch, so the settlement decision is auditable.
    event Resolved(address indexed session, Branch branch, int256 gapWad, uint256 payoffWad);
    /// @dev Emitted when a token is added to or removed from the pause-check registry, guard G10.
    event PauseCheckedChanged(address indexed referenceToken, bool checked);

    /// @notice The address permitted to configure the registry.
    address public immutable configurationAuthority;

    /// @dev Slot layout, continuing the print book's: the bands and bounds occupy the first words,
    ///      then the feed and grace period, then `authorisedSource` and `_prints` take their own
    ///      slots, then `voidAtHalf`, `configurationAuthority` (immutable, so no slot), `_sessions`
    ///      and `pauseChecked`.
    /// @notice Whether an unprintable session voids at half (route R1) rather than deferring (R2).
    /// @dev Defaults to false, which is route R2 -- the architecture the paper recommends. R1 must
    ///      never ship: voiding at half writes a free long butterfly struck at `c/2` to the
    ///      protocol's own hedgers, worth 29.7 bp of notional per session and 14.3% of the premium
    ///      paid, while deferring removes it exactly at a cost of 0.021 bp. The flag exists so the
    ///      comparison is reproducible, not so that R1 can be turned on.
    bool public voidAtHalf;

    mapping(address session => SessionRecord) internal _sessions;
    /// @notice Tokens whose issuer pause flag is read at settlement, guard G10.
    /// @dev Opt-in per token, and the opt-in is the guard's whole safety property. A registry that
    ///      probed every reference would execute the fallback of any contract that has one, which is
    ///      how the paper's first implementation took two passing settlement scenarios red against
    ///      the real chain. An unregistered reference is never probed and settles exactly as it did
    ///      before the guard existed.
    mapping(address referenceToken => bool) public pauseChecked;

    constructor(
        address configurationAuthority_,
        uint256 plausibilityBandWad,
        uint256 haltBandWad,
        uint256 freshnessBoundSeconds,
        uint256 staleBoundSeconds
    )
        ReferencePrintBook(
            plausibilityBandWad, haltBandWad, freshnessBoundSeconds, staleBoundSeconds
        )
    {
        if (configurationAuthority_ == address(0)) revert ZeroAddress();
        configurationAuthority = configurationAuthority_;
    }

    // ---------------------------------------------------------------- registration

    /// @notice Register a session and record the multiplier it will be judged against.
    /// @return expiryTimestamp the session's expiry, read from the session.
    /// @return lamWad the session's leverage, read from the session.
    /// @dev The multiplier is read here rather than passed in, so that the value the session is
    ///      judged against is the value the token actually reported at registration and not a value
    ///      a caller supplied. `SessionFactory.createSession` calls this after deploy (F93); the
    ///      function stays permissionless so a session created outside the factory can still be
    ///      registered, and so the duplicate path remains a named, testable error.
    function registerSession(address session, address referenceToken)
        external
        returns (uint256 expiryTimestamp, uint256 lamWad)
    {
        if (_sessions[session].referenceToken != address(0)) {
            revert AlreadyRegistered(session);
        }
        Session target = Session(session);
        expiryTimestamp = target.expiryTimestamp();
        lamWad = target.lamWad();

        uint256 multiplier = _readMultiplier(referenceToken);
        _sessions[session] = SessionRecord({
            referenceToken: referenceToken,
            lamWad: lamWad,
            expiryTimestamp: expiryTimestamp,
            multiplierAtRegistration: multiplier,
            resolved: false
        });
        emit SessionRegistered(session, referenceToken, lamWad, multiplier);
    }

    /// @notice Add or remove a reference token from the pause-check registry, guard G10.
    function setPauseChecked(address referenceToken, bool checked) external {
        _requireConfigurationAuthority();
        if (referenceToken == address(0)) revert ZeroAddress();
        pauseChecked[referenceToken] = checked;
        emit PauseCheckedChanged(referenceToken, checked);
    }

    /// @notice Enable or disable the void-at-half route. See `voidAtHalf`.
    function setVoidAtHalf(bool enabled) external {
        _requireConfigurationAuthority();
        voidAtHalf = enabled;
    }

    /// @notice Whether a session has been resolved.
    function sessionResolved(address session) external view returns (bool) {
        return _sessions[session].resolved;
    }

    /// @notice What the registry recorded about a session.
    function sessionRecord(address session) external view returns (SessionRecord memory) {
        return _sessions[session];
    }

    // ---------------------------------------------------------------- resolution

    /// @notice Evaluate a session's settlement and, if it settles, fix its payoff.
    /// @return payoffWad the long leg's payoff at WAD scale.
    /// @return branch which of the five resolution branches was taken.
    /// @dev The order of the checks is the order of their precedence, and it matters. The sequencer
    ///      guard is first because resolving against a chain whose head is not yet determined is
    ///      resolving against a reordering. The pause guard is second because a paused feed's value
    ///      is advisory and may be frozen without being obviously stale. Multiplier drift is third
    ///      because it changes which *gap* is being settled, not merely which print. Print selection
    ///      is last, because everything before it decides whether the print set is admissible at all.
    function resolve(address session) external returns (uint256 payoffWad, Branch branch) {
        SessionRecord storage record = _sessions[session];
        if (record.referenceToken == address(0)) revert NotRegistered(session);
        if (record.resolved) revert AlreadyResolved(session);
        if (block.timestamp < record.expiryTimestamp) {
            revert NotYetExpired(record.expiryTimestamp, block.timestamp);
        }

        _requireSequencerUp();
        _requireIssuerNotPaused(record.referenceToken);

        // Advance the session out of `Open` if nobody has. `expire` is permissionless and carries no
        // discretion -- it is a function of the clock -- so the registry calling it adds no authority
        // and removes a liveness dependency: a session would otherwise be unsettleable until some
        // third party spent the gas.
        Session target = Session(session);
        if (target.state() == Session.State.Open) target.expire();

        int256 gapWad;
        uint256 printIndex;
        bool stale;

        if (_multiplierDrifted(record)) {
            branch = Branch.CorporateActionTerminal;
            (printIndex, stale) = _selectOrDefer(record);
            if (printIndex == type(uint256).max) {
                // A corporate action with no usable print is still an absent print, and the route
                // answers for it the same way it does on the live path: void at half, or defer.
                //
                // This branch was missing, and its absence was not a missing degradation but a
                // panic. `_selectOrDefer` returns `type(uint256).max` as its sentinel, so the
                // unguarded `_prints[printIndex]` was an out-of-bounds access that reverted with
                // `0x32` and named nothing -- and because the drift persists, every retry panicked
                // identically and the session was permanently unsettleable. It also made `preview`
                // actively misleading, since `preview` *did* handle this case and reported a
                // deferral for a call that would panic.
                branch = voidAtHalf ? Branch.VoidAtHalf : Branch.Deferred;
                gapWad = 0;
            } else {
                gapWad = _adjustedGap(_prints[printIndex].gapWad, record);
            }
        } else {
            (printIndex, stale) = _selectOrDefer(record);
            if (printIndex == type(uint256).max) {
                // No print qualifies. The route decides whether that is a void or a deferral, and
                // the two are not equivalent: voiding pays half to every holder, deferring pays
                // nothing until a print arrives.
                branch = voidAtHalf ? Branch.VoidAtHalf : Branch.Deferred;
                gapWad = 0;
            } else {
                branch = stale ? Branch.StalePrint : Branch.LivePrint;
                gapWad = _prints[printIndex].gapWad;
            }
        }

        payoffWad = _payoffForBranch(branch, record.lamWad, gapWad);
        if (branch != Branch.Deferred) {
            record.resolved = true;
            Session(session).settle(payoffWad, stale || branch == Branch.StalePrint);
        }
        emit Resolved(session, branch, gapWad, payoffWad);
    }

    /// @notice Evaluate a session without changing any state.
    /// @return payoffWad the payoff the resolution would fix.
    /// @return branch the branch it would take.
    /// @return wouldSettle whether the session would be settled, i.e. whether the branch is not a
    ///         deferral.
    /// @dev The three return values are exactly what a caller needs to decide whether to spend gas on
    ///      `resolve`, and they are derived from the same code path rather than a parallel one.
    function preview(address session)
        external
        view
        returns (uint256 payoffWad, Branch branch, bool wouldSettle)
    {
        SessionRecord storage record = _sessions[session];
        if (record.referenceToken == address(0)) revert NotRegistered(session);
        if (record.resolved) revert AlreadyResolved(session);
        if (block.timestamp < record.expiryTimestamp) {
            revert NotYetExpired(record.expiryTimestamp, block.timestamp);
        }
        _requireSequencerUp();
        _requireIssuerNotPaused(record.referenceToken);

        int256 gapWad;
        if (_multiplierDrifted(record)) {
            branch = Branch.CorporateActionTerminal;
            (uint256 index,) = _selectOrDefer(record);
            if (index == type(uint256).max) {
                branch = voidAtHalf ? Branch.VoidAtHalf : Branch.Deferred;
            } else {
                gapWad = _adjustedGap(_prints[index].gapWad, record);
            }
        } else {
            (uint256 index, bool stale) = _selectOrDefer(record);
            if (index == type(uint256).max) {
                branch = voidAtHalf ? Branch.VoidAtHalf : Branch.Deferred;
            } else {
                branch = stale ? Branch.StalePrint : Branch.LivePrint;
                gapWad = _prints[index].gapWad;
            }
        }
        payoffWad = _payoffForBranch(branch, record.lamWad, gapWad);
        wouldSettle = branch != Branch.Deferred;
    }

    // ---------------------------------------------------------------- branches

    /// @dev Every member of `Branch` is handled explicitly and there is no `default` fall-through, so
    ///      a member added to the enum is a failing test rather than a silent default. The final
    ///      revert is unreachable while the chain covers the enum; the test
    ///      `test_everyBranchIsHandled` walks every member and fails if it is reached.
    ///
    ///      `Deferred` returns zero and is never settled on: the caller checks the branch before
    ///      calling `settle`, because a deferral is the absence of a decision rather than a decision
    ///      that the payoff is zero. Returning zero and settling on it would be the exact fail-open
    ///      the brief forbids -- a free claim minted by an absent print.
    function _payoffForBranch(Branch branch, uint256 lamWad, int256 gapWad)
        internal
        pure
        returns (uint256)
    {
        if (branch == Branch.LivePrint) return Payoff.longWad(lamWad, gapWad);
        if (branch == Branch.StalePrint) return Payoff.longWad(lamWad, gapWad);
        if (branch == Branch.CorporateActionTerminal) return Payoff.longWad(lamWad, gapWad);
        if (branch == Branch.VoidAtHalf) return Constants.WAD / 2;
        if (branch == Branch.Deferred) return 0;
        revert UnreachableBranch(branch);
    }

    // ---------------------------------------------------------------- guards

    /// @dev Guard G10, applied only to tokens in the registry. See `pauseChecked`.
    function _requireIssuerNotPaused(address referenceToken) internal view {
        if (!pauseChecked[referenceToken]) return;
        if (IIssuerPauseOracle(referenceToken).paused()) {
            revert ReferencePaused(referenceToken);
        }
    }

    /// @dev Guard G8. A change is any difference at all, because the multiplier is an exact quantity
    ///      rather than a measurement: a split or an ex-date moves it by a stated ratio, and a
    ///      difference of one wei is a corporate action rather than noise.
    function _multiplierDrifted(SessionRecord storage record) internal view returns (bool) {
        return _readMultiplier(record.referenceToken) != record.multiplierAtRegistration;
    }

    /// @dev The ex-date adjustment: `(1 + G) * m_at_registration / m_now - 1`.
    ///
    ///      On an ex-date the headline return is not a market move. It contains the distribution, and
    ///      the multiplier moves by the same factor, so dividing the gross return by the multiplier's
    ///      movement removes the distribution and leaves the market gap. Paying on the headline would
    ///      record a spurious gap on every ex-date -- roughly quarterly per name -- and route it
    ///      through the live branch, which is what guard G8 exists to prevent.
    ///
    ///      The paper reports a specific before-and-after for this guard (3.800e17 WAD on the live
    ///      branch, 3.422e17 on the terminal branch). Those two numbers are not reproducible from its
    ///      description of the mechanism: a full adjustment removes the spurious gap *entirely* and
    ///      pays zero, because the headline gap and the distribution are the same quantity. See
    ///      DESIGN_NOTES.md F29.
    function _adjustedGap(int256 gapWad, SessionRecord storage record)
        private
        view
        returns (int256)
    {
        int256 gross = int256(Constants.WAD) + gapWad;
        uint256 multiplierNow = _readMultiplier(record.referenceToken);
        uint256 adjusted = (uint256(gross) * record.multiplierAtRegistration) / multiplierNow;
        return int256(adjusted) - int256(Constants.WAD);
    }

    /// @dev Reads a token's multiplier, refusing a zero rather than dividing by it.
    function _readMultiplier(address referenceToken) private view returns (uint256) {
        uint256 multiplier = IMultiplierToken(referenceToken).multiplier();
        if (multiplier == 0) revert ZeroMultiplier(referenceToken);
        return multiplier;
    }

    /// @dev Selection that reports absence as a sentinel rather than reverting, so the caller can
    ///      route an absent print to void-or-defer instead of to a failure.
    function _selectOrDefer(SessionRecord storage record)
        private
        view
        returns (uint256 index, bool stale)
    {
        bool found;
        (found, index, stale) = _trySelect(record.expiryTimestamp, block.timestamp);
        if (!found) return (type(uint256).max, false);
    }

    /// @dev The registry is the configuration authority for the print book's bands.
    function _requireConfigurationAuthority() internal view override {
        if (msg.sender != configurationAuthority) {
            revert NotConfigurationAuthority(msg.sender);
        }
    }
}
