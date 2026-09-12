/**
 * Scoring. Rally scoring to 7, win by 2 — not real pickleball rules, by design
 * (non-goal). The winner of a point serves the next one, which keeps momentum
 * legible on a scoreboard a spectator sees for five seconds.
 */

import type { ScoreState, Seat } from '@rally/protocol';
import { lane, otherSeat } from '@rally/protocol';

export interface ScoringModule {
  readonly pointsToWin: number;
  readonly winBy: number;
  award(score: ScoreState, winner: Seat): ScoreState;
  winner(score: ScoreState): Seat | null;
  /** Seat that wins the match with one more point, if any. */
  gamePointSeat(score: ScoreState): Seat | null;
  initial(firstServer: Seat): ScoreState;
}

export function makeRallyScoring(pointsToWin: number, winBy: number): ScoringModule {
  const mod: ScoringModule = {
    pointsToWin,
    winBy,

    initial(firstServer) {
      return { points: [0, 0], server: firstServer, gamePoint: false, gamePointSeat: null };
    },

    award(score, winner) {
      const points: [number, number] = [...score.points] as [number, number];
      points[lane(winner)] += 1;
      const next: ScoreState = {
        points,
        server: winner,
        gamePoint: false,
        gamePointSeat: null,
      };
      const gp = mod.gamePointSeat(next);
      next.gamePoint = gp !== null;
      next.gamePointSeat = gp;
      return next;
    },

    winner(score) {
      for (const seat of [0, 1] as Seat[]) {
        const mine = score.points[lane(seat)];
        const theirs = score.points[lane(otherSeat(seat))];
        if (mine >= pointsToWin && mine - theirs >= winBy) return seat;
      }
      return null;
    },

    gamePointSeat(score) {
      if (mod.winner(score) !== null) return null;
      for (const seat of [0, 1] as Seat[]) {
        const mine = score.points[lane(seat)] + 1;
        const theirs = score.points[lane(otherSeat(seat))];
        if (mine >= pointsToWin && mine - theirs >= winBy) return seat;
      }
      return null;
    },
  };
  return mod;
}

export const rallyToSeven = makeRallyScoring(7, 2);
export const rallyToEleven = makeRallyScoring(11, 2);
