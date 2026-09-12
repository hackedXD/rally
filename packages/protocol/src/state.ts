/**
 * World state. These types travel on the wire inside `SNAPSHOT`, so field names
 * are short on purpose — snapshots go out at 30 Hz to every display.
 */

import type { Millis, Quat, Seat, SportId, Vec3 } from './primitives.js';

export interface BallState {
  p: Vec3; // position, metres, court-centre origin
  v: Vec3; // velocity, m/s
  spin: number; // -1 slice .. +1 topspin. Reserved; unused in v1.
  /** Bounces since the ball last crossed the net. Drives the double-bounce rule. */
  b: number;
  /** Seat that struck the ball last, or null for a ball nobody has touched. */
  owner: Seat | null;
}

export type PlayerAnim = 'idle' | 'wind' | 'swing' | 'whiff' | 'celebrate';

export interface PlayerState {
  seat: Seat;
  name: string;
  p: Vec3; // auto-positioned by the sim
  paddleQ: Quat; // world-frame paddle orientation
  anim: PlayerAnim;
  connected: boolean;
  /** True when this seat is driven by the built-in bot rather than a phone. */
  bot: boolean;
}

export interface ScoreState {
  points: [number, number];
  server: Seat;
  gamePoint: boolean;
  /** Seat that holds game point, when `gamePoint` is true. */
  gamePointSeat: Seat | null;
}

export type MatchPhase = 'lobby' | 'serve' | 'rally' | 'point' | 'gameover' | 'paused';

/** Telegraph for the receiving player's UI. Present only during 'rally'/'serve'. */
export interface StrikeTelegraph {
  seat: Seat;
  tIdeal: Millis;
  /** Contact point the sim has predicted. The display closes its ring here. */
  p: Vec3;
  /** True once the strike window is open, i.e. a swing now would connect. */
  open: boolean;
  /**
   * 0..1 — how hard this ball is to return. Pace, how far the receiver had to
   * cover, and an awkward contact height all raise it, and a higher value
   * tightens the strike window. This is the game's only real source of
   * difficulty: players auto-position, so "hard to reach" has to be expressed as
   * "hard to time" instead. The display draws the telegraph ring thinner as it
   * rises, which is the whole tutorial.
   */
  difficulty: number;
}

/**
 * Visual reconciliation instruction (§8.3.2 step 4). When the sim registers a
 * hit it tells the display to drive the paddle through the real contact point
 * rather than keep rendering the raw phone pose — the player's hand was
 * probably 20 cm off and the screen must never show a paddle swiping through
 * empty air while the ball rockets away.
 */
export interface Reconcile {
  seat: Seat;
  /** Server time the contact happened. */
  t: Millis;
  /** World-space point the paddle must pass through. */
  p: Vec3;
  /** Paddle orientation at contact, as the sim resolved it. */
  q: Quat;
  /** 'hit' drives through the ball; 'whiff' exaggerates the swing past it. */
  kind: 'hit' | 'whiff';
}

export interface Snapshot {
  tick: number;
  t: Millis;
  phase: MatchPhase;
  ball: BallState | null;
  players: PlayerState[];
  score: ScoreState;
  strike?: StrikeTelegraph;
  reconcile?: Reconcile;
  /** Shots in the current rally. Drives the on-screen rally counter. */
  rally: number;
  /** Server time the current phase began — display countdowns read this. */
  phaseT: Millis;
}

// ── Sport specification ───────────────────────────────────────────────────────

export interface CourtSpec {
  /** Total length, baseline to baseline, metres. */
  length: number;
  width: number;
  netHeight: number;
  /** Kitchen depth from the net, metres. 0 for sports without one. */
  nonVolleyZone: number;
  /** Visual floor extent beyond the lines, metres. */
  surround: number;
  /** Table height, for table tennis. 0 means the court is on the floor. */
  tableHeight: number;
}

export interface BallSpec {
  radius: number;
  restitution: number;
  dragK: number;
  gravityScale: number;
  /** Tangential velocity retained on a bounce. */
  friction: number;
}

/**
 * Per-sport strike constants. These live on the sport rather than in global
 * tuning because they are the numbers that actually differ between sports —
 * where the ball is comfortable to meet, how fast it arrives, how far a player
 * can stretch. Leaving them global makes table tennis silently inherit
 * pickleball's geometry, and the symptom is a rally that never ends.
 *
 * `reset(sport)` writes them into the live TUNING object so that the single
 * source of truth at read time stays single.
 */
export interface StrikeTuning {
  windowMs: number;
  aimToleranceDeg: number;
  minReturn: number;
  maxReturn: number;
  /** Comfortable contact height ABOVE THE PLAYING SURFACE, metres. */
  contactHeight: number;
  /** Arrival speeds, m/s, mapping to zero and full pace difficulty. */
  paceMin: number;
  paceMax: number;
  /** How far past the baseline or table edge a player can still reach, metres. */
  reachDepth: number;
  /**
   * Per-sport multiplier on flight time, composed with the global
   * `TUNING.shot.flightScale`. A small court needs proportionally quick
   * trajectories: a one-second rally ball is right for a 13 m pickleball court
   * and absurdly floaty on a 7 m table.
   */
  flightScale: number;
}

export interface ServeSpec {
  underhandOnly: boolean;
  /** Faults allowed before the point is conceded. */
  faults: number;
  doubleBounceRule: boolean;
  /** Serve must land beyond the non-volley zone. */
  mustClearKitchen: boolean;
}

export interface PersonaSpec {
  energy: number;
  snark: number;
  jargon: string[];
  /** Shown in the lobby, and handed to the commentary writer as framing. */
  blurb: string;
}

export interface SportMeta {
  id: SportId;
  displayName: string;
  rallyBased: boolean;
  /** Lobby copy. */
  tagline: string;
  /** False for sports that ship only as a compiling interface stub. */
  playable: boolean;
}
