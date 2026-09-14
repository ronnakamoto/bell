// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev A throwaway used only to measure struct packing with `forge inspect`. Not part of the
///      protocol and not deployed. Two orderings of the same eight fields, so the cost of the
///      ordering decision is a measured number rather than an assertion.
contract PackingProbe {
    enum Status {
        None,
        Committed,
        Challenged,
        Vindicated,
        Slashed
    }

    /// @dev The naive ordering: fields grouped as a reader would naturally write them, widest first.
    struct Naive {
        bytes32 inputsHash;
        uint256 lambdaWad;
        uint256 premiumWad;
        address publisher;
        address challenger;
        uint64 committedInSession;
        uint96 bond;
        Status status;
    }

    /// @dev The shipped ordering.
    struct Packed {
        address publisher;
        Status status;
        uint64 committedInSession;
        address challenger;
        uint96 bond;
        uint256 lambdaWad;
        uint256 premiumWad;
        bytes32 inputsHash;
    }

    Naive public naive;
    Packed public packed;
}
