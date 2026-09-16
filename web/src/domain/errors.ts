/**
 * Domain-level rejection for the web package.
 *
 * A named type rather than a bare `Error` so callers can distinguish "the domain rejected this
 * input" from unexpected failures.
 */
export class WebDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebDomainError';
  }
}
