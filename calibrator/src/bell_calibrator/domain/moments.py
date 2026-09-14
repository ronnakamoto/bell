"""The distributional primitives, in exact decimal arithmetic.

This module is the reference the Solidity implementation is checked against. It computes the same
identities as `contracts/src/libraries/Stat.sol`, but with a high-precision error function rather
than the on-chain rational approximation, so the difference between the two is the on-chain
approximation's error and nothing else. That is what makes the differential tolerance derivable
rather than chosen.

Pure: standard library only, no I/O, no clock, no global state (build brief §5.1). `Decimal`
throughout -- no `float` appears in any signature, and none appears in any body: the error function
is a Taylor series for small arguments and a continued fraction for large ones, both evaluated in
`Decimal`.
"""

from __future__ import annotations

from decimal import Decimal, localcontext

# Working precision. Set well above the 18 decimal places the WAD scale carries so that rounding in
# this module is never the binding error: the on-chain implementation's error function bound of
# 1.5e-7 is nine orders of magnitude coarser.
WORKING_PRECISION = 50

SQRT_PI = Decimal(
    "1.77245385090551602729816748334114518279754945612238712821380779"
)
SQRT_TWO = Decimal("1.41421356237309504880168872420969807856967187537694807317667974")
SQRT_TWO_PI = Decimal(
    "2.50662827463100050241576528481104525300698674060993831662992358"
)
# `2 / sqrt(pi)`, the Maclaurin coefficient, = 1.1283791670955125738961589031215451716759765605253.
#
# Written as a literal rather than computed as `2 / SQRT_PI`. A module-level division would be
# evaluated in the *default* decimal context, whose 28-digit precision is coarser than this module's
# 50, and the resulting constant would silently cap every downstream result at 28 digits.
#
# Not to be confused with `sqrt(2 / pi)`, which is 0.7978845608028653558798921198687637369517173.
# The two differ by a factor of pi/2 and both appear in this domain -- the first as the error
# function's coefficient, the second as `E[|Z|]`, the untruncated absolute mean. The test
# `test_constants_are_internally_consistent` asserts the relationship, because a swap between them
# is silent and shifts every result by 29%.
TWO_OVER_SQRT_PI = Decimal(
    "1.1283791670955125738961589031215451716881012586579977136881714433276453523614898"
)

# `sqrt(2 / pi)` = 0.79788456080286535587989211986876373695171726232986931533185224. `E[|Z|]` for a
# standard normal, and therefore the `c -> infinity` limit of the moment divided by sigma.
SQRT_TWO_OVER_PI = Decimal(
    "0.7978845608028653558798921198687637369517172623298693153318522425059570375383161"
)

# The Taylor series is used below this argument and the continued fraction above it. At 4 the series
# still converges in about 60 terms with no cancellation, and the continued fraction is converging
# in about 20.
SERIES_BREAKPOINT = Decimal(4)
_SERIES_MAX_TERMS = 200
_CONTINUED_FRACTION_MAX_TERMS = 200
_CONTINUED_FRACTION_EPSILON = Decimal("1e-45")
_TINY = Decimal("1e-60")


def standard_normal_pdf(x: Decimal) -> Decimal:
    """The standard normal density, `phi(x)`.

    `phi(x) = exp(-x^2 / 2) / sqrt(2 pi)`.
    """
    with localcontext() as context:
        context.prec = WORKING_PRECISION
        return (-(x * x) / 2).exp() / SQRT_TWO_PI


def standard_normal_cdf(x: Decimal) -> Decimal:
    """The standard normal distribution function, `Phi(x)`.

    `Phi(x) = (1 + erf(x / sqrt(2))) / 2`.
    """
    with localcontext() as context:
        context.prec = WORKING_PRECISION
        return (1 + _erf(x / SQRT_TWO)) / 2


