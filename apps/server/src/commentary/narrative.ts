/**
 * The Director's memory.
 *
 * Novelty comes from state, not from prompting harder. This accumulates
 * concrete, quotable facts about how the match has actually gone, and it is the
 * difference between a commentator that sounds like it is watching and one that
 * sounds like it was handed a scoreboard.
 *
 *   facts        what makes the commentary feel like it's watching
 *   recentQuips  what stops it repeating itself
 *   runningBits  what makes a 90-second match feel authored — a nickname coined
 *                at point 2 and called back at match point
 */

import {
  TUNING,
  lane,
  otherSeat,
  type GameEvent,
  type Seat,
  type ShotType,
} from '@rally/protocol';
import { avgSwingSpeed, signatureShot, type MatchStats } from '@rally/sim';

export interface PlayerNarrative {
  name: string;
  seat: Seat;
  whiffs: number;
  smashes: number;
  lobs: number;
  dinks: number;
  drives: number;
  netErrors: number;
  outErrors: number;
  longestRally: number;
  pointsInARow: number;
  avgSwingSpeed: number;
  signatureShot: ShotType | null;
}

export interface MatchNarrative {
  sport: string;
  players: PlayerNarrative[];
  score: [number, number];
  serving: Seat;
  phase: string;
  rally: number;
  /** Rolling concrete facts: "Ada has whiffed 3 of the last 5". */
  facts: string[];
  /** Last N lines spoken, verbatim. */
  recentQuips: string[];
  /** Nicknames and jokes the commentator coined earlier. */
  runningBits: string[];
  lastEvent: string;
}

