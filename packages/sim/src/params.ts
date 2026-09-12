/**
 * Per-match resolved constants.
 *
 * Sport modules own the numbers that genuinely differ between sports, and the
 * obvious-looking way to apply them is to write them into the global `TUNING`
 * object on `reset(sport)`. That is a bug: the server hosts many rooms in one
 * process, so a table tennis match starting next door would silently rewrite a
 * pickleball match's strike window, contact height and flight scale mid-rally.
 *
 * So sport constants are resolved ONCE per match into this immutable object and
 * threaded explicitly. `TUNING` keeps everything that is genuinely global — tick
 * rates, assist curves, pressure weights — and stays the single place a tunable
 * number is written. Rebuild params with `resolveParams` after the live tuning
 * panel patches TUNING.
 */

import { TUNING } from '@rally/protocol';
import type { SportModule } from './sport.js';

export interface SimParams {
  /** Strike window, ms, before difficulty tightens it. */
  windowMs: number;
  aimToleranceDeg: number;
  /** Comfortable contact height above the playing surface, metres. */
  contactHeight: number;
  /** Arrival speeds, m/s, mapping to zero and full pace difficulty. */
  paceMin: number;
  paceMax: number;
  /** How far past the baseline a player can still reach, metres. */
  reachDepth: number;
  /** Global flight scale composed with the sport's own. */
  flightScale: number;
  minReturn: number;
  maxReturn: number;
  /** Physics timestep, seconds. Prediction must match the authoritative tick. */
  dt: number;
}

export function resolveParams(sport: SportModule): SimParams {
  const s = sport.strike;
  return {
    windowMs: s.windowMs,
    aimToleranceDeg: s.aimToleranceDeg,
    contactHeight: s.contactHeight,
    paceMin: s.paceMin,
    paceMax: s.paceMax,
    reachDepth: s.reachDepth,
    flightScale: TUNING.shot.flightScale * s.flightScale,
    minReturn: s.minReturn,
    maxReturn: s.maxReturn,
    dt: 1 / TUNING.net.tickHz,
  };
}