def truncated_abs_moment(lam: Decimal, mu: Decimal, sigma: Decimal) -> Decimal:
    """`E[ min(|G|, c) ]` for `G ~ N(mu, sigma^2)`, with `c = 1 / lam`.

    This is the paper's Eq (12), and `lam * truncated_abs_moment(...)` is the fair long premium.

    Conventions, matching `Stat.truncatedAbsMoment` exactly so the two cannot drift:
      - `sigma == 0`: the gap is identically zero, so the moment is zero.
      - `lam == 0`: `c` is infinite, so the moment is the untruncated `E[|G|] = sigma sqrt(2/pi)`.
        This is the paper's stated `c -> infinity` limit, which makes the two branches continuous.
      - a non-zero `mu` is refused, not approximated: `|G|` is then folded normal and the truncated
        moment has no closed form. The protocol's model is `G ~ N(0, sigma^2)`.

    Note the deliberate absence of `E[|G| ** (1/lam)]`. The build brief's §2.4 writes the primitive
    that way; the paper's Eq (12) and the brief's own Appendix A fixture both contradict it, and
    ruling R1 in DESIGN_NOTES.md settles it in the paper's favour.
    """
    if mu != 0:
        raise ValueError("truncated_abs_moment is defined for a zero mean only")
    if sigma == 0:
        return Decimal(0)
    if lam == 0:
        return sigma * SQRT_TWO_OVER_PI
    return truncated_abs_moment_at_cap(1 / lam, sigma)


def truncated_abs_moment_at_cap(cap: Decimal, sigma: Decimal) -> Decimal:
    """`E[ min(|G|, cap) ]` for `G ~ N(0, sigma^2)`, given the cap directly.

    Split at `|G| = cap`: the inner integral is `-phi`, the outer term is `cap * P(|G| >= cap)`.
    """
    if sigma == 0:
        raise ValueError("the cap form requires a non-zero sigma")
    with localcontext() as context:
        context.prec = WORKING_PRECISION
        standardised = cap / sigma
        body = 2 * sigma * (standard_normal_pdf(Decimal(0)) - standard_normal_pdf(standardised))
        tail = 2 * cap * (1 - standard_normal_cdf(standardised))
        return body + tail


def truncated_first_moment(lam: Decimal, sigma: Decimal) -> Decimal:
    """`dp/dlambda = E[ |G| * 1{ |G| <= 1/lambda } ]` for `G ~ N(0, sigma^2)`.

    The derivative of the fair premium in the leverage, and therefore the value of one lattice step
    of leverage error per unit of notional. This is the identity that sizes the publisher bond:
    at NVDA's overnight parameters it is 1.1119% of notional, which on $8.53M of committed depth is
    $94,849, and three times that rounds up to the $500,000 bond (paper §7.11, Table 19).
    """
    if sigma == 0:
        return Decimal(0)
    if lam == 0:
        return sigma * SQRT_TWO_OVER_PI
    with localcontext() as context:
        context.prec = WORKING_PRECISION
        standardised = (1 / lam) / sigma
        return 2 * sigma * (standard_normal_pdf(Decimal(0)) - standard_normal_pdf(standardised))


def _erf(z: Decimal) -> Decimal:
    """The error function, to working precision.

    Odd in `z`, so only the magnitude is evaluated. Below the breakpoint the Maclaurin series
    `erf(z) = (2/sqrt(pi)) * sum (-1)^n z^(2n+1) / (n! (2n+1))` is used; above it the complementary
    function is taken from the continued fraction, because the series suffers catastrophic
    cancellation in the tail while the fraction does not.
    """
    with localcontext() as context:
        context.prec = WORKING_PRECISION
        if z == 0:
            return Decimal(0)
        if z < 0:
            return -_erf(-z)
        if z <= SERIES_BREAKPOINT:
            return _erf_series(z)
        return 1 - _erfc_continued_fraction(z)


def _erf_series(z: Decimal) -> Decimal:
    """Maclaurin series for `erf`, valid without cancellation up to `SERIES_BREAKPOINT`."""
    total = z
    term = z
    square = z * z
    for n in range(1, _SERIES_MAX_TERMS):
        term = -term * square / n
        contribution = term / (2 * n + 1)
        total += contribution
        if abs(contribution) < _CONTINUED_FRACTION_EPSILON:
            break
    return TWO_OVER_SQRT_PI * total


def _erfc_continued_fraction(z: Decimal) -> Decimal:
    """`erfc(z)` from `erfc(z) = exp(-z^2) / sqrt(pi) * 1/(z + 1/2/(z + 1/(z + 3/2/(z + ...))))`.

    Evaluated by the modified Lentz algorithm, which is numerically stable for this fraction.
    """
    numerator = (-z * z).exp() / SQRT_PI
    fraction = z
    c = fraction
    d = Decimal(0)
    for n in range(1, _CONTINUED_FRACTION_MAX_TERMS):
        a = Decimal(n) / 2
        d = z + a * d
        if d == 0:
            d = _TINY
        c = z + a / c
        if c == 0:
            c = _TINY
        d = 1 / d
        delta = c * d
        fraction *= delta
        if abs(delta - 1) < _CONTINUED_FRACTION_EPSILON:
            break
    return numerator / fraction
