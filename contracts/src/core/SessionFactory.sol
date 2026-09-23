// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Constants} from "../generated/Constants.sol";
import {Payoff} from "../libraries/Payoff.sol";
import {WadMath} from "../libraries/WadMath.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {ReferenceRegistry} from "./ReferenceRegistry.sol";
import {Session} from "./Session.sol";

/// @title SessionFactory
/// @notice Deployment and the listing gates.
/// @dev Two gates, and both are load-bearing rather than cosmetic.
///
///      The **lattice gate** refuses a leverage that is not exactly representable on the harmonic
///      ladder. An off-lattice cap means the quoted cap and the quoted leverage describe different
///      contracts: a leverage of 15.5 publishes a cap of 6.45%, and a counterparty pricing off one
///      of those numbers is pricing a different instrument from the one she receives.
///
///      The **cap gate** refuses a saturation cap at or above one. Such a claim pays linearly across
///      the entire reachable range of gaps, so the truncation that makes the payoff bounded never
///      binds, the truncated-moment machinery degenerates to the untruncated absolute mean, and the
///      "cap" stops bounding anything. The listing gates are the only place this can be caught,
///      because by the time a session exists the leverage is fixed.
///
///      Deployment is by CREATE2, so a session's address is a function of `(refToken, lam, expiry)`
///      and the factory's own configuration. That makes a session address predictable before it
///      exists, which is what lets a counterparty quote against a session that has not been created
///      yet -- and it makes a duplicate deployment a revert rather than a second, different session
///      for the same reference and session.
contract SessionFactory {
    /// @dev Thrown when a leverage is not exactly representable on the harmonic ladder.
    error NotOnHarmonicLattice(uint256 capWad);
    /// @dev Thrown when a saturation cap at or above one is listed.
    error ListingGateCapNotBelowOne(uint256 capWad);
    /// @dev Thrown when a session for the same `(refToken, lam, expiry)` already exists.
    error DuplicateSession(bytes32 salt);
    /// @dev Thrown when a required address is zero.
    error ZeroAddress();
    /// @dev Thrown when the expiry is not in the future.
    error ExpiryNotReached(uint256 expiry, uint256 nowTimestamp);
    /// @dev Thrown when the requested seed exceeds what the caller has approved.
    error SeedTransferFailed();
    /// @dev Thrown when a non-zero seed is too small to split into two non-empty legs.
    error SeedTooSmall(uint256 seed);
    /// @dev Thrown when a non-zero seed is below the depth gate.
    error SeedBelowMinimum(uint256 seed, uint256 minSeed);

    /// @dev Emitted on every listing, with the gates' verdicts recorded so a listing is auditable
    ///      from logs alone.
    event SessionCreated(
        address indexed session,
        address indexed referenceToken,
        uint256 lamWad,
        uint256 expiryTimestamp,
        uint256 capWad,
        uint256 notionalCapWad,
        bytes32 salt
    );

    /// @notice The collateral every session this factory deploys is denominated in.
    IERC20 public immutable collateral;
    /// @notice The contract every session this factory deploys will accept settlement from.
    address public immutable referenceRegistry;

    /// @dev The largest leverage the diagnostics scan. A bound rather than a limit: the listing gate
    ///      accepts any whole leverage whose cap is below one, and the diagnostics iterate a fixed
    ///      range so that they are bounded and cheap. One hundred is comfortably above the widest
    ///      published leverage (32) and the widest event leverage (21).
    uint256 public constant DIAGNOSTIC_MAX_LEVERAGE = 100;

    /// @dev Slot 0: whether a salt has been used. A session's address is derivable from the salt, so
    ///      the mapping is a convenience for `DuplicateSession` rather than the source of truth --
    ///      the CREATE2 collision itself is what actually prevents a duplicate.
    mapping(bytes32 salt => bool used) public sessionDeployed;

    constructor(IERC20 collateral_, address referenceRegistry_) {
        if (referenceRegistry_ == address(0)) revert ZeroAddress();
        collateral = collateral_;
        referenceRegistry = referenceRegistry_;
    }

    // ---------------------------------------------------------------- the gates

    /// @notice The saturation cap for a leverage, having checked the lattice and cap gates.
    /// @param lamWad the leverage at WAD scale.
    /// @return capWad the smallest gap at which the claim pays its cap, `ceil(1 / lambda)`.
    /// @dev Wholeness is checked before the cap, because a fractional leverage such as 15.5 produces
    ///      a cap of 6.45% that looks perfectly reasonable and would pass a cap-only gate. The two
    ///      checks are ordered so that the error names the real defect.
    function checkListingLam(uint256 lamWad) public pure returns (uint256 capWad) {
        if (lamWad == 0 || lamWad % Constants.WAD != 0) {
            revert NotOnHarmonicLattice(lamWad == 0 ? 0 : WadMath.divWad(Constants.WAD, lamWad));
        }
        capWad = Payoff.saturationGapWad(lamWad);
        if (capWad >= Constants.WAD) revert ListingGateCapNotBelowOne(capWad);
    }

    /// @notice The leverage for a saturation cap, having checked both gates.
    /// @param capWad the saturation cap at WAD scale.
    /// @return lamWad the leverage whose saturation gap is exactly `capWad`.
    /// @dev The reciprocal is rounded to *nearest* here, unlike the calibrator's floor, and the
    ///      difference is deliberate: this is an inverse of the ladder, not the leverage rule. The
    ///      round trip is then verified exactly, so a cap that is not a lattice point is refused
    ///      rather than silently snapped to the nearest one. A cap of 6.6667% and a cap of 6.75% both
    ///      round to a leverage near 15, and only one of them is listable.
    function checkListingCap(uint256 capWad) public pure returns (uint256 lamWad) {
        if (capWad == 0 || capWad >= Constants.WAD) revert ListingGateCapNotBelowOne(capWad);
        uint256 numerator = Constants.WAD * Constants.WAD;
        // The reciprocal is floored, then rounded to the nearest *whole leverage*. Rounding at the
        // second step rather than the first is what makes this correct: for a leverage of three the
        // cap is `ceil(1e36/3e18) = 333333333333333334`, whose exact reciprocal is
        // 2999999999999999994 -- six wei short of three. Rounding the reciprocal itself cannot
        // recover the three, because the shortfall is six wei and not a fraction of one; rounding
        // the quotient in WAD units can, because 2.999999999999999994 is nearest to three.
        uint256 reciprocal = numerator / capWad;
        uint256 whole = (reciprocal + Constants.WAD / 2) / Constants.WAD;
        // There is no `whole == 0` guard here, and the reason is arithmetic rather than optimism. The
        // gate at the top of this function establishes `0 < capWad < WAD`, so
        // `reciprocal = 1e36 / capWad > 1e18` and `whole >= (1e18 + 5e17) / 1e18 = 1`. A check that
        // cannot fail is a branch that cannot be covered, and a reader should not have to prove that
        // for themselves -- so the proof is here and the check is gone. See DESIGN_NOTES.md F44.
        lamWad = whole * Constants.WAD;
        // Verified exactly, so a cap that is not a lattice point is refused rather than snapped.
        if (Payoff.saturationGapWad(lamWad) != capWad) revert NotOnHarmonicLattice(capWad);
    }

    /// @notice Whether a leverage is a whole number, i.e. whether its cap is exactly `1/n`.
    /// @dev The harmonic ladder is the set of *traded strikes*. The rounding lattice in
    ///      `spec/constants.yaml` is a different object: it is the coarser grid the cap is snapped to
    ///      during calibration, and most of its points are not listable. See DESIGN_NOTES.md F2.
    function exactlyRepresentable(uint256 lamWad) public pure returns (bool) {
        return lamWad > 0 && lamWad % Constants.WAD == 0;
    }

    // ---------------------------------------------------------------- diagnostics

    /// @notice How much of the rounding lattice is listable at all.
    /// @return total the number of lattice points strictly between zero and one.
    /// @return exact how many of them are exactly `1/n` for some whole `n`.
    /// @dev This is the measurement behind the paper's conclusion that the traded strike set must be
    ///      the harmonic ladder rather than the grid: most grid points are not markets. The paper
    ///      reports 11 of 79 listable over a set it does not specify; this counts the whole lattice,
    ///      so the absolute numbers differ and the ratio is the comparable quantity.
    ///
    ///      Bounded by `1 / ROUNDING_LATTICE_WAD`, i.e. 400 iterations at the published 0.25%
    ///      spacing, and documented as such rather than left as an unbounded scan.
    function latticeCoverage() public pure returns (uint256 total, uint256 exact) {
        uint256 spacing = Constants.ROUNDING_LATTICE_WAD;
        for (uint256 capWad = spacing; capWad < Constants.WAD; capWad += spacing) {
            total += 1;
            // No `whole == 0` case to skip: `capWad` runs over `[spacing, WAD)`, so `1e36 / capWad`
            // exceeds `1e18` and the quotient in WAD units is at least one.
            uint256 whole = ((Constants.WAD * Constants.WAD) / capWad) / Constants.WAD;
            if (Payoff.saturationGapWad(whole * Constants.WAD) == capWad) exact += 1;
        }
    }

    /// @notice The worst leverage error the rounding lattice introduces across the listed ladder.
    /// @return worst the relative leverage error at its worst point, at WAD scale.
    /// @return worstLam the leverage at which it occurs.
    /// @dev The number that justifies stating the lattice at all: the published leverage depends on
    ///      the grid, so an unstated grid means an unstated instrument. Measured over leverages 1 to
    ///      `DIAGNOSTIC_MAX_LEVERAGE`, which bounds the loop.
    function worstLatticeRoundingWad() public pure returns (uint256 worst, uint256 worstLam) {
        uint256 spacing = Constants.ROUNDING_LATTICE_WAD;
        for (uint256 units = 1; units <= DIAGNOSTIC_MAX_LEVERAGE; ++units) {
            uint256 lamWad = units * Constants.WAD;
            uint256 capWad = Payoff.saturationGapWad(lamWad);
            uint256 snapped = ((capWad + spacing - 1) / spacing) * spacing;
            if (snapped >= Constants.WAD) continue;
            // The skip above leaves `0 < snapped < WAD`, so the quotient is at least one by the same
            // arithmetic as `latticeCoverage`. There is no zero case to skip.
            uint256 snappedLam = ((Constants.WAD * Constants.WAD) / snapped) / Constants.WAD;
            uint256 error = (WadMath.absDiff(snappedLam, units) * Constants.WAD) / units;
            if (error > worst) {
                worst = error;
                worstLam = lamWad;
            }
        }
    }

    /// @notice The traded strike caps: the saturation cap of every *listable* whole leverage.
    /// @dev Returned as caps rather than leverages because the cap is what a counterparty prices
    ///      against. The ladder starts at two, not one: a leverage of one has a saturation cap of
    ///      exactly one, which the cap gate refuses. The array length is therefore
    ///      `DIAGNOSTIC_MAX_LEVERAGE - 1`, a constant.
    function listedLadder() public pure returns (uint256[] memory caps) {
        caps = new uint256[](DIAGNOSTIC_MAX_LEVERAGE - 1);
        for (uint256 units = 2; units <= DIAGNOSTIC_MAX_LEVERAGE; ++units) {
            caps[units - 2] = Payoff.saturationGapWad(units * Constants.WAD);
        }
    }

    // ---------------------------------------------------------------- deployment

    /// @notice The CREATE2 salt for a session.
    /// @dev A function of `(refToken, lam, expiry)` and nothing else, which is what makes the address
    ///      predictable from those three values. The notional cap and the seed are deliberately
    ///      excluded: two sessions for the same reference, leverage and expiry are the same market
    ///      however they are sized, and allowing a different cap to produce a different address would
    ///      let the same market exist twice.
    function saltFor(address referenceToken, uint256 lamWad, uint256 expiryTimestamp)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(referenceToken, lamWad, expiryTimestamp));
    }

    /// @notice Create a session for `(refToken, lam, expiry)` and optionally seed its pool.
    /// @param referenceToken the reference equity whose gap the session settles on.
    /// @param lamWad the leverage, which must be on the harmonic ladder.
    /// @param expiryTimestamp the moment after which the session stops trading.
    /// @param notionalCapWad the ceiling on pairs outstanding, in collateral units.
    /// @param seed pairs to mint and split into the pool. Zero creates an unseeded session, which
    ///        cannot be traded against until somebody seeds it.
    /// @return session the deployed session's address, derivable in advance from `saltFor`.
    /// @dev The seed is split evenly, which sets the pool's opening price at one half. That is a
    ///      starting condition rather than a calibration: the leverage fixes the payoff, and the
    ///      pool's price is whatever the two reserves imply from then on. A seeder who wants a
    ///      different opening price should create unseeded and seed it herself at her own ratio.
    ///
    ///      Registration with the reference registry is part of this call, not a second transaction.
    ///      A session that exists but is not registered is unsettleable (F93); the multiplier G8
    ///      will judge against is still read from the token at registration time, never supplied by
    ///      the caller, so folding the step in does not reopen that question.
    function createSession(
        address referenceToken,
        uint256 lamWad,
        uint256 expiryTimestamp,
        uint256 notionalCapWad,
        uint256 seed
    ) external returns (address session) {
        if (referenceToken == address(0)) revert ZeroAddress();
        if (expiryTimestamp <= block.timestamp) {
            revert ExpiryNotReached(expiryTimestamp, block.timestamp);
        }
        // A non-zero seed must be splittable. One pair cannot be: `_seedBalanced` returns early when
        // `longIn == 0`, so the factory would mint the pair, never deposit it, and hold it for ever --
        // it has no function that could redeem it. The session would be left with an unseeded pool
        // *and* an outstanding pair, which makes `close()` unreachable once it settles. That is the
        // stranding the comment on `_seedBalanced` says the odd-unit rule exists to prevent, and the
        // rule covers an odd seed above one; this is the case it did not.
        //
        // Zero remains the documented way to ask for an unseeded session, and is not an error.
        if (seed == 1) revert SeedTooSmall(seed);
        // The depth gate (G3): a non-zero seed must be at least the protocol minimum. A pool seeded
        // below the challenger bond cannot absorb a challenge-sized trade without material price
        // impact, so it is effectively empty -- and listing it would hand traders a market they
        // cannot trade against. Zero is exempt: it is the documented way to ask for an unseeded
        // session, which becomes tradeable once somebody seeds it.
        if (seed != 0 && seed < Constants.MIN_SEED) {
            revert SeedBelowMinimum(seed, Constants.MIN_SEED);
        }
        // Both gates, before anything is deployed. A session that exists but should not is worse
        // than one that was never created, because its address is already being quoted against.
        uint256 capWad = checkListingLam(lamWad);

        bytes32 salt = saltFor(referenceToken, lamWad, expiryTimestamp);
        // Checked before the CREATE2 rather than after it. Solidity's `new{salt:}` reverts on a
        // collision with an empty revert of its own, so a post-hoc `address(0)` check would be
        // unreachable -- and an error path that has never fired is indistinguishable from one that
        // does nothing. The mapping makes the duplicate case a named, testable error.
        if (sessionDeployed[salt]) revert DuplicateSession(salt);

        session = address(
            new Session{salt: salt}(
                collateral,
                referenceToken,
                lamWad,
                expiryTimestamp,
                notionalCapWad,
                referenceRegistry
            )
        );
        sessionDeployed[salt] = true;

        if (seed != 0) {
            // The factory is the one paying for the seed, so it must hold the collateral and
            // approve the session before minting on its own behalf. `mintPairFromFactory` pulls
            // from `msg.sender`, which at that point is this contract.
            if (!collateral.transferFrom(msg.sender, address(this), seed)) {
                revert SeedTransferFailed();
            }
            if (!collateral.approve(session, seed)) revert SeedTransferFailed();
            Session(session).mintPairFromFactory(address(this), seed);
            _seedBalanced(session, seed);
        }
        emit SessionCreated(
            session, referenceToken, lamWad, expiryTimestamp, capWad, notionalCapWad, salt
        );

        // Registration is part of listing, not a second transaction (F93). The multiplier G8 will
        // judge against is still read from the token here, never supplied by the caller.
        ReferenceRegistry(referenceRegistry).registerSession(session, referenceToken);
    }

    /// @notice The address a session for these parameters would have, without deploying it.
    /// @dev Derived from the CREATE2 formula rather than from a stored mapping, so it is correct
    ///      before deployment as well as after.
    function predictSession(
        address referenceToken,
        uint256 lamWad,
        uint256 expiryTimestamp,
        uint256 notionalCapWad
    ) external view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(Session).creationCode,
                abi.encode(
                    collateral,
                    referenceToken,
                    lamWad,
                    expiryTimestamp,
                    notionalCapWad,
                    referenceRegistry
                )
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            saltFor(referenceToken, lamWad, expiryTimestamp),
                            initCodeHash
                        )
                    )
                )
            )
        );
    }

    /// @dev Splits the freshly minted pairs as evenly as the parity allows and deposits both legs
    ///      into the pool. The odd unit, if any, goes to the short leg rather than being left behind:
    ///      a stranded claim is a claim nobody can redeem, and it would make `close()` unreachable
    ///      once the session settled.
    ///
    ///      There is no `longIn == 0` early return, and its absence is the fix rather than an
    ///      omission. The only caller refuses `seed == 1` at the listing gate, so `pairs >= 2` and
    ///      `longIn >= 1` always. The guard it replaced did not prevent the stranding this comment
    ///      describes -- it *caused* it, by returning quietly on the one input it covered. See
    ///      DESIGN_NOTES.md F48.
    function _seedBalanced(address session, uint256 pairs) private {
        uint256 longIn = pairs / 2;
        uint256 shortIn = pairs - longIn;
        Session target = Session(session);
        target.longClaim().approve(session, longIn);
        target.shortClaim().approve(session, shortIn);
        target.seedPool(longIn, shortIn);
    }
}
