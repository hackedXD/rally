import { rallyToSeven } from '../scoring.js';
import type { SportModule } from '../sport.js';
import { rallyEvents } from './rally-events.js';

/**
 * The same object as pickleball with a smaller court, a faster ball, a lower
 * net, a tighter strike window and different jargon. That is the entire diff —
 * which is the point: table tennis proves the abstraction cheaply.
 *
 * The court is scaled up from a real 2.74 m table by about 2.6x, because a real
 * table on a 115 ms strike window over a network is not a game, it is a coin
 * flip. Treat it as table tennis played by giants.
 *
 * IMPORTANT: scaling a court up means scaling drag DOWN. Drag per metre goes as
 * 1/length, so a real ping-pong ball's 0.11 carried onto a 2.6x court makes the
 * ball lose three quarters of its speed crossing the table, and every trajectory
 * has to be lobbed to clear the net. Ball radius is scaled up to match for the
 * same reason — a 20 mm sphere is invisible on a 7 m court.
 */
export const tabletennis: SportModule = {
  id: 'tabletennis',
  displayName: 'Table Tennis',
  rallyBased: true,
  playable: true,
  tagline: 'Smaller court, faster ball, tighter window. Same code.',

  court: {
    length: 7.2,
    width: 3.3,
    netHeight: 0.34,
    nonVolleyZone: 0,
    surround: 2.4,
    tableHeight: 0.76,
  },

  ball: {
    radius: 0.05,
    restitution: 0.86,
    // 0.11 for a real ball, divided by the 2.6x court scale.
    dragK: 0.042,
    gravityScale: 1.0,
    friction: 0.84,
  },

  strike: {
    windowMs: 115,
    aimToleranceDeg: 70,
    minReturn: 5,
    maxReturn: 16,
    // The ball is met just above the table, which puts contact BELOW the tape —
    // so every shot has to be lifted, and net errors become possible again.
    contactHeight: 0.34,
    paceMin: 2.5,
    paceMax: 8.0,
    reachDepth: 0.85,
    flightScale: 0.6,
  },

  serve: { underhandOnly: false, faults: 1, doubleBounceRule: true, mustClearKitchen: false },

  // Real table tennis plays to 11. Rally-to-7 is the locked scoring decision for
  // every sport here, and at these rally lengths 11 would put the match well past
  // the 90-second target.
  scoring: rallyToSeven,

  persona: {
    energy: 0.95,
    snark: 0.6,
    jargon: ['chop', 'loop', 'the pips', 'service', 'counter-hit', 'block'],
    blurb:
      'Table tennis: the fastest ball game on earth, here rendered at a scale ' +
      'where humans can still see it.',
  },

  classifyEvents: rallyEvents,
};
