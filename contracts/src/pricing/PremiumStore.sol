// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title PremiumStore
/// @notice What the premium registry *remembers*: the commitment record and its digest, the bond
///         ledger, the fallback register, and the session clock.
/// @dev Split out of `PremiumRegistry` so that both files sit inside the 400-line limit the brief's
///      §8.1 sets. The split is not a line-count shuffle, and it is worth saying why. Everything
///      here is state and record-keeping; everything left in `PremiumRegistry` is a decision. A
///      reader asking *"what does the protocol remember about a publisher?"* reads this file. A
///      reader asking *"what does it do about one?"* reads the other. The two questions are the
///      reason the boundary is here rather than somewhere convenient.
///
///      Nothing in this contract can move a bond on its own initiative. `_pullBond` and `_pushBond`
///      are the only paths to the token, and both are `internal`, so every transfer is a decision
///      made in the registry above.
abstract contract PremiumStore {
    /// @notice The lifecycle of a commitment.
    /// @dev An enum rather than booleans, for the same reason the session's lifecycle is: a boolean
    ///      makes the legal transition set unreadable and is how "resolve twice" bugs are born.
    ///      `Vindicated` and `Slashed` are both terminal.
    enum CommitmentStatus {
        None,
        /// @dev Committed and bonded, unchallenged.
        Committed,
        /// @dev Challenged; the bond is locked and the quote degrades to the fallback.
        Challenged,
        Vindicated,
        Slashed
    }

    /// @notice A publisher's pre-session declaration.
    /// @dev `committedInSession` is the session the commitment was *made* in, which is what the
    ///      staleness bound is measured from. Measuring from `forSession` instead would let a
    ///      publisher commit arbitrarily early and still be inside the bound at the session it names.
    ///
    ///      **Field order is deliberate and it is a gas decision.** Measured with
    ///      `forge inspect test/mocks/PackingProbe.sol:PackingProbe storage-layout`: the shipped
    ///      ordering occupies 160 bytes, five slots; the natural widest-first ordering of the same
    ///      eight fields occupies 192 bytes, six. One cold `SSTORE` is 20,000 gas, and the measured
    ///      end-to-end difference on `commit` is 21,877 -- against a brief cap that `commit` misses
    ///      by 8,247 even with the saving. See DESIGN_NOTES.md F42 and GAS_REPORT.md.
    ///
    ///        slot 0: publisher (20) + status (1) + committedInSession (8) = 29 of 32 bytes
    ///        slot 1: challenger (20) + bond (12) = 32 of 32 bytes
    ///        slot 2: lambdaWad
    ///        slot 3: premiumWad
    ///        slot 4: inputsHash
    ///
    ///      `bond` is a `uint96` rather than a `uint256` for exactly one reason: it lets the bond
    ///      share a slot with the challenger, which is one fewer cold `SSTORE` on the path that had
    ///      no room left. The bound is 7.9e28 units, which at the collateral's six decimals is more
    ///      than the entire supply of anything, so the narrowing is not a real constraint -- and the
    ///      constructor refuses a bond that does not fit rather than truncating one silently.
    ///
    ///      `test/unit/PremiumRegistry.t.sol` reads these slots back raw, so a reordering that costs
    ///      20,000 gas cannot pass unnoticed.
    struct Commitment {
        address publisher;
        CommitmentStatus status;
        uint64 committedInSession;
        address challenger;
        uint96 bond;
        uint256 lambdaWad;
        uint256 premiumWad;
        bytes32 inputsHash;
    }

    /// @dev Thrown when a publisher tries to commit for a session that is not in the future.
    error SessionAlreadyOpen(uint64 forSession, uint64 currentSession);
    /// @dev Thrown when a publisher's bond is below the minimum on what arrives.
    error BondTooSmall(uint256 sent, uint256 required);
    /// @dev Thrown when a challenger's bond is not exactly the challenger bond.
    error ChallengeBondMismatch(uint256 sent, uint256 required);
    /// @dev Thrown when a commitment that is not challengeable is challenged.
    error NotChallengeable(bytes32 nameId, uint64 forSession, CommitmentStatus status);
    /// @dev Thrown when a caller other than the arbiter attempts a ruling.
    error NotArbiter(address caller);
    /// @dev Thrown when a ruling is attempted on a commitment that is not challenged.
    error NotChallenged(bytes32 nameId, uint64 forSession, CommitmentStatus status);
    /// @dev Thrown when a commitment is made with a zero parameter. A zero is never priceable, and
    ///      returning it as though it were would quote a free claim.
    error ZeroParameter(bytes32 nameId, uint64 forSession);
    /// @dev Thrown when a commitment for the same name and session already exists.
    error AlreadyCommitted(bytes32 nameId, uint64 forSession);
    /// @dev Thrown when a bond is withdrawn before its lock expires.
    error BondLocked(uint64 unlocksInSession, uint64 currentSession);
    /// @dev Thrown when a bond is withdrawn twice or does not exist.
    error NothingToWithdraw(bytes32 nameId, uint64 forSession);
    /// @dev Thrown when a bond transfer fails.
    error BondTransferFailed();
    /// @dev Thrown when a required address is zero.
    error ZeroAddress();

    /// @dev Emitted on every commitment, carrying the digest the publisher will be judged against.
    event Committed(
        bytes32 indexed nameId,
        uint64 indexed forSession,
        uint256 lambdaWad,
        uint256 premiumWad,
        bytes32 inputsHash,
        bytes32 digest,
        uint256 bond
    );
    /// @dev Emitted when a commitment is challenged.
    event Challenged(bytes32 indexed nameId, uint64 indexed forSession, address challenger);
    /// @dev Emitted on every ruling, with the direction, so the dispute record is auditable.
    event Resolved(
        bytes32 indexed nameId,
        uint64 indexed forSession,
        bool publisherCorrect,
        uint256 transferred
    );
    /// @dev Emitted when the session counter advances.
    event SessionAdvanced(uint64 from, uint64 to);
    /// @dev Emitted when a fallback is registered.
    event FallbackRegistered(bytes32 indexed nameId, uint256 lambdaWad, uint256 premiumWad);
    /// @dev Emitted when a publisher bond is withdrawn after its lock.
    event BondWithdrawn(bytes32 indexed nameId, uint64 indexed forSession, uint256 amount);

    /// @notice The bond token: six-decimal USDG, the same unit as the collateral.
    IERC20 public immutable bondToken;
    /// @notice The only address that may rule on a challenge.
    address public immutable arbiter;
    /// @notice The only address that may advance the session counter or register a fallback.
    address public immutable sessionAuthority;
    /// @notice The minimum publisher bond.
    uint256 public immutable minPublisherBond;
    /// @notice The exact challenger bond.
    uint256 public immutable challengerBond;
    /// @notice How many sessions a commitment stays usable after the session it was made in.
    uint256 public immutable stalenessSessions;
    /// @notice How many sessions a bond stays locked after the session it was posted in.
    uint256 public immutable bondLockSessions;

    /// @notice The monotone session counter. There is no calendar in the contract, and this is the
    ///      intended design: a counter expresses "the outcome is already known" and cannot be
    ///      manipulated by a validator the way a timestamp can.
    uint64 public currentSession;

    /// @dev `nameId => forSession => Commitment`.
    mapping(bytes32 nameId => mapping(uint64 forSession => Commitment)) internal _commitments;
    /// @dev `nameId => forSession => whether the publisher bond has been withdrawn`.
    mapping(bytes32 nameId => mapping(uint64 forSession => bool)) public bondWithdrawn;
    /// @dev The trailing-realised fallback per name, used while a challenge is open.
    mapping(bytes32 nameId => uint256) public fallbackLambdaWad;
    mapping(bytes32 nameId => uint256) public fallbackPremiumWad;
    mapping(bytes32 nameId => bool) public hasFallback;

    constructor(
        IERC20 bondToken_,
        address arbiter_,
        address sessionAuthority_,
        uint256 minPublisherBond_,
        uint256 challengerBond_,
        uint256 stalenessSessions_,
        uint256 bondLockSessions_
    ) {
        if (
            address(bondToken_) == address(0) || arbiter_ == address(0)
                || sessionAuthority_ == address(0)
        ) revert ZeroAddress();
        if (minPublisherBond_ == 0) revert BondTooSmall(0, 1);
        if (challengerBond_ == 0) revert ChallengeBondMismatch(0, 1);
        // The stored bond is a uint96. A bond that does not fit is refused at construction rather
        // than truncated, because a truncated bond is a bond smaller than the one advertised.
        if (minPublisherBond_ > type(uint96).max) {
            revert BondTooSmall(minPublisherBond_, type(uint96).max);
        }
        bondToken = bondToken_;
        arbiter = arbiter_;
        sessionAuthority = sessionAuthority_;
        minPublisherBond = minPublisherBond_;
        challengerBond = challengerBond_;
        stalenessSessions = stalenessSessions_;
        bondLockSessions = bondLockSessions_;
    }

    // ---------------------------------------------------------------- the commitment digest

    /// @notice The digest a publisher commits to and a challenger recomputes.
    /// @dev Paper Appendix B, byte for byte:
    ///      `keccak256(abi.encode(nameId, forSession, lambdaWad, premiumWad, inputsHash))` with
    ///      `nameId` a `bytes32`, `forSession` a `uint64`, and the two parameters `uint256` at WAD
    ///      scale. `bell_calibrator.domain.digest` builds the same preimage on the Python side, and
    ///      `spec/digest.json` is the shared fixture both are checked against -- including from this
    ///      contract, through `test/differential/Digest.t.sol`.
    ///
    ///      The `uint64` matters. A `uint256` would encode differently and every honest challenge
    ///      would fail, which is a failure that looks exactly like a dishonest publisher.
    function digestOf(
        bytes32 nameId,
        uint64 forSession,
        uint256 lambdaWad,
        uint256 premiumWad,
        bytes32 inputsHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(nameId, forSession, lambdaWad, premiumWad, inputsHash));
    }

    // ---------------------------------------------------------------- accessors

    /// @notice The commitment recorded for a name and session.
    function commitmentOf(bytes32 nameId, uint64 forSession)
        external
        view
        returns (Commitment memory)
    {
        return _commitments[nameId][forSession];
    }

    // ---------------------------------------------------------------- the bond ledger

    /// @dev Moves `required` in from `from` and returns what actually arrived.
    ///
    ///      The received amount is *measured* rather than assumed, and that is the whole point of
    ///      this helper existing. A fee-on-transfer bond token delivers less than the nominal bond,
    ///      and a registry that credited the nominal amount would hold a bond smaller than the one
    ///      it advertises -- which is the entire value of the bond. Both call sites below depend on
    ///      the distinction: `commit` refuses an under-delivery, and `challenge` refuses anything
    ///      that is not an exact match, because the challenger bond sizes an incentive and a bond
    ///      that is merely close sizes it wrongly.
    function _pullBond(address from, uint256 required) internal returns (uint256 received) {
        uint256 balanceBefore = bondToken.balanceOf(address(this));
        if (!bondToken.transferFrom(from, address(this), required)) {
            revert BondTransferFailed();
        }
        received = bondToken.balanceOf(address(this)) - balanceBefore;
    }

    /// @dev Moves `amount` out. The return value is checked because a token that returns `false`
    ///      instead of reverting would otherwise leave the ledger claiming a transfer that did not
    ///      happen, and the ledger is what the next bond's arithmetic is measured against.
    function _pushBond(address to, uint256 amount) internal {
        if (!bondToken.transfer(to, amount)) revert BondTransferFailed();
    }
}
