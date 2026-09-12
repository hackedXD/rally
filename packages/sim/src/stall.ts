/**
 * Noticing that nothing is happening.
 *
 * Every other event in this package reports something the match did. This one
 * reports that it did not, and it exists because silence is the one failure a
 * commentator cannot cover for. A ball goes out and nobody fetches it; a player
 * puts their phone down to answer a message; somebody is waiting for a serve
 * that is not coming. The game sits there, the commentary sits there with it,
 * and the room concludes the thing is broken.
 *
 * Emitted by the engines rather than by `classifyEvents`, and that is not an
 * arbitrary choice: the shared engine only runs its diff classifier when
 * something has changed, so an event whose whole subject is "nothing changed"
 * could never fire from there.
 *
 * Both engines use this, so "how long is too long" is defined once.
 */

import { eventId, type GameEvent, type MatchPhase, type Millis, type Seat } from '@rally/protocol';

/**
 * When to say something, and how pointed to be about it.
 *
 * The first is a nudge, timed to land while a player is still plausibly about to
 * serve. The second is the joke, and it is deliberately before the sim's own
 * auto-serve at 12 s — the commentator should be the one who notices first, not
 * the one explaining what just happened.
 */
export const STALL_STEPS: readonly { afterMs: Millis; long: boolean }[] = [
  { afterMs: 5000, long: false },
  { afterMs: 9000, long: true },
];

export interface StallContext {
  t: Millis;
  /** When the current phase began. */
  phaseT: Millis;
  phase: MatchPhase;
  /** Whoever the game is waiting on. */
  seat: Seat;
  name: string;
}

/**
 * Per-match state for the watcher. One event per threshold per wait, so a long
 * one produces two remarks rather than sixty.
 */
export class StallWatch {
  private firedThrough = 0;
  private forPhaseT = -1;

  reset(): void {
    this.firedThrough = 0;
    this.forPhaseT = -1;
  }

  /** An event when the wait has just crossed a threshold, otherwise null. */
  check(ctx: StallContext): GameEvent | null {
    // Only while waiting to serve. A rally cannot stall — the ball is moving and
    // the rules end it — and the gap between points is short and already spoken
    // over.
    if (ctx.phase !== 'serve') {
      this.reset();
      return null;
    }
    if (ctx.phaseT !== this.forPhaseT) {
      this.firedThrough = 0;
      this.forPhaseT = ctx.phaseT;
    }
    const waited = ctx.t - ctx.phaseT;
    const step = STALL_STEPS[this.firedThrough];
    if (!step || waited < step.afterMs) return null;
    this.firedThrough++;

    return {
      id: eventId('stall'),
      t: ctx.t,
      type: 'stall',
      seat: ctx.seat,
      data: {
        seat: ctx.seat,
        player: ctx.name,
        waitedMs: Math.round(waited),
        waitedS: Math.round(waited / 1000),
        long: step.long,
      },
      // Above the salience floor on purpose: the entire point is that it gets
      // said. Priority stays low — a stall is by definition not urgent, and it
      // must never cut off a line about something that actually happened.
      salience: step.long ? 0.6 : 0.4,
      priority: 1,
    };
  }
}
