/**
 * `GameEvent` is the seam between the game and the commentary system. The
 * simulation emits them; the commentary director consumes them. Neither side
 * needs to know anything else about the other.
 *
 * Populate `data` richly — it is the entire raw material the commentator has.
 * Thin events produce generic commentary.
 */

import type { Millis, Seat } from './primitives.js';

/**
 * Every enum in the protocol is declared ONCE, as a const array, with the union
 * type derived from it. Declaring the union separately means the Zod schema can
 * only be as precise as a hand-kept cast, and the two drift.
 */
export const GAME_EVENT_TYPES = [
  'serve',
  'hit',
  'whiff',
  'net',
  'out',
  'bounce',
  'point',
  'rally_milestone',
  'streak',
  'comeback',
  'game_point',
  'match_end',
  'match_start',
  'double_bounce',
  'fault',
  /**
   * Nothing is happening and it has been a while.
   *
   * Every other event here is something that occurred. This one is the absence
   * of one, and it exists because silence is the failure mode a commentator
   * cannot cover for: a ball that has gone out and not come back, a player who
   * put their phone down, a serve nobody takes. The game sits there, and the
   * commentary sits there with it, and the room assumes the thing is broken.
   */
  'stall',
] as const;

export type GameEventType = (typeof GAME_EVENT_TYPES)[number];

export type EventData = Record<string, number | string | boolean>;

export interface GameEvent {
  id: string;
  t: Millis;
  type: GameEventType;
  seat?: Seat;
  data: EventData;
  /** 0..1 — how noteworthy. Drives whether commentary fires at all. */
  salience: number;
  /** Interrupt level. 3 interrupts everything. */
  priority: 0 | 1 | 2 | 3;
}

/**
 * Commentary cue classes. The cold bank is keyed by these, so adding a class
 * means adding a bank key and a classifier branch — nothing else.
 */
export const CUE_CLASSES = [
  'match.intro',
  'serve.normal',
  'serve.ace',
  'rally.long',
  'rally.epic',
  'hit.smash',
  'hit.dink',
  'hit.lob',
  'whiff.bad',
  'whiff.repeat',
  'net.hit',
  'out.long',
  'point.close',
  'point.blowout',
  'point.winner',
  'streak',
  'comeback',
  'gamepoint',
  'match.end',
  /** Play has stopped and nobody has noticed. See the `stall` event. */
  'stall.waiting',
  /** ...and it is now going on long enough to be funny. */
  'stall.long',
  /** The commentator teaching somebody the game. See `commentary/tutor.ts`. */
  'tutorial',
] as const;

export type CueClass = (typeof CUE_CLASSES)[number];

/** Shot silhouettes. Each needs a distinct sound and a distinct trajectory. */
export const SHOT_TYPES = [
  'serve',
  'drive',
  'dink',
  'lob',
  'smash',
  'rally',
] as const;

export type ShotType = (typeof SHOT_TYPES)[number];
