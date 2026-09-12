/**
 * Replay a recorded match.
 *
 * `packages/sim` is pure, so replaying the recorded inputs against the recorded
 * seed reproduces the match exactly — which is what makes a bug report actionable
 * and what generates commentary fixtures for free.
 *
 *   npm run replay -- replays/2026-09-12T...-ABCD-pickleball.jsonl
 *   npm run replay -- <file> --verify     re-simulate and diff against the log
 */

import { readFileSync } from 'node:fs';
import { TUNING, type GameEvent, type Seat, type Snapshot, type SwingInput } from '@rally/protocol';
import {
  Match,
  PingPongMatch,
  emptyTickInput,
  getSport,
  type MatchEngine,
} from '@rally/sim';
import type { ReplayLine } from '../../apps/server/src/replay.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const verify = args.includes('--verify');

if (!file) {
  console.error('usage: npm run replay -- <file.jsonl> [--verify]');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as ReplayLine);

const start = lines.find((l) => l.k === 'start');
if (!start || start.k !== 'start') {
  console.error('no start record in', file);
  process.exit(1);
}

const swings = lines.filter((l): l is Extract<ReplayLine, { k: 'swing' }> => l.k === 'swing');
const events = lines.filter((l): l is Extract<ReplayLine, { k: 'event' }> => l.k === 'event');
const snaps = lines.filter((l): l is Extract<ReplayLine, { k: 'snap' }> => l.k === 'snap');
const end = lines.find((l): l is Extract<ReplayLine, { k: 'end' }> => l.k === 'end');

console.log(`replay: ${start.sport}, ${start.names.join(' vs ')}, seed ${start.seed}`);
console.log(`  ${swings.length} swings, ${events.length} events, ${snaps.length} snapshots`);
if (end) console.log(`  winner: ${start.names[end.winner === 0 ? 0 : 1]}`);

if (!verify) {
  for (const e of events) {
    const ev = e.e as GameEvent;
    if (ev.type === 'bounce') continue;
    console.log(
      `${String((ev.t / 1000).toFixed(1)).padStart(7)}s  ${ev.type.padEnd(16)} ` +
        JSON.stringify(ev.data).slice(0, 120),
    );
  }
  process.exit(0);
}

// ── Verification ──────────────────────────────────────────────────────────────
//
// Feed the recorded swings back into a fresh simulation with the same seed. The
// event stream must come out the same; if it does not, determinism has broken
// and every replay-based bug report is worthless.

const sport = getSport(start.sport);
// The engine has to match the one that recorded it — see `MatchEngine`. Replaying
// a table tennis match through the shared simulation would not fail loudly, it
// would fail as a mismatch at event zero and look like broken determinism.
const match: MatchEngine =
  sport.id === 'tabletennis'
    ? new PingPongMatch({ sport, seed: start.seed, names: start.names })
    : new Match({ sport, seed: start.seed, names: start.names });
const DT = 1 / TUNING.net.tickHz;
let t = 0;
match.start(t);

const queue = [...swings];
const replayed: GameEvent[] = [];
const limit = ((end?.t ?? 300_000) + 20_000) / (DT * 1000);

for (let i = 0; i < limit && match.phase !== 'gameover'; i++) {
  t += DT * 1000;
  while (queue.length && queue[0].tServer <= t) {
    const s = queue.shift()!;
    match.applySwing(s.seat as Seat, s.swing as SwingInput, s.tServer);
  }
  match.step(DT, emptyTickInput(t));
  for (const e of match.drainEvents()) replayed.push(e);
}

const original = events.map((e) => e.e as GameEvent).filter((e) => e.type !== 'bounce');
const fresh = replayed.filter((e) => e.type !== 'bounce');

let mismatch = -1;
for (let i = 0; i < Math.max(original.length, fresh.length); i++) {
  const a = original[i];
  const b = fresh[i];
  if (!a || !b || a.type !== b.type || JSON.stringify(a.data) !== JSON.stringify(b.data)) {
    mismatch = i;
    break;
  }
}

if (mismatch < 0) {
  console.log(`\nverified: ${fresh.length} events reproduced exactly`);
} else {
  console.log(`\nMISMATCH at event ${mismatch}`);
  console.log('  recorded:', JSON.stringify(original[mismatch] ?? null).slice(0, 200));
  console.log('  replayed:', JSON.stringify(fresh[mismatch] ?? null).slice(0, 200));
  process.exitCode = 1;
}

void ((_: Snapshot[]) => undefined)([]);
