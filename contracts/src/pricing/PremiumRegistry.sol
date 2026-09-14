// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../interfaces/IERC20.sol";
import {PremiumStore} from "./PremiumStore.sol";

/// @title PremiumRegistry
/// @notice The mechanism that makes publishing a fitted parameter set safe.
/// @dev The protocol does not ask the contract to reproduce the distributional fit. Measuring showed
///      that costs 685,590 gas against 2,640 for a storage read, a factor of about 260, so the oracle
///      publishes the *transformed result* -- a leverage and a premium -- and the discretion that
///      creates is policed here rather than assumed away. Four mechanisms do the policing: a
///      commitment made before the session opens, a bond on both sides, a deterministic re-run of
///      the committed inputs, and a fallback that keeps the pool pricing while a dispute is open.
///
///      **Bonds are ERC-20, not native value.** The brief's signatures are `payable` with a bond of
///      `500,000e18`, which cannot be right: the collateral is USDG at six decimals and `msg.value`
///      is the native gas token, so that value is either 500,000 ETH or 500,000e12 USDG and neither
///      is $500,000. Ruling R2 in DESIGN_NOTES.md settles it: six-decimal USDG by `transferFrom`,
///      and `commit` and `challenge` are not `payable`, so native value reverts by construction.
///
///      The record this contract reasons about -- the commitment struct, its digest, the bond
///      ledger and the session clock -- lives in `PremiumStore`. Everything below is a decision
///      made about that record.
contract PremiumRegistry is PremiumStore {
    /// @notice What the registry is willing to say about a parameter set.
    /// @dev Three-valued on purpose: `Refuse` is a designed degradation and a revert is a fault. A
    ///      pool that reads `Refuse` must not price at all; one that reads `Fallback` prices on a
    ///      named, registered estimate.
    enum Quote {
        Usable,
        Fallback,
        /// @dev Nothing priceable. Never a zero: a zero premium is a free claim.
        Refuse
    }

    constructor(
        IERC20 bondToken_,
        address arbiter_,
        address sessionAuthority_,
        uint256 minPublisherBond_,
        uint256 challengerBond_,
        uint256 stalenessSessions_,
        uint256 bondLockSessions_
    )
        PremiumStore(
            bondToken_,
            arbiter_,
            sessionAuthority_,
            minPublisherBond_,
            challengerBond_,
            stalenessSessions_,
            bondLockSessions_
        )
    {}

    // ---------------------------------------------------------------- publishing

    /// @notice Commit a parameter set for a session that has not opened yet.
    /// @param nameId `keccak256(bytes(symbol))`, not the symbol.
    /// @param forSession the session the parameters are for. Must be strictly in the future.
    /// @param lambdaWad the published leverage at WAD scale.
    /// @param premiumWad the published premium at WAD scale.
    /// @param inputsHash the digest of the raw inputs the fit consumed.
    /// @dev The no-fit-after-the-outcome rule is the whole point of the contract, enforced by the
    ///      session counter rather than a timestamp: `forSession <= currentSession` reverts, so a
    ///      publisher cannot wait to see the open and then commit. A zero parameter is refused here
    ///      as well as at `quote`, because a commitment that can never be priceable is a bond posted
    ///      for nothing.
    function commit(
        bytes32 nameId,
        uint64 forSession,
        uint256 lambdaWad,
        uint256 premiumWad,
        bytes32 inputsHash
    ) external {
        if (forSession <= currentSession) {
            revert SessionAlreadyOpen(forSession, currentSession);
        }
        if (lambdaWad == 0 || premiumWad == 0) revert ZeroParameter(nameId, forSession);
        if (_commitments[nameId][forSession].status != CommitmentStatus.None) {
            revert AlreadyCommitted(nameId, forSession);
        }

        uint256 received = _pullBond(msg.sender, minPublisherBond);
        if (received < minPublisherBond) revert BondTooSmall(received, minPublisherBond);

        bytes32 digest = digestOf(nameId, forSession, lambdaWad, premiumWad, inputsHash);
        _commitments[nameId][forSession] = Commitment({
            publisher: msg.sender,
            status: CommitmentStatus.Committed,
            committedInSession: currentSession,
            challenger: address(0),
            bond: uint96(minPublisherBond),
            lambdaWad: lambdaWad,
            premiumWad: premiumWad,
            inputsHash: inputsHash
        });
        emit Committed(
            nameId, forSession, lambdaWad, premiumWad, inputsHash, digest, minPublisherBond
        );
    }

    /// @notice Challenge a commitment. The bond must be exactly the challenger bond.
    /// @dev An exact match rather than a minimum, and the rounding direction is the reason: the
    ///      challenger bond is `B_pub * p/(1-p)` at a 10% prior, rounded *down*, because it is an
    ///      upper bound on what a guessing challenger should risk. A fee-on-transfer token would
    ///      otherwise let a challenger post a bond smaller than the one the mechanism sizes its
    ///      incentive against, so the exactness is checked on what arrives.
    function challenge(bytes32 nameId, uint64 forSession) external {
        Commitment storage commitment = _commitments[nameId][forSession];
        if (commitment.status != CommitmentStatus.Committed) {
            revert NotChallengeable(nameId, forSession, commitment.status);
        }
        uint256 received = _pullBond(msg.sender, challengerBond);
        if (received != challengerBond) revert ChallengeBondMismatch(received, challengerBond);
        commitment.status = CommitmentStatus.Challenged;
        commitment.challenger = msg.sender;
        emit Challenged(nameId, forSession, msg.sender);
    }

    /// @notice Rule on a challenge. Arbiter only, challenged commitment only.
    /// @param publisherCorrect whether the committed parameter matches the committed inputs.
    /// @dev The arbiter is deliberately narrow. It cannot alter a parameter, only rule on whether a
    ///      committed one matches its committed inputs -- which is why `inputsHash` is load-bearing:
    ///      with it the ruling is a deterministic re-run rather than a matter of testimony, and
    ///      without it the whole mechanism degrades to trusting the publisher.
    ///
    ///      A vindicated publisher takes the challenger's bond and keeps its parameter usable. A
    ///      slashed publisher forfeits its own bond to the challenger and its parameter becomes
    ///      unusable for ever, which is the only punishment that matters: the bond is recoverable,
    ///      the standing of the parameter set is not.
    function resolve(bytes32 nameId, uint64 forSession, bool publisherCorrect) external {
        if (msg.sender != arbiter) revert NotArbiter(msg.sender);
        Commitment storage commitment = _commitments[nameId][forSession];
        if (commitment.status != CommitmentStatus.Challenged) {
            revert NotChallenged(nameId, forSession, commitment.status);
        }

        uint256 transferred;
        if (publisherCorrect) {
            commitment.status = CommitmentStatus.Vindicated;
            transferred = challengerBond;
            // The publisher's own bond stays locked until `bondLockSessions` have passed. A
            // vindication answers whether the parameter matched its inputs; it does not answer
            // whether the inputs were the right ones, and the lock keeps the second question open.
            _pushBond(commitment.publisher, transferred);
        } else {
            commitment.status = CommitmentStatus.Slashed;
            transferred = commitment.bond;
            commitment.bond = 0;
            _pushBond(commitment.challenger, transferred);
        }
        emit Resolved(nameId, forSession, publisherCorrect, transferred);
    }

    // ---------------------------------------------------------------- the read path

    /// @notice What the registry will say about a parameter set.
    /// @return verdict `Usable`, `Fallback` or `Refuse`.
    /// @return lambdaWad the leverage, meaningful only when the verdict is not `Refuse`.
    /// @return premiumWad the premium, meaningful only when the verdict is not `Refuse`.
    /// @dev Four ways to refuse and one way to fall back, every one a designed degradation rather
    ///      than a fault. The rule that dominates them all: **never return zero as though zero were a
    ///      quote** -- a pool that priced on a zero premium would mint a free claim. Staleness is
    ///      measured from `committedInSession`, not from `forSession`.
    function quote(bytes32 nameId, uint64 forSession)
        external
        view
        returns (Quote verdict, uint256 lambdaWad, uint256 premiumWad)
    {
        Commitment storage commitment = _commitments[nameId][forSession];

        if (commitment.status == CommitmentStatus.Challenged) {
            if (!hasFallback[nameId]) return (Quote.Refuse, 0, 0);
            return (Quote.Fallback, fallbackLambdaWad[nameId], fallbackPremiumWad[nameId]);
        }
        if (
            commitment.status == CommitmentStatus.None
                || commitment.status == CommitmentStatus.Slashed
        ) {
            return (Quote.Refuse, 0, 0);
        }
        if (commitment.bond == 0 || commitment.lambdaWad == 0 || commitment.premiumWad == 0) {
            return (Quote.Refuse, 0, 0);
        }
        if (currentSession > uint256(commitment.committedInSession) + stalenessSessions) {
            return (Quote.Refuse, 0, 0);
        }
        return (Quote.Usable, commitment.lambdaWad, commitment.premiumWad);
    }

    // ---------------------------------------------------------------- clock and fallback

    /// @notice Advance the monotone session counter.
    /// @dev Gated on `sessionAuthority` rather than left permissionless. Advancing only makes
    ///      commitments *staler*, which is the safe direction for a caller reading `quote`, but it
    ///      also expires a freshly posted commitment, so an open caller could grief every publisher
    ///      in the protocol for the price of one transaction. Recorded as a liveness dependency in
    ///      SECURITY.md.
    function advanceSession() external {
        if (msg.sender != sessionAuthority) revert NotArbiter(msg.sender);
        uint64 previous = currentSession;
        currentSession = previous + 1;
        emit SessionAdvanced(previous, currentSession);
    }

    /// @notice Register the trailing-realised fallback for a name.
    /// @dev Registered rather than computed, and the registry never invents one. While a challenge is
    ///      open the pool prices on this instead of halting, and if none is registered the verdict is
    ///      `Refuse` rather than a guess -- the difference between a designed degradation and a
    ///      silent mispricing.
    function setFallback(bytes32 nameId, uint256 lambdaWad, uint256 premiumWad) external {
        if (msg.sender != sessionAuthority) revert NotArbiter(msg.sender);
        if (lambdaWad == 0 || premiumWad == 0) revert ZeroParameter(nameId, 0);
        fallbackLambdaWad[nameId] = lambdaWad;
        fallbackPremiumWad[nameId] = premiumWad;
        hasFallback[nameId] = true;
        emit FallbackRegistered(nameId, lambdaWad, premiumWad);
    }

    /// @notice Withdraw a publisher's bond once its lock has expired.
    /// @dev The lock is what makes the bond a bond rather than a deposit: a vindication answers
    ///      "does this match its inputs?", not "were those the right inputs?", and only the session's
    ///      outcome answers the second.
    function withdrawPublisherBond(bytes32 nameId, uint64 forSession) external {
        Commitment storage commitment = _commitments[nameId][forSession];
        if (commitment.bond == 0 || bondWithdrawn[nameId][forSession]) {
            revert NothingToWithdraw(nameId, forSession);
        }
        uint64 unlocksAt = commitment.committedInSession + uint64(bondLockSessions);
        if (currentSession < unlocksAt) revert BondLocked(unlocksAt, currentSession);

        uint256 amount = commitment.bond;
        commitment.bond = 0;
        bondWithdrawn[nameId][forSession] = true;
        _pushBond(commitment.publisher, amount);
        emit BondWithdrawn(nameId, forSession, amount);
    }
}