/** Normalise a line for the dedupe ledger. */
export function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Narrative {
  private facts: string[] = [];
  private quips: string[] = [];
  private bits: string[] = [];
  /** Hashes of every line already spoken or already sitting in a cue bank. */
  private ledger = new Set<string>();
  private lastEvent = 'match start';
  private whiffWindow: Record<number, boolean[]> = { 0: [], 1: [] };

  constructor(
    public sport: string,
    public names: [string, string],
  ) {}

  setNames(names: [string, string]): void {
    this.names = names;
  }

  /** Reject a line already used. Returns true if the line is fresh. */
  claim(line: string): boolean {
    const key = normalizeLine(line);
    if (key.length < 3) return false;
    if (this.ledger.has(key)) return false;
    this.ledger.add(key);
    return true;
  }

  /** True if the line has already been claimed, without claiming it. */
  seen(line: string): boolean {
    return this.ledger.has(normalizeLine(line));
  }

  spoke(line: string): void {
    this.quips.push(line);
    while (this.quips.length > TUNING.commentary.recentQuipMemory) this.quips.shift();
  }

  addBit(bit: string): void {
    const clean = bit.trim();
    if (!clean || this.bits.includes(clean) || clean.length > 40) return;
    // At most one new nickname or running joke per match.
    if (this.bits.length >= 1) return;
    this.bits.push(clean);
  }

  get bitsList(): string[] {
    return [...this.bits];
  }

  addFact(fact: string): void {
    if (!fact || this.facts.includes(fact)) return;
    this.facts.push(fact);
    while (this.facts.length > TUNING.commentary.factMemory) this.facts.shift();
  }

  /**
   * Derive facts from an event. This is where thin events would produce generic
   * commentary — every branch here exists because the simulation bothered to
   * populate `data`.
   */
  observe(e: GameEvent, stats: MatchStats): void {
    const d = e.data;
    const who = (seat: unknown): string =>
      this.names[lane(Number(seat) as Seat)] ?? 'they';

    switch (e.type) {
      case 'whiff': {
        const seat = Number(d.seat) as Seat;
        const win = this.whiffWindow[lane(seat)];
        win.push(true);
        while (win.length > 5) win.shift();
        this.lastEvent = `${who(seat)} swung through it`;
        if (Number(d.consecutiveWhiffs) >= 2) {
          this.addFact(
            `${who(seat)} has missed ${d.consecutiveWhiffs} swings in a row`,
          );
        } else if (Number(d.missDistanceM) > 1.2) {
          this.addFact(
            `${who(seat)} missed by ${Number(d.missDistanceM).toFixed(1)} metres on a ${d.shotIncoming}`,
          );
        }
        break;
      }
      case 'hit': {
        const seat = Number(d.seat) as Seat;
        const win = this.whiffWindow[lane(seat)];
        win.push(false);
        while (win.length > 5) win.shift();
        this.lastEvent = `${who(seat)} hit a ${d.shot}`;
        if (d.shot === 'smash' && Number(d.speed) > 14) {
          this.addFact(
            `${who(seat)} put a smash away at ${Number(d.speed).toFixed(0)} metres per second`,
          );
        }
        if (Number(d.quality) > 0.93) {
          this.addFact(`${who(seat)} timed a ${d.shot} almost perfectly`);
        }
        break;
      }
      case 'net':
        this.lastEvent = `${who(d.seat)} found the net`;
        this.addFact(`${who(d.seat)} has put ${countNet(stats, Number(d.seat) as Seat)} into the net`);
        break;
      case 'out':
        this.lastEvent = `${who(d.seat)} sent it out`;
        if (Number(d.longByM) > 0.8) {
          this.addFact(
            `${who(d.seat)} sailed one ${Number(d.longByM).toFixed(1)} metres long`,
          );
        }
        break;
      case 'fault':
        this.lastEvent = `${who(d.seat)} faulted the serve`;
        break;
      case 'point': {
        const winner = Number(d.winner) as Seat;
        this.lastEvent = `${who(winner)} took the point`;
        if (Number(d.rallyLength) >= 8) {
          this.addFact(
            `a ${d.rallyLength}-shot rally went ${who(winner)}'s way`,
          );
        }
        if (d.wasBreakPoint) this.addFact(`${who(winner)} broke serve`);
        break;
      }
      case 'streak':
        this.addFact(`${who(d.seat)} has won ${d.length} points in a row`);
        this.lastEvent = `${who(d.seat)} is on a run`;
        break;
      case 'comeback':
        this.addFact(`${who(d.seat)} came back from ${d.deficit} points down`);
        break;
      case 'rally_milestone':
        this.addFact(`a rally ran to ${d.shots} shots`);
        break;
      case 'game_point':
        this.lastEvent = `${who(d.seat)} is at match point`;
        break;
      default:
        break;
    }
  }

  /** Build the state object handed to a writer. */
  snapshot(
    stats: MatchStats,
    score: [number, number],
    serving: Seat,
    phase: string,
    rally: number,
  ): MatchNarrative {
    const players: PlayerNarrative[] = ([0, 1] as Seat[]).map((seat) => {
      const s = stats.perSeat[seat];
      return {
        name: this.names[lane(seat)],
        seat,
        whiffs: s.whiffs,
        smashes: s.shots.smash,
        lobs: s.shots.lob,
        dinks: s.shots.dink,
        drives: s.shots.drive,
        netErrors: s.netErrors,
        outErrors: s.outErrors,
        longestRally: s.longestRally,
        pointsInARow: s.pointsInARow,
        avgSwingSpeed: Number(avgSwingSpeed(s).toFixed(1)),
        signatureShot: signatureShot(s),
      };
    });
    return {
      sport: this.sport,
      players,
      score,
      serving,
      phase,
      rally,
      facts: [...this.facts],
      recentQuips: [...this.quips],
      runningBits: [...this.bits],
      lastEvent: this.lastEvent,
    };
  }

  /** Player most in need of being made fun of. Drives nickname coinage. */
  mostRidiculous(stats: MatchStats): Seat {
    const score = (seat: Seat): number => {
      const s = stats.perSeat[seat];
      return s.whiffs * 2 + s.netErrors + s.outErrors;
    };
    return score(0) >= score(1) ? 0 : otherSeat(0);
  }

  reset(): void {
    this.facts = [];
    this.quips = [];
    this.bits = [];
    this.ledger.clear();
    this.lastEvent = 'match start';
    this.whiffWindow = { 0: [], 1: [] };
  }
}

function countNet(stats: MatchStats, seat: Seat): number {
  return stats.perSeat[seat]?.netErrors ?? 0;
}
