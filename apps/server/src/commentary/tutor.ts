/**
 * What the commentator says while teaching.
 *
 * ── Why the script is here and not on the display ────────────────────────────
 *
 * The display owns the CHECKLIST — what counts as done, and when to move on —
 * because those are readings of snapshots it already has. It does not own the
 * WORDS. Two reasons, and the second is the one that matters:
 *
 *   1. Every other line the commentator says is written on this side. A script
 *      that lived in the browser would be the only part of the commentator's
 *      voice that did not, and it would drift out of register the first time
 *      either half was edited alone.
 *
 *   2. A client that could post text straight into a text-to-speech engine is a
 *      client that can make the commentator say anything at all, out loud, in
 *      front of an audience. The wire carries a step NAME. An unknown one gets
 *      nothing said.
 *
 * ── Why these are not the words on the card ──────────────────────────────────
 *
 * The card says "Swing to serve": an imperative label you read once. Said out
 * loud that is a robot reading a manual. A commentator teaching the same thing
 * says something a person would say, and says it differently the second time —
 * which is what `nudge` is for. The card and the voice teach the same step in
 * the two registers that suit them.
 */

import type { SportId } from '@rally/protocol';

/** The steps the display can ask to be taught, matching `ui/tutorial.ts`. */
export const TUTOR_STEPS = ['intro', 'aim', 'serve', 'contact', 'rally', 'point', 'done'] as const;
export type TutorStep = (typeof TUTOR_STEPS)[number];

export function isTutorStep(s: string): s is TutorStep {
  return (TUTOR_STEPS as readonly string[]).includes(s);
}

interface Line {
  /** Said when the step comes up. */
  teach: string;
  /** Said if they are still on it a while later. Coaching, not repetition. */
  nudge: string;
}

const SHARED: Record<TutorStep, Line> = {
  intro: {
    teach: "Right, {player}. I'll talk you through it. Try not to embarrass us.",
    nudge: 'Still here. Still talking.',
  },
  aim: {
    teach: 'Move your hand. The paddle follows it. That is the whole control.',
    nudge: 'Any direction. I am not fussy.',
  },
  serve: {
    teach: 'Now swing. The game meets you more than halfway on a serve.',
    nudge: 'A swing. Any swing. We have all day, apparently.',
  },
  contact: {
    teach: 'Watch the ring on the court. When it closes, swing. Not before.',
    nudge: 'Swing as the ring MEETS the circle, not when you see the ball.',
  },
  rally: {
    teach: 'Four in a row now. Nothing clever — just get it back.',
    nudge: 'Back over the net is enough. Winners come later.',
  },
  point: {
    teach: 'Win one. Hit it where they are not, and it is yours.',
    nudge: 'Away from them, {player}. Where they are not.',
  },
  done: {
    teach: "That's the game. The rest is practice. Good luck.",
    nudge: 'Off you go.',
  },
};

/**
 * Table tennis is a different game and needs different words.
 *
 * Everywhere else the player is auto-positioned onto the ball and the only
 * question is timing, which the closing ring teaches. Here you put the bat where
 * the ball is, the wing you play it with counts, and there IS no ring — so the
 * shared lines would be coaching a control that is not on the screen.
 */
const PINGPONG: Partial<Record<TutorStep, Line>> = {
  aim: {
    teach: 'Tilt the phone. The bat goes where you point it — across, and up and down.',
    nudge: 'Tilt it. The bat is not going to move itself.',
  },
  serve: {
    teach: 'Ball is tossed for you. Swing through it.',
    nudge: 'Swing through the toss. It will wait, but I will not.',
  },
  contact: {
    teach: 'Get the bat TO the ball. On your backhand side, that means a backhand.',
    nudge: 'The bat first, the swing second. That is the order.',
  },
  point: {
    teach: 'Brush up the back of it. Topspin dips, and a ball that dips lands in.',
    nudge: 'Up the back of the ball, not through it.',
  },
};

/**
 * The line for a step, or nothing.
 *
 * `{player}` survives into the return value: the Director expands it the same
 * way it expands every other line, so a name with an apostrophe in it is handled
 * in exactly one place.
 */
export function coachLine(step: TutorStep, sport: SportId, nudge = false): string {
  const line = (sport === 'tabletennis' ? PINGPONG[step] : undefined) ?? SHARED[step];
  return nudge ? line.nudge : line.teach;
}
