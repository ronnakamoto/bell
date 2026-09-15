/**
 * The raw log, and the accessors that read one.
 *
 * A log arrives as three opaque strings and nothing else. Everything the indexer knows about a session
 * is recovered from them, so this module's job is to make the recovery *checkable* rather than
 * plausible: every accessor either returns a value the ABI guarantees or throws naming the index it
 * could not read.
 *
 * **Two properties of the wire form were observed rather than assumed, and both are load-bearing.**
 * `vm.getRecordedLogsJson()` — the producer of `spec/fixtures/logs.json`, and therefore the only form
 * the indexer is verified against — renders `topics` and `data` as lower-case hex while rendering
 * `emitter` EIP-55 checksummed. So the same address appears in two cases in one log record.
 *
 * That matters more than a cosmetic detail. Session events (`PoolSeeded`, `Traded`, `Settled`) carry
 * no session identifier at all; they are attributed to a session by the address that emitted them,
 * and the only way that address is known is by reading it out of `SessionCreated`. If the emitter were
 * compared as it arrives against a topic-derived address, the comparison would fail on case alone for
 * every session event, and the symptom would be a catalogue that is quietly empty rather than an
 * error. `addressKey` is therefore the *only* form any address is compared or stored in, and
 * `emitterKey` is the only way to read a log's sender.
 *
 * **The third property is a refusal.** An indexed *reference* type is not encoded in the topic, it is
 * hashed into it — so a topic holding `keccak256` of a string, a `bytes` or a struct is 32 bytes of
 * digest and looks exactly like a 32-byte value. Nothing here can detect that, and nothing here tries;
 * the taxonomy declares which parameters are addresses, and reading one as the other is caught by the
 * padding assertion below rather than by a guess.
 */

import { DomainError } from '@bell/calibrator/domain/models.js';

/** One log as a source yields it, before anything has been interpreted. */
export interface RawLog {
  /** `topics[0]` is the event's signature hash; the rest are its indexed parameters. */
  readonly topics: readonly string[];
  /** The ABI-encoded non-indexed parameters, as `0x`-prefixed hex. */
  readonly data: string;
  /** The contract that emitted it. */
  readonly emitter: string;
}

/** A 32-byte word, as `0x`-prefixed lower-case hex. */
export type Word = string;

/** An address in the one form the indexer compares and stores. */
export type AddressKey = string;

const WORD_HEX_DIGITS = 64;
const ADDRESS_HEX_DIGITS = 40;
const TOPIC_PADDING_HEX_DIGITS = WORD_HEX_DIGITS - ADDRESS_HEX_DIGITS;

const TWO_256 = 1n << 256n;
const TWO_255 = 1n << 255n;

/**
 * Normalise an address for comparison, and the reason every comparison is case-insensitive.
 *
 * Lower case rather than checksummed, because the checksum is a property of how a string was written
 * and not of the address: two renderings of one address are one address, and EIP-55's mixed case
 * exists to make a *typo* visible to a human, which is a job it cannot do for a machine that never
 * displays anything.
 */
export function addressKey(address: string): AddressKey {
  return address.toLowerCase();
}

/** The emitting address of a log, normalised. The only way to read one. */
export function emitterKey(log: RawLog): AddressKey {
  return addressKey(log.emitter);
}

/**
 * The hex body of a `0x`-prefixed string, refusing one that is not prefixed.
 *
 * The prefix is required, and it was optional while this was being written. Every producer of a log is
 * a machine — an RPC, or `vm.getRecordedLogsJson()` — and both always prefix, so the tolerance only
 * ever admitted input that was already wrong. For a reader of logs that is the wrong direction to be
 * lenient in: a record that had lost its prefix is a record that has been truncated, hand-edited or
 * read from the wrong field, and decoding it would produce a plausible value from a malformed input.
 */
function bodyOf(text: string): string {
  if (!text.startsWith('0x')) {
    throw new DomainError(`a word is 0x-prefixed hex, got "${text.slice(0, 4)}"`);
  }
  return text.slice(2);
}

/**
 * Validate a 32-byte word and lower-case it.
 *
 * The length is asserted rather than assumed because every other accessor slices this string by
 * position, and a slice of the wrong length produces a *shorter* value rather than an error — an
 * address missing its leading zeros, or a `bigint` built from `0x` plus half a word.
 */
