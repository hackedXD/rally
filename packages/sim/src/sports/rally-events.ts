/**
 * Shared state-derived event classifier for the rally sports. Pickleball and
 * table tennis use the same function; only their constants differ.
 */

import type { GameEvent, Seat } from '@rally/protocol';
import { eventId, lane, otherSeat } from '@rally/protocol';
import type { DerivedState } from '../sport.js';
import { seatOf } from '../stats.js';

const RALLY_MILESTONES = [6, 10, 14, 20];

export function rallyEvents(prev: DerivedState, next: DerivedState): GameEvent[] {
  const out: GameEvent[] = [];

  // ── Rally length milestones ────────────────────────────────────────────────
  for (const m of RALLY_MILESTONES) {
    if (prev.rally < m && next.rally >= m) {
      out.push({
        id: eventId('rally_milestone'),
        t: next.t,
        type: 'rally_milestone',
        data: {
          shots: next.rally,
          durationMs: Math.round(next.t - next.rallyStartedAt),
          longestOfMatch: next.rally > next.stats.longestRally,
        },
        salience: Math.min(0.95, 0.4 + m * 0.03),
        priority: m >= 14 ? 2 : 1,
      });
    }
  }

  // ── Streaks ───────────────────────────────────────────────────────────────
  for (const seat of [0, 1] as Seat[]) {
    const before = seatOf(prev.stats, seat).pointsInARow;
    const after = seatOf(next.stats, seat).pointsInARow;
    if (after > before && after >= 3) {
      out.push({
        id: eventId('streak'),
        t: next.t,
        type: 'streak',
        seat,
        data: { seat, length: after, scoreAfter: next.score.points.join('-') },
        salience: Math.min(1, 0.5 + after * 0.1),
        priority: 2,
      });
    }
  }

  // ── Comebacks ─────────────────────────────────────────────────────────────
  if (prev.score.points.join() !== next.score.points.join()) {
    for (const seat of [0, 1] as Seat[]) {
      const other = otherSeat(seat);
      const wasBehindBy = prev.score.points[lane(other)] - prev.score.points[lane(seat)];
      const nowBehindBy = next.score.points[lane(other)] - next.score.points[lane(seat)];
      if (wasBehindBy >= 3 && nowBehindBy <= 0) {
        out.push({
          id: eventId('comeback'),
          t: next.t,
          type: 'comeback',
          seat,
          data: {
            seat,
            from: prev.score.points[lane(seat)],
            to: next.score.points[lane(seat)],
            deficit: wasBehindBy,
          },
          salience: 0.95,
          priority: 3,
        });
      }
    }
  }

  // ── Game point ────────────────────────────────────────────────────────────
  if (
    next.score.gamePoint &&
    next.score.gamePointSeat !== null &&
    (!prev.score.gamePoint || prev.score.gamePointSeat !== next.score.gamePointSeat)
  ) {
    const seat = next.score.gamePointSeat;
    out.push({
      id: eventId('game_point'),
      t: next.t,
      type: 'game_point',
      seat,
      data: {
        seat,
        scoreAfter: next.score.points.join('-'),
        matchPoint: true,
        servingSeat: next.score.server,
      },
      salience: 0.9,
      priority: 2,
    });
  }

  return out;
}
