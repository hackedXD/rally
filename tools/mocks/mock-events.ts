/**
 * mock-events — replaces W3 so the commentary system can be built before the
 * simulation emits anything.
 *
 * A scripted 90-second `GameEvent` timeline covering every event type, with the
 * same rich `data` payloads the real simulation produces. Importable as a fixture
 * and runnable as a CLI that prints the timeline.
 *
 *   npm run mock:events
 */

import { eventId, type GameEvent, type Seat } from '@rally/protocol';

interface ScriptStep {
  at: number;
  type: GameEvent['type'];
  seat?: Seat;
  data: Record<string, string | number | boolean>;
  salience: number;
  priority: 0 | 1 | 2 | 3;
}

const NAMES = ['Ada', 'Bolt'];

/** Every event type the commentator can be handed, in a plausible order. */
const SCRIPT: ScriptStep[] = [
  { at: 0, type: 'match_start', data: { sport: 'pickleball', p0: 'Ada', p1: 'Bolt', pointsToWin: 7 }, salience: 1, priority: 3 },
  { at: 1200, type: 'serve', seat: 0, data: { seat: 0, server: 'Ada', receiver: 'Bolt', speed: 12.4, score: '0-0', faultsSoFar: 0, gamePoint: false, willLandIn: true }, salience: 0.22, priority: 1 },
  { at: 2400, type: 'bounce', data: { x: 0.4, z: 4.2, inBounds: true, speed: 7.1, side: 1 }, salience: 0.03, priority: 0 },
  { at: 3000, type: 'hit', seat: 1, data: { seat: 1, player: 'Bolt', shot: 'drive', speed: 16.2, quality: 0.88, rallyLength: 2, assisted: false, difficulty: 0.3, willLandIn: true }, salience: 0.18, priority: 1 },
  { at: 4200, type: 'whiff', seat: 0, data: { seat: 0, player: 'Ada', missDistanceM: 1.4, timingMs: -180, early: true, ballSpeed: 7.8, consecutiveWhiffs: 1, shotIncoming: 'drive', windowMs: 96, difficulty: 0.52 }, salience: 0.6, priority: 2 },
  { at: 5400, type: 'double_bounce', seat: 0, data: { seat: 0, player: 'Ada', rallyLength: 2, shotIncoming: 'drive' }, salience: 0.3, priority: 1 },
  { at: 5500, type: 'point', seat: 1, data: { winner: 1, loser: 0, winnerName: 'Bolt', loserName: 'Ada', reason: 'double_bounce', rallyLength: 2, rallyDurationMs: 4300, decidingShot: 'drive', scoreBefore: '0-0', scoreAfter: '0-1', wasBreakPoint: true, margin: 1, streak: 1 }, salience: 0.75, priority: 3 },
  { at: 9000, type: 'serve', seat: 1, data: { seat: 1, server: 'Bolt', receiver: 'Ada', speed: 11.8, score: '0-1', faultsSoFar: 0, gamePoint: false, willLandIn: false }, salience: 0.22, priority: 1 },
  { at: 10200, type: 'net', seat: 1, data: { seat: 1, speed: 9.4, x: 0.2, height: 0.71, shot: 'serve', serving: true }, salience: 0.55, priority: 2 },
  { at: 10300, type: 'fault', seat: 1, data: { seat: 1, player: 'Bolt', reason: 'net', faultNumber: 1, willLosePoint: false }, salience: 0.35, priority: 1 },
  { at: 13000, type: 'hit', seat: 0, data: { seat: 0, player: 'Ada', shot: 'lob', speed: 11.2, quality: 0.72, rallyLength: 4, assisted: false, difficulty: 0.2, willLandIn: true }, salience: 0.3, priority: 1 },
  { at: 14100, type: 'hit', seat: 1, data: { seat: 1, player: 'Bolt', shot: 'smash', speed: 19.8, quality: 0.95, rallyLength: 5, assisted: false, difficulty: 0.1, willLandIn: true }, salience: 0.72, priority: 2 },
  { at: 15200, type: 'out', seat: 1, data: { seat: 1, player: 'Bolt', reason: 'out', longByM: 1.3, wideByM: 0, shot: 'smash', rallyLength: 5 }, salience: 0.45, priority: 1 },
  { at: 15300, type: 'point', seat: 0, data: { winner: 0, loser: 1, winnerName: 'Ada', loserName: 'Bolt', reason: 'out', rallyLength: 5, rallyDurationMs: 5200, decidingShot: 'smash', scoreBefore: '0-1', scoreAfter: '1-1', wasBreakPoint: true, margin: 0, streak: 1 }, salience: 0.78, priority: 3 },
  { at: 22000, type: 'rally_milestone', data: { shots: 6, durationMs: 7200, longestOfMatch: true }, salience: 0.58, priority: 1 },
  { at: 30000, type: 'rally_milestone', data: { shots: 14, durationMs: 16800, longestOfMatch: true }, salience: 0.82, priority: 2 },
  { at: 31000, type: 'point', seat: 0, data: { winner: 0, loser: 1, winnerName: 'Ada', loserName: 'Bolt', reason: 'net', rallyLength: 14, rallyDurationMs: 17400, decidingShot: 'dink', scoreBefore: '1-1', scoreAfter: '2-1', wasBreakPoint: false, margin: 1, streak: 2, longestRallyOfMatch: true }, salience: 0.95, priority: 3 },
  { at: 38000, type: 'streak', seat: 0, data: { seat: 0, length: 3, scoreAfter: '3-1' }, salience: 0.8, priority: 2 },
  { at: 52000, type: 'comeback', seat: 1, data: { seat: 1, from: 1, to: 4, deficit: 3 }, salience: 0.95, priority: 3 },
  { at: 68000, type: 'game_point', seat: 1, data: { seat: 1, scoreAfter: '4-6', matchPoint: true, servingSeat: 1 }, salience: 0.9, priority: 2 },
  { at: 74000, type: 'whiff', seat: 0, data: { seat: 0, player: 'Ada', missDistanceM: 2.1, timingMs: 210, early: false, ballSpeed: 9.2, consecutiveWhiffs: 3, shotIncoming: 'smash', windowMs: 78, difficulty: 0.71 }, salience: 0.9, priority: 2 },
  { at: 75000, type: 'point', seat: 1, data: { winner: 1, loser: 0, winnerName: 'Bolt', loserName: 'Ada', reason: 'double_bounce', rallyLength: 7, rallyDurationMs: 8100, decidingShot: 'smash', scoreBefore: '4-6', scoreAfter: '4-7', wasBreakPoint: false, margin: 3, streak: 2 }, salience: 1, priority: 3 },
  { at: 77000, type: 'match_end', seat: 1, data: { winner: 1, winnerName: 'Bolt', loserName: 'Ada', final: '4-7', margin: 3, longestRally: 14, totalShots: 68, durationMs: 77000 }, salience: 1, priority: 3 },
];