export function asWord(text: string): Word {
  const body = bodyOf(text);
  if (body.length !== WORD_HEX_DIGITS) {
    throw new DomainError(`a word is 32 bytes, got ${String(body.length / 2)}`);
  }
  return `0x${body.toLowerCase()}`;
}

/** The topic at `index`, or a failure naming it. */
export function topicAt(log: RawLog, index: number): Word {
  const topic = log.topics[index];
  if (topic === undefined) {
    throw new DomainError(
      `log from ${addressKey(log.emitter)} has ${String(log.topics.length)} topics, no topic ${String(index)}`,
    );
  }
  return asWord(topic);
}

/** The `index`-th 32-byte word of the data section, or a failure naming it. */
export function wordAt(log: RawLog, index: number): Word {
  const body = bodyOf(log.data);
  const at = index * WORD_HEX_DIGITS;
  if (at + WORD_HEX_DIGITS > body.length) {
    throw new DomainError(
      `log data is ${String(body.length / 2)} bytes, so it has no word ${String(index)}`,
    );
  }
  return asWord(`0x${body.slice(at, at + WORD_HEX_DIGITS)}`);
}

/**
 * The address in a word, refusing a word that is not an address.
 *
 * The top twelve bytes of an ABI-encoded address are zero, and requiring them to be is the one check
 * that distinguishes an address from a `bytes32` in the same position. It is not defensive noise: the
 * premium store's `Resolved` carries `bytes32 indexed nameId` where the registry's carries
 * `address indexed session`, the two share a name, and a decoder that read the wrong one would produce
 * a 20-byte prefix of a name id — a plausible-looking address that matches no session, and therefore a
 * silently empty catalogue rather than a failure.
 */
function addressOf(word: Word): AddressKey {
  const body = word.slice(2);
  const padding = body.slice(0, TOPIC_PADDING_HEX_DIGITS);
  if (padding !== '0'.repeat(TOPIC_PADDING_HEX_DIGITS)) {
    throw new DomainError(`not an ABI-encoded address: ${word} has a non-zero prefix`);
  }
  return `0x${body.slice(TOPIC_PADDING_HEX_DIGITS)}`;
}

/** The address in an indexed address parameter. */
export function addressOfTopic(log: RawLog, index: number): AddressKey {
  return addressOf(topicAt(log, index));
}

/** The address in a non-indexed address parameter. */
export function addressOfWord(log: RawLog, index: number): AddressKey {
  return addressOf(wordAt(log, index));
}

/**
 * A `uintN` as an exact integer.
 *
 * `BigInt('0x…')` rather than a radix argument, and that is not a style preference: the domain bans
 * the string-to-number parsers because each produces an IEEE-754 double, and a uint64 above 2^53 read
 * through one would be silently rounded. `BigInt` on a hex string is exact at any width.
 */
export function uintOf(word: Word): bigint {
  return BigInt(word);
}

/**
 * An `intN` as an exact integer, two's complement at 256 bits.
 *
 * The gap and the payoff are both signed in the registry's `Resolved`, and a gap is negative about
 * half the time. Read as unsigned, a negative gap becomes a number near 2^256 — which is not merely
 * wrong but *plausibly* wrong, because it is still a positive integer of the right scale for a WAD.
 */
export function intOf(word: Word): bigint {
  const value = uintOf(word);
  return value >= TWO_255 ? value - TWO_256 : value;
}

/**
 * A `bool` as a boolean, refusing anything that is not 0 or 1.
 *
 * Solidity writes exactly 0 or 1 for a `bool`, so a third value means the word was not a bool —
 * typically a neighbouring parameter read at the wrong index.
 */
export function boolOf(word: Word): boolean {
  const value = uintOf(word);
  if (value === 0n) return false;
  if (value === 1n) return true;
  throw new DomainError(`not an ABI-encoded bool: ${word}`);
}

/** A `bytes32` as the word it is. The accessor exists so a `bytes32` is never read as an address. */
export function bytes32OfTopic(log: RawLog, index: number): Word {
  return topicAt(log, index);
}

/** A `uint64` as a `bigint`, refusing a word wider than 64 bits. */
export function uint64Of(word: Word): bigint {
  const value = uintOf(word);
  if (value >= 1n << 64n) {
    throw new DomainError(`not an ABI-encoded uint64: ${word}`);
  }
  return value;
}
