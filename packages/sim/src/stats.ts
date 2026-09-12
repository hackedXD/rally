/**
 * Running match statistics.
 *
 * This exists for the commentary system. `facts` is what makes commentary feel
 * like it's watching, and facts are derived from exactly these counters — so
 * count generously. Every field here is something a commentator could say out
 * loud without sounding like a box score.
 */

import type { ShotType, Seat } from '@rally/protocol';
import { SHOT_TYPES } from '@rally/protocol';

export interface SeatStats {
  hits: number;
  whiffs: number;
  consecutiveWhiffs: number;
  serves: number;
  serveFaults: number;
  netErrors: number;
  outErrors: number;
  doubleBounces: number;
  pointsWon: number;
  pointsInARow: number;
  /** Best run of consecutive points this match. */
  bestRun: number;
  longestRally: number;
  swingSpeedSum: number;
  swingCount: number;
  shots: Record<ShotType, number>;
  /** Winners hit: shots that directly ended a point in their favour. */
  winners: number;
}

export interface MatchStats {
  perSeat: Record<number, SeatStats>;
  rallies: number;
  longestRally: number;
  longestRallyMs: number;
  totalShots: number;
  /** Largest lead either side has held. */
  biggestLead: number;
  startedAt: number;
}

function emptySeat(): SeatStats {
  const shots = {} as Record<ShotType, number>;
  for (const t of SHOT_TYPES) shots[t] = 0;
  return {
    hits: 0,
    whiffs: 0,
    consecutiveWhiffs: 0,
    serves: 0,
    serveFaults: 0,
    netErrors: 0,
    outErrors: 0,
    doubleBounces: 0,
    pointsWon: 0,
    pointsInARow: 0,
    bestRun: 0,
    longestRally: 0,
    swingSpeedSum: 0,
    swingCount: 0,
    shots,
    winners: 0,
  };
}

export function emptyStats(startedAt = 0): MatchStats {
  return {
    perSeat: { 0: emptySeat(), 1: emptySeat() },
    rallies: 0,
    longestRally: 0,
    longestRallyMs: 0,
    totalShots: 0,
    biggestLead: 0,
    startedAt,
  };
}

export function avgSwingSpeed(s: SeatStats): number {
  return s.swingCount === 0 ? 0 : s.swingSpeedSum / s.swingCount;
}

/** Most-used shot type, or null before anyone has hit anything interesting. */
export function signatureShot(s: SeatStats): ShotType | null {
  let best: ShotType | null = null;
  let bestN = 1;
  for (const t of SHOT_TYPES) {
    if (t === 'serve' || t === 'rally') continue;
    if (s.shots[t] > bestN) {
      bestN = s.shots[t];
      best = t;
    }
  }
  return best;
}

export function errorSummary(s: SeatStats): string {
  return `net ${s.netErrors}, out ${s.outErrors}, missed ${s.doubleBounces}, whiff ${s.whiffs}`;
}

export function cloneStats(s: MatchStats): MatchStats {
  return {
    ...s,
    perSeat: {
      0: { ...s.perSeat[0], shots: { ...s.perSeat[0].shots } },
      1: { ...s.perSeat[1], shots: { ...s.perSeat[1].shots } },
    },
  };
}

export function seatOf(stats: MatchStats, seat: Seat): SeatStats {
  return stats.perSeat[seat] ?? emptySeat();
}
