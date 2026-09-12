import { rallyToSeven } from '../scoring.js';
import type { SportModule } from '../sport.js';
import { rallyEvents } from './rally-events.js';

/**
 * The primary sport. Real court dimensions, arcade rules.
 */
export const pickleball: SportModule = {
  id: 'pickleball',
  displayName: 'Pickleball',
  rallyBased: true,
  playable: true,
  tagline: 'Regulation court. Rally to 7. Mind the kitchen.',

  court: {
    length: 13.41,
    width: 6.1,
    netHeight: 0.86,
    nonVolleyZone: 2.13,
    surround: 3.2,
    tableHeight: 0,
  },

  ball: {
    radius: 0.037,
    restitution: 0.72,
    dragK: 0.04,
    gravityScale: 1.0,
    friction: 0.78,
  },

  strike: {
    windowMs: 140,
    aimToleranceDeg: 60,
    minReturn: 6,
    maxReturn: 18,
    contactHeight: 0.78,
    paceMin: 3.0,
    paceMax: 9.5,
    reachDepth: 1.6,
    flightScale: 1.0,
  },

  serve: { underhandOnly: true, faults: 1, doubleBounceRule: false, mustClearKitchen: true },

  scoring: rallyToSeven,

  persona: {
    energy: 0.8,
    snark: 0.7,
    jargon: ['dink', 'the kitchen', 'pickle', 'third shot drop', 'ATP', 'erne', 'banger'],
    blurb:
      'Pickleball: a sport where grown adults shout "kitchen" at each other ' +
      'and mean it sincerely.',
  },

  classifyEvents: rallyEvents,
};
