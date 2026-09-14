"""The pure domain: gap classification, the truncated moment, the leverage rule, the digest layout.

Nothing here performs I/O, reads a clock, or imports a third-party package. Every function is
testable by calling it with literal arguments, which is the test the brief applies to decide whether
something belongs in this layer.
"""

__all__ = ["digest", "leverage", "models", "moments", "ports", "sessions"]