export function mockEventTimeline(): GameEvent[] {
  return SCRIPT.map((s) => ({
    id: eventId(s.type),
    t: s.at,
    type: s.type,
    seat: s.seat,
    data: s.data,
    salience: s.salience,
    priority: s.priority,
  }));
}

/** Replay the timeline in real time, calling back as each event fires. */
export function playTimeline(onEvent: (e: GameEvent) => void, speed = 1): () => void {
  const events = mockEventTimeline();
  const timers = events.map((e) => setTimeout(() => onEvent(e), e.t / speed));
  return () => timers.forEach(clearTimeout);
}

export const MOCK_NAMES: [string, string] = [NAMES[0], NAMES[1]];

const isMain = process.argv[1]?.endsWith('mock-events.ts');
if (isMain) {
  const events = mockEventTimeline();
  console.log(`[mock-events] ${events.length} events over 77 seconds\n`);
  for (const e of events) {
    const who = e.seat !== undefined ? NAMES[e.seat === 0 ? 0 : 1] : '—';
    console.log(
      `${String((e.t / 1000).toFixed(1)).padStart(6)}s  ${e.type.padEnd(16)} ` +
        `${who.padEnd(5)} sal=${e.salience.toFixed(2)} p${e.priority}  ` +
        JSON.stringify(e.data).slice(0, 100),
    );
  }
  const types = new Set(events.map((e) => e.type));
  console.log(`\ncovers ${types.size} event types: ${[...types].sort().join(', ')}`);
}
