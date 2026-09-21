// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Constants} from "../generated/Constants.sol";
import {WadMath} from "../libraries/WadMath.sol";
import {ISequencerUptimeFeed} from "../interfaces/ExternalProbes.sol";

/// @title ReferencePrintBook
/// @notice The submitted prints, the ingestion guards, and the deterministic selection.
/// @dev One print set, not one per reference token, because the brief's `submitPrint` signature
///      carries no token: `submitPrint(source, priority, timestamp, gapWad)`. The consequence is that
///      a registry instance serves exactly one reference token, and the deployment script must deploy
///      one per token. Recorded as F28 in DESIGN_NOTES.md.
///
///      Selection is deterministic and **total**. Given a set of candidates it returns exactly one,
///      by a documented ordering, and when no candidate qualifies it reverts with a specific error
///      rather than returning a default. That is the fail-closed rule: a settlement path that
///      received a zero from an ambiguous selector would price a free claim.
abstract contract ReferencePrintBook {
    /// @notice One reported observation of the session's gap.
    /// @dev `priority` is the source's own claim, which is consistent with the trust model: the feed
    ///      is trusted for *reporting prints that occurred* and for nothing else, and the ordering
    ///      only decides between prints that already passed every guard.
    struct Print {
        address source;
        uint64 priority;
        uint64 timestamp;
        int256 gapWad;
        uint64 insertionIndex;
    }

    /// @dev Thrown when a gap is beyond the plausibility band, i.e. it is a feed fault.
    error ImplausibleGap(int256 gapWad, uint256 bandWad);
    /// @dev Thrown when a gap is beyond the Tier-1 halt band, i.e. it indicates a trading halt.
    error HaltedGap(int256 gapWad, uint256 bandWad);
    /// @dev Thrown when the print book is full. The settlement scan is O(prints), so the cap is
    ///      the DoS guard: without it an authorised source could grow the book without bound and
    ///      push a settlement's scan past the block gas limit.
    error PrintBookFull(uint256 printCount, uint256 maxPrints);
    /// @dev Thrown when the L2 sequencer is down, or within the grace period after it returned.
    error SequencerDown(uint256 graceRemainingSeconds);
    /// @dev Thrown when no print qualifies for a settlement, and the caller expected one.
    error NoQualifyingPrint(uint256 notBefore, uint256 printCount);
    /// @dev Thrown when an unauthorised address submits a print.
    error NotAuthorisedSource(address caller);
    /// @dev Thrown when a required address is zero.
    error ZeroAddress();
    /// @dev Thrown when a configured band is not a usable value.
    error InvalidBand(uint256 bandWad);

    /// @dev Emitted on every accepted print, so the print set is reconstructible from logs.
    event PrintSubmitted(
        address indexed source, uint64 priority, uint64 timestamp, int256 gapWad, uint256 index
    );
    /// @dev Emitted when a source's permission changes.
    event SourceAuthorisationChanged(address indexed source, bool authorised);

    /// @notice The outer band, beyond which a gap is treated as a feed fault.
    /// @dev Loose on purpose: this is a data-integrity check, not a market-structure one. The paper's
    ///      check F5 refuses +40% and -90% at ingestion and admits the rest.
    uint256 public plausibilityBandWad;
    /// @notice The Tier-1 halt band, beyond which a gap indicates a trading halt.
    /// @dev Configurable, with the Tier-1 setting at 5%. The 25% default is the design's legacy value
    ///      and is wrong for this universe: correcting it to 5% makes the fallback fire roughly twice
    ///      as often, which is the direction that flatters no one (paper §9.5).
    uint256 public haltBandWad;
    /// @notice The age beyond which a print is stale rather than live.
    uint256 public freshnessBoundSeconds;
    /// @notice The age beyond which a print does not qualify at all.
    uint256 public staleBoundSeconds;
    /// @notice The sequencer uptime feed, guard G10b. Zero disables the guard.
    address public sequencerUptimeFeed;
    /// @notice The window after sequencer recovery during which settlement is still refused.
    uint256 public sequencerGraceSeconds;

    /// @dev Slot layout: bands and bounds pack into three words; the feed and grace into two more.
    ///      `authorisedSource` and `_prints` are mappings and an array, so they take their own slots.
    mapping(address source => bool) public authorisedSource;
    Print[] internal _prints;

    /// @dev Guards against a misconfigured band. A band of zero would reject every print including a
    ///      zero gap, and a band at or above one would reject nothing -- both are silent failures in
    ///      opposite directions, so neither is accepted.
    modifier bandIsUsable(uint256 bandWad) {
        if (bandWad == 0 || bandWad >= Constants.WAD) revert InvalidBand(bandWad);
        _;
    }

    constructor(
        uint256 plausibilityBandWad_,
        uint256 haltBandWad_,
        uint256 freshnessBoundSeconds_,
        uint256 staleBoundSeconds_
    ) {
        if (plausibilityBandWad_ == 0 || plausibilityBandWad_ >= Constants.WAD) {
            revert InvalidBand(plausibilityBandWad_);
        }
        if (haltBandWad_ == 0 || haltBandWad_ >= Constants.WAD) revert InvalidBand(haltBandWad_);
        if (staleBoundSeconds_ < freshnessBoundSeconds_) revert InvalidBand(staleBoundSeconds_);
        plausibilityBandWad = plausibilityBandWad_;
        haltBandWad = haltBandWad_;
        freshnessBoundSeconds = freshnessBoundSeconds_;
        staleBoundSeconds = staleBoundSeconds_;
    }

    // ---------------------------------------------------------------- configuration

    /// @notice Authorise or revoke a print source.
    /// @dev Access control the brief does not mention and the design cannot do without: the guards
    ///      bound a print's *magnitude*, so without authorisation any address could inject a
    ///      plausible but false print and steer settlement to a payoff of its choosing.
    function setAuthorisedSource(address source, bool authorised) external {
        _requireConfigurationAuthority();
        if (source == address(0)) revert ZeroAddress();
        authorisedSource[source] = authorised;
        emit SourceAuthorisationChanged(source, authorised);
    }

    /// @notice Set the sequencer uptime feed, or disable the guard by passing zero.
    function setSequencerUptimeFeed(address feed, uint256 graceSeconds) external {
        _requireConfigurationAuthority();
        sequencerUptimeFeed = feed;
        sequencerGraceSeconds = graceSeconds;
    }

    /// @notice Set the Tier-1 halt band.
    function setHaltBand(uint256 bandWad) external bandIsUsable(bandWad) {
        _requireConfigurationAuthority();
        haltBandWad = bandWad;
    }

    /// @notice Set the plausibility band.
    function setPlausibilityBand(uint256 bandWad) external bandIsUsable(bandWad) {
        _requireConfigurationAuthority();
        plausibilityBandWad = bandWad;
    }

    /// @notice Set the freshness and staleness bounds.
    function setFreshnessBounds(uint256 freshSeconds, uint256 staleSeconds) external {
        _requireConfigurationAuthority();
        if (staleSeconds < freshSeconds) revert InvalidBand(staleSeconds);
        freshnessBoundSeconds = freshSeconds;
        staleBoundSeconds = staleSeconds;
    }

    // ---------------------------------------------------------------- ingestion

    /// @notice Submit a print for the session's gap.
    /// @param source the feed the print came from, recorded for the audit trail.
    /// @param priority the source's own ordering claim; lower wins.
    /// @param timestamp the moment the print was observed.
    /// @param gapWad the gap, signed, at WAD scale.
    /// @dev Both magnitude guards are applied here rather than at settlement, because a print that
    ///      enters the set is a print that can be selected. The plausibility band is checked first so
    ///      that a gross feed fault is reported as a fault rather than as a halt -- with the Tier-1
    ///      band at 5% the halt check would otherwise catch a 40% fault and name it wrongly.
    function submitPrint(address source, uint64 priority, uint64 timestamp, int256 gapWad)
        external
    {
        if (!authorisedSource[msg.sender]) revert NotAuthorisedSource(msg.sender);
        _requireSequencerUp();

        uint256 magnitude = _magnitude(gapWad);
        if (magnitude > plausibilityBandWad) revert ImplausibleGap(gapWad, plausibilityBandWad);
        if (magnitude > haltBandWad) revert HaltedGap(gapWad, haltBandWad);
        if (_prints.length >= Constants.MAX_PRINTS) {
            revert PrintBookFull(_prints.length, Constants.MAX_PRINTS);
        }

        _prints.push(
            Print({
                source: source,
                priority: priority,
                timestamp: timestamp,
                gapWad: gapWad,
                insertionIndex: uint64(_prints.length)
            })
        );
        emit PrintSubmitted(source, priority, timestamp, gapWad, _prints.length - 1);
    }

    // ---------------------------------------------------------------- the print set

    /// @notice The print at an index.
    function printAt(uint256 index) external view returns (Print memory) {
        return _prints[index];
    }

    /// @notice How many prints have been submitted.
    function printCount() external view returns (uint256) {
        return _prints.length;
    }

    /// @notice The selected print and whether it is stale.
    /// @param notBefore only prints at or after this timestamp are candidates.
    /// @param nowTimestamp the moment of selection.
    /// @return index the selected print's index in the print set.
    /// @return stale whether the print is beyond the freshness bound.
    /// @dev The ordering is `(priority ascending, timestamp descending, insertion index ascending)`,
    ///      and it is total: no two prints compare equal, because `insertionIndex` is unique. The
    ///      tie-breaks are not arbitrary. Priority first, because a source's own ranking is the only
    ///      ordering the registry has been given. Timestamp descending, because a later print is
    ///      closer to the open the session settles on. Insertion index last, purely to break the
    ///      remaining ties deterministically -- two prints from one source at one timestamp are the
    ///      same observation, and taking the first submitted is a rule rather than a preference.
    ///
    ///      Reverts with `NoQualifyingPrint` rather than returning a default. A selector that
    ///      returned index zero on an empty set would hand settlement a print that was never made.
    function selectPrint(uint256 notBefore, uint256 nowTimestamp)
        public
        view
        returns (uint256 index, bool stale)
    {
        bool found;
        (found, index, stale) = _trySelect(notBefore, nowTimestamp);
        if (!found) revert NoQualifyingPrint(notBefore, _prints.length);
    }

    /// @notice The selected print, or a report that none qualifies.
    /// @return found whether a print qualified.
    /// @return index the selected index, meaningless when `found` is false.
    /// @return stale whether the print is beyond the freshness bound.
    /// @dev The non-reverting form, so that the registry can route an absent print to void-or-defer
    ///      instead of to a failure. It is an internal function rather than a `try` on the external
    ///      call above, which would spend an external call frame to turn a revert into a boolean.
    function _trySelect(uint256 notBefore, uint256 nowTimestamp)
        internal
        view
        returns (bool found, uint256 index, bool stale)
    {
        if (_prints.length == 0) return (false, 0, false);

        for (uint256 i = 0; i < _prints.length; ++i) {
            Print storage candidate = _prints[i];
            if (candidate.timestamp < notBefore) continue;
            if (_ageOf(candidate.timestamp, nowTimestamp) > staleBoundSeconds) continue;
            if (!found || _isBetter(candidate, _prints[index])) {
                index = i;
                found = true;
            }
        }
        if (!found) return (false, 0, false);

        stale = _ageOf(_prints[index].timestamp, nowTimestamp) > freshnessBoundSeconds;
    }

    /// @dev A print's age, floored at zero.
    ///
    ///      The floor is not defensive noise. `timestamp` arrives from an off-chain feed, and a feed
    ///      whose clock runs ahead of the chain's would otherwise make this subtraction underflow and
    ///      revert the whole selection -- turning a few seconds of clock skew into a settlement halt.
    ///      Reading a future-dated print as age zero defers it on the freshness bound instead, which
    ///      is the same place an equally old print would land.
    function _ageOf(uint256 timestamp, uint256 nowTimestamp) private pure returns (uint256) {
        return nowTimestamp >= timestamp ? nowTimestamp - timestamp : 0;
    }

    // ---------------------------------------------------------------- guards

    /// @notice Reverts unless the sequencer is up and past its grace period, guard G10b.
    function requireSequencerUp() external view {
        _requireSequencerUp();
    }

    /// @dev A zero feed disables the guard, which is the behaviour-preserving default: a registry
    ///      deployed before the guard existed settles exactly as it did before.
    function _requireSequencerUp() internal view {
        address feed = sequencerUptimeFeed;
        if (feed == address(0)) return;
        ISequencerUptimeFeed uptime = ISequencerUptimeFeed(feed);
        if (!uptime.sequencerUp()) revert SequencerDown(0);

        uint256 lastUp = uptime.lastUpTimestamp();
        uint256 graceEnds = lastUp + sequencerGraceSeconds;
        if (block.timestamp < graceEnds) revert SequencerDown(graceEnds - block.timestamp);
    }

    /// @dev `|gapWad|`, as an unsigned magnitude.
    function _magnitude(int256 gapWad) internal pure returns (uint256) {
        return gapWad < 0 ? uint256(-gapWad) : uint256(gapWad);
    }

    /// @dev The total ordering. See `selectPrint` for why each tie-break is the one it is.
    function _isBetter(Print storage candidate, Print storage incumbent)
        private
        view
        returns (bool)
    {
        if (candidate.priority != incumbent.priority) {
            return candidate.priority < incumbent.priority;
        }
        if (candidate.timestamp != incumbent.timestamp) {
            return candidate.timestamp > incumbent.timestamp;
        }
        return candidate.insertionIndex < incumbent.insertionIndex;
    }

    /// @dev Implemented by the registry, which owns the configuration authority.
    function _requireConfigurationAuthority() internal view virtual;
}
