import {
  Bot,
  Match,
  PingPongMatch,
  emptyTickInput,
  getSport,
  makeRng,
  type BotView,
  type MatchEngine,
} from '@rally/sim';
import { TUNING, type GameEvent, type Seat, type SportId, type Snapshot } from '@rally/protocol';

export const DT = 1 / TUNING.net.tickHz;

export interface PlayResult {
  match: MatchEngine;
  snapshots: Snapshot[];
  seconds: number;
  events: GameEvent[];
}

/**
 * One engine for a sport, bots seated, nothing started.
 *
 * The engine a sport runs on is a detail of the sport, and a test that picks the
 * wrong one is testing nothing — so the choice lives here, next to the same
 * choice `playMatch` makes.
 */
export function makeMatch(sportId: SportId, seed = 1234): { match: MatchEngine } {
  const sport = getSport(sportId);
  const match: MatchEngine =
    sportId === 'tabletennis'
      ? new PingPongMatch({ sport, seed, names: ['Ace', 'Bolt'], bots: [true, true] })
      : new Match({ sport, seed, names: ['Ace', 'Bolt'], bots: [true, true] });
  match.setBot(0, true, 0.5);
  match.setBot(1, true, 0.5);
  return { match };
}

/** A tick input that asks for nothing: no poses, no requests, not paused. */
export const tickInput = (t: number) => emptyTickInput(t);

/** Run a full bot-vs-bot match headlessly. */
export function playMatch(opts: {
  sport?: SportId;
  seed?: number;
  skill?: number;
  maxSeconds?: number;
  collectSnapshots?: boolean;
  onSnapshot?: (s: Snapshot) => void;
}): PlayResult {
  const sport = getSport(opts.sport ?? 'pickleball');
  const seed = opts.seed ?? 1234;
  const skill = opts.skill ?? 0.6;
  // Table tennis runs a different engine, and that engine steps its own bots —
  // there is no telegraph for an outside bot to read. Everything else about a
  // headless match is identical, which is the point of `MatchEngine`.
  const match: MatchEngine =
    sport.id === 'tabletennis'
      ? new PingPongMatch({ sport, seed, names: ['Ace', 'Bolt'], bots: [true, true] })
      : new Match({ sport, seed, names: ['Ace', 'Bolt'], bots: [true, true] });
  match.setBot(0, true, skill);
  match.setBot(1, true, skill);
  const rng = makeRng(seed ^ 0x9e3779b9);
  const bots: Bot[] = match.drivesOwnBots ? [] : [new Bot(0, rng, skill), new Bot(1, rng, skill)];
  const snapshots: Snapshot[] = [];
  const events: GameEvent[] = [];
  let t = 0;
  match.start(t);

  const limit = (opts.maxSeconds ?? 400) * TUNING.net.tickHz;
  for (let i = 0; i < limit && match.phase !== 'gameover'; i++) {
    t += DT * 1000;
    const tel = match.getTelegraph();
    const pred = match.getPrediction();
    for (const bot of bots) {
      const view: BotView = {
        phase: match.phase,
        telegraph: tel,
        serverSeat: match.getScore().server,
        court: sport.court,
        contact: pred?.p ?? null,
        contactHeight: pred?.p[1] ?? 0,
        difficulty: match.getDifficulty(),
        windowMs: match.getParams().windowMs,
      };
      const swing = bot.update(t, view);
      if (swing) match.applySwing(bot.seat, swing, match.phase === 'serve' ? t : swing.ctPeak);
    }
    const snap = match.step(DT, emptyTickInput(t));
    if (opts.collectSnapshots) snapshots.push(snap);
    opts.onSnapshot?.(snap);
    for (const e of match.drainEvents()) events.push(e);
  }
  return { match, snapshots, seconds: t / 1000, events };
}

export function finite(ns: readonly number[]): boolean {
  return ns.every((n) => Number.isFinite(n));
}

export const SEATS: Seat[] = [0, 1];
