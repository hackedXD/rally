/**
 * Identifier generation. Lives in `protocol` so the server and the tools agree
 * on room-code and cue-id shapes.
 *
 * Note: these functions read the RNG, so they are NOT importable from `sim` or
 * `motion` (coding standard 1 — those packages take randomness as a parameter).
 */

import { ROOM_ALPHABET } from './schemas.js';

export function roomCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  }
  return out;
}

const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function shortId(length = 10, rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i++) out += B62[Math.floor(rand() * B62.length)];
  return out;
}

let cueCounter = 0;

/** Cue ids stay short and ASCII: they go in a binary frame header. */
export function cueId(prefix: string): string {
  cueCounter = (cueCounter + 1) % 1_000_000;
  return `${prefix}-${cueCounter.toString(36)}`;
}

let eventCounter = 0;

export function eventId(type: string): string {
  eventCounter = (eventCounter + 1) % 1_000_000;
  return `${type}:${eventCounter.toString(36)}`;
}
