// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SessionKind
/// @notice The closed-session taxonomy. A session is classified by the calendar span of its gap,
///         and the classification is semantic rather than cosmetic: it selects which calibration
///         window and which parameter set applies.
/// @dev Mirrors `bell_calibrator.domain.models.SessionKind`. The two are kept in step by the
///      differential fixture, not by convention.
enum SessionKind {
    /// @dev Span 1 day. The flagship session, and the only one whose per-name calibration is
    ///      publishable (paper §7.8, Table 14: 19.65 expected tail observations).
    Overnight,
    /// @dev Span 3 days. Pooled across names: the per-name spread of lambda is no larger than its
    ///      own standard error (paper Table 14, signal-to-noise 1.0).
    Weekend,
    /// @dev Span 2, 4 or 5 days. Rarest and smallest sample; pooled with the weekend.
    Holiday,
    /// @dev Any span containing a scheduled announcement. A different distribution, not a fatter
    ///      one: measured excess kurtosis is -0.08 +/- 0.48 against 13.24 +/- 0.06 for the
    ///      non-event pool (paper §7.10). Conditioning on a scheduled release removes the
    ///      surprise, so the fat-tail machinery is required for the non-event pool and not for C.
    Event
}
