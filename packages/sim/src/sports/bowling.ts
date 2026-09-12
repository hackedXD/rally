/**
 * Bowling — INTERFACE STUB, deliberately.
 *
 * Bowling is the honest test of the sport abstraction: it is not rally-based, so
 * it cannot route through the rally loop at all. It needs a `TurnController`
 * instead. Shipping the compiling shape of that is worth as much as a
 * half-working bowling game and costs twenty minutes, so that is what this is.
 *
 * Everything below typechecks and the lobby lists it as unplayable. The pieces
 * a real implementation would need are named, typed, and left unimplemented on
 * purpose — `throwBall` and `scoreFrame` are where the work goes.
 */

import type { GameEvent, Seat, SwingInput, Vec3 } from '@rally/protocol';
import { makeRallyScoring } from '../scoring.js';
import type { SportModule } from '../sport.js';

/**
 * The seam a non-rally sport hangs from. The rally loop asks "who is receiving
 * and when do they contact"; a turn-based sport asks "whose turn is it and is
 * their throw finished". Same simulation host, different controller.
 */
export interface TurnController {
  /** Seat whose turn it is. */
  current(): Seat;
  /** Frames 1..10, two throws each, with the tenth-frame exception. */
  frame(): { index: number; throwsTaken: number };
  /** Feed a swing in as a throw. Returns the resolved lane outcome. */
  throwBall(seat: Seat, swing: SwingInput): LaneOutcome;
  /** Advance after a throw has fully resolved. */
  endThrow(): void;
  isComplete(): boolean;
  events(): GameEvent[];
}

export interface LaneOutcome {
  /** Pins knocked down by this throw, 0..10. */
  pins: number;
  strike: boolean;
  spare: boolean;
  /** Where the ball crossed the foul line, for rendering. */
  entry: Vec3;
  /** Lateral drift, metres, from the swing's aim. */
  drift: number;
}

export interface PinState {
  /** Ten pins, standing or not, in standard triangle order. */
  standing: boolean[];
  /** Pin positions in lane space, for the renderer. */
  at: Vec3[];
}

export const BOWLING_LANE = {
  length: 18.29,
  width: 1.05,
  /** Foul line to the head pin. */
  headPin: 17.6,
  pinSpacing: 0.305,
  gutterWidth: 0.24,
} as const;

export const bowling: SportModule = {
  id: 'bowling',
  displayName: 'Bowling',
  rallyBased: false,
  playable: false,
  tagline: 'Turn-based. Interface lands here; the lane does not, yet.',

  court: {
    length: BOWLING_LANE.length,
    width: BOWLING_LANE.width,
    netHeight: 0,
    nonVolleyZone: 0,
    surround: 1.2,
    tableHeight: 0,
    standBehind: 0,
  },

  ball: {
    radius: 0.108,
    restitution: 0.2,
    dragK: 0.02,
    gravityScale: 1,
    friction: 0.96,
    bounces: true,
  },

  strike: {
    windowMs: 400,
    aimToleranceDeg: 80,
    minReturn: 4,
    maxReturn: 11,
    contactHeight: 0.3,
    paceMin: 2,
    paceMax: 8,
    reachDepth: 0.5,
    reachHeight: 2.2,
    flightScale: 1.0,
  },

  serve: { underhandOnly: true, faults: 0, doubleBounceRule: false, mustClearKitchen: false },

  scoring: makeRallyScoring(300, 1),

  persona: {
    energy: 0.6,
    snark: 0.8,
    jargon: ['turkey', 'the pocket', 'gutter', 'split', 'tap', 'bagger'],
    blurb: 'Bowling: the only sport where the shoes are rented and so is the dignity.',
  },

  classifyEvents: () => [],
};
