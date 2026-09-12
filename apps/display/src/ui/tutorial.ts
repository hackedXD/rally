/**
 * The tutorial, as a list of things to do.
 *
 * It coaches over a REAL match against a deliberately weak bot rather than a
 * scripted sandbox, and that is the whole design. A sandbox has to be built,
 * kept in step with the game, and then thrown away by the player the moment it
 * ends — and the thing it teaches is the sandbox. Here every step is satisfied
 * by the same events and snapshots the scoreboard already reads, so the tutorial
 * is a reading of the game rather than a second copy of it, and the first thing
 * the player does is play.
 *
 * It also means the tutorial cannot drift: if serving changes, the serve step
 * changes with it, because the step is "the sim emitted a serve from your seat".
 *
 * ── The checklist is cumulative, and that is load-bearing ────────────────────
 *
 * A step asks "have you done this yet?", never "have you done this since I
 * asked?". The difference is not pedantic. Serving comes round every few points
 * and the game serves for you if you wait, so a player who happens to serve
 * while still reading step one would, under the stricter reading, have that
 * serve discarded and then sit on "swing to serve" through two more points of
 * somebody else's service. The tutorial would look broken while the player was
 * doing everything right.
 */

import type { GameEvent, MatchPhase, Seat, SportId } from '@rally/protocol';
import { lane } from '@rally/protocol';

export interface TutorialStep {
  id: string;
  /** The instruction, in the imperative. Short — it is read mid-game. */
  title: string;
  /**
   * One line of why, or what to expect.
   *
   * A function when the line should react to how it is going. A tutorial that
   * repeats the same sentence while the player misses for the fifth time is not
   * coaching, it is nagging.
   */
  detail?: string | ((ctx: StepContext) => string);
  /** Advance when this returns true. */
  done(ctx: StepContext): boolean;
}

export interface StepContext {
  /** Event types seen from this seat since the tutorial began. */
  mine: ReadonlySet<GameEvent['type']>;
  phase: MatchPhase;
  /** Longest rally reached so far, shots. */
  bestRally: number;
  /**
   * How far this seat's racket has been TURNED since the tutorial began,
   * radians.
   *
   * Orientation, not position, and the distinction matters: in every sport but
   * table tennis the player's position is chosen by the simulation, so a step
   * watching where they are would tick itself the moment a rally started and
   * congratulate the player for something the game did. Orientation is the thing
   * the hand actually controls, in all of them.
   */
  aimed: number;
  /** Swings this seat has missed entirely. Lets a step notice a player struggling. */
  whiffs: number;
  /** Seconds the CURRENT step has been showing. */
  elapsed: number;
}

/**
 * How long an instruction stays up before it is allowed to complete.
 *
 * Without it a cumulative checklist can tick three boxes in one frame — the
 * player serves, and "move to aim", "swing to serve" and "return one" all go
 * green together, having shown nothing long enough to read. This is the floor on
 * being able to read a sentence.
 */
export const MIN_DWELL_S = 1.6;

/**
 * How far the racket must turn to count as "you moved it", radians.
 *
 * About fifteen degrees: far more than the degree or two of jitter a phone
 * reports while being held still, and well inside one deliberate move.
 *
 * Measured against the MOUSE controller rather than a phone, because the mouse
 * is the tighter constraint — it maps the whole aim range onto a screen, so two
 * full sweeps of it came to only 0.4 radians. A threshold a phone clears
 * instantly can still strand somebody playing with a mouse.
 */
export const AIM_TURN_RAD = 0.25;

/** Misses before a step starts offering a more specific hint. */
export const STRUGGLING = 3;

/**
 * How long a player may sit on one step before the commentator says it again,
 * differently, seconds.
 *
 * Long enough that somebody working at it is not interrupted, short enough that
 * somebody who did not catch the instruction is not left guessing. A tutorial
 * whose voice says a thing exactly once is a tutorial that fails everybody who
 * looked away.
 */
export const NUDGE_AFTER_S = 13;

export function tutorialSteps(sport: SportId): TutorialStep[] {
  const pingpong = sport === 'tabletennis';

  const aim: TutorialStep = pingpong
    ? {
        id: 'aim',
        title: 'Tilt to move the bat',
        detail: 'The bat goes where you point the phone — across, and up and down.',
        done: (c) => c.aimed > AIM_TURN_RAD,
      }
    : {
        id: 'aim',
        title: 'Move to aim',
        detail: 'Your paddle follows your hand. Point it where the ball is going.',
        done: (c) => c.aimed > AIM_TURN_RAD,
      };

  /**
   * Table tennis is a different game and needs different words. Everywhere else
   * the player is auto-positioned onto the ball and the only question is timing,
   * which is exactly what the closing ring teaches. In table tennis you put the
   * bat where the ball is and the wing you play it with counts — and there is no
   * ring at all, so a tutorial that mentioned one would be teaching a control
   * that is not on screen.
   */
  const contact: TutorialStep = pingpong
    ? {
        id: 'contact',
        title: 'Return one',
        detail: (c) =>
          c.whiffs >= STRUGGLING
            ? 'Still missing? Get the bat to the ball first — the swing is the easy half.'
            : 'A ball on your backhand side needs a backhand. Put the bat on it.',
        done: (c) => c.mine.has('hit'),
      }
    : {
        id: 'contact',
        title: 'Watch the ring, then swing',
        detail: (c) =>
          c.whiffs >= STRUGGLING
            ? 'Still missing? Swing as the ring MEETS the circle, not when you see the ball.'
            : 'It closes at the moment to hit. A thinner ring means a harder ball.',
        done: (c) => c.mine.has('hit'),
      };

  return [
    aim,
    {
      id: 'serve',
      title: 'Swing to serve',
      detail: pingpong
        ? 'The ball is tossed for you. Swing through it.'
        : 'Any swing will do. The game meets you more than halfway.',
      done: (c) => c.mine.has('serve'),
    },
    contact,
    {
      id: 'rally',
      title: 'Keep it going',
      detail: 'Four shots in one rally. Nothing fancy — just get it back.',
      done: (c) => c.bestRally >= 4,
    },
    {
      id: 'point',
      title: 'Win a point',
      detail: pingpong
        ? 'Brush up the back of the ball for topspin. It dips, and it lands.'
        : 'Aim away from them. Where they are not is where the point is.',
      done: (c) => c.mine.has('point'),
    },
    {
      id: 'done',
      title: "That's the game",
      detail: 'The rest is practice. Good luck.',
      // Nothing to do: it holds for a beat and dismisses itself.
      done: (c) => c.elapsed > 4.5,
    },
  ];
}

/**
 * Did this event belong to the given seat?
 *
 * `point` is the awkward one: it names its winner in the data rather than in the
 * seat field on some paths, and without that branch "win a point" never
 * completes for the person who won it.
 */
export function isMine(e: GameEvent, seat: Seat): boolean {
  if (e.type === 'point') {
    const w = e.data.winner;
    return typeof w === 'number' && lane(w as Seat) === lane(seat);
  }
  return e.seat !== undefined && lane(e.seat) === lane(seat);
}
