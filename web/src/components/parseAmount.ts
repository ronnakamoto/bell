/** Parse a UI amount as a non-empty digit string into a bigint. */
export function parseDigitAmount(raw: string): bigint {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error('Enter a non-empty integer (digits only).');
  }
  return BigInt(raw);
}
