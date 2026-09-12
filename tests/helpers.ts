import {
  Bot,
  Match,
  emptyTickInput,
  getSport,
  makeRng,
  type BotView,
} from '@rally/sim';
import { TUNING, type GameEvent, type Seat, type SportId, type Snapshot } from '@rally/protocol';

export const DT = 1 / TUNING.net.tickHz;

export interface PlayResult {
  match: Match;
  snapshots: Snapshot[];
  seconds: number;
  events: GameEvent[];
}

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
  const match = new Match({ sport, seed, names: ['Ace', 'Bolt'], bots: [true, true] });
  const rng = makeRng(seed ^ 0x9e3779b9);
  const skill = opts.skill ?? 0.6;
  const bots: Bot[] = [new Bot(0, rng, skill), new Bot(1, rng, skill)];
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
