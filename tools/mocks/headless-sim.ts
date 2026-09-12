/**
 * headless-sim — replaces W4 (the display) so the simulation can be judged
 * before anything is rendered.
 *
 * "If it isn't fun as a stream of console output describing good and bad shots,
 * no amount of shaders will save it."
 *
 *   npm run headless                       bot vs bot, pickleball
 *   npm run headless -- --sport tabletennis --skill 0.9 --seed 7
 *   npm run headless -- --quiet            events only, no ball trace
 */

import {
  Bot,
  Match,
  emptyTickInput,
  getSport,
  makeRng,
  predictContact,
  type BotView,
} from '@rally/sim';
import { TUNING, type Seat, type SportId } from '@rally/protocol';

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const sportId = flag('sport', 'pickleball') as SportId;
const seed = Number(flag('seed', '1234'));
const skill0 = Number(flag('skill', String(TUNING.bot.skill)));
const skill1 = Number(flag('skill2', flag('skill', String(TUNING.bot.skill))));
const quiet = has('quiet');
const trace = has('trace');

const sport = getSport(sportId);
const match = new Match({
  sport,
  seed,
  names: ['Ace', 'Bolt'],
  bots: [true, true],
});

const rng = makeRng(seed ^ 0x9e3779b9);
const bots: Bot[] = [new Bot(0, rng, skill0), new Bot(1, rng, skill1)];

const DT = 1 / TUNING.net.tickHz;
let t = 0;
match.start(t);

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  c: (s: string) => `\x1b[36m${s}\x1b[0m`,
  m: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const names = ['Ace', 'Bolt'];
let nanSeen = false;
let stuckTicks = 0;
let lastBallKey = '';

for (let i = 0; i < 60 * 60 * 5 && match.phase !== 'gameover'; i++) {
  t += DT * 1000;
  const input = emptyTickInput(t);

  // Bots read the same telegraph the display renders.
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
    if (swing) {
      if (match.phase === 'serve') match.applySwing(bot.seat, swing, t);
      else match.applySwing(bot.seat, swing, swing.ctPeak);
    }
  }

  const snap = match.step(DT, input);

  // Invariants from the W3 exit criteria.
  const ball = snap.ball;
  if (ball) {
    if (![...ball.p, ...ball.v].every(Number.isFinite)) {
      nanSeen = true;
      console.log(C.r('!! NaN in ball state'));
      break;
    }
    const key = ball.p.map((n) => n.toFixed(3)).join(',');
    if (key === lastBallKey && snap.phase === 'rally') stuckTicks++;
    else stuckTicks = 0;
    lastBallKey = key;
    if (stuckTicks > 60) {
      console.log(C.r('!! ball stuck for 1s during a rally'));
      break;
    }
  }

  if (trace && ball && i % 6 === 0 && snap.phase === 'rally') {
    console.log(
      C.dim(
        `  t=${(t / 1000).toFixed(2)}s  ball=(${ball.p.map((n) => n.toFixed(2)).join(', ')})  ` +
          `|v|=${Math.hypot(...ball.v).toFixed(1)}  bounces=${ball.b}`,
      ),
    );
  }

  for (const e of match.drainEvents()) {
    const who = e.seat !== undefined ? names[e.seat] : '';
    const d = e.data as Record<string, string | number | boolean>;
    if (quiet && e.salience < 0.25) continue;
    switch (e.type) {
      case 'match_start':
        console.log(C.b(`\n${sport.displayName} — first to ${d.pointsToWin}, win by 2\n`));
        break;
      case 'serve':
        console.log(`${C.c('SERVE')}  ${who} @ ${d.speed} m/s   ${C.dim(String(d.score))}`);
        break;
      case 'hit':
        console.log(
          `  ${C.g('hit')}   ${who.padEnd(5)} ${String(d.shot).padEnd(6)} ` +
            `${String(d.speed).padStart(5)} m/s  q=${String(d.quality).padStart(4)} ` +
            `${d.assisted ? C.dim('(assisted)') : ''} ${C.dim(`r${d.rallyLength}`)} ` +
            `${C.dim(`arr ${d.arrivalSpeed} diff ${d.difficulty} T${d.flightT}`)}` +
            `${d.clearsNet === false ? C.r(' WILL-CLIP') : ''}`,
        );
        break;
      case 'whiff':
        console.log(
          `  ${C.y('WHIFF')} ${who.padEnd(5)} by ${d.missDistanceM}m ` +
            `${d.early ? 'early' : 'late'} (${d.timingMs}ms) ` +
            `${Number(d.consecutiveWhiffs) > 1 ? C.r(`x${d.consecutiveWhiffs}`) : ''}`,
        );
        break;
      case 'net':
        console.log(`  ${C.r('NET')}   ${who} clipped the tape at ${d.height}m`);
        break;
      case 'out':
        console.log(`  ${C.r('OUT')}   ${who} long by ${d.longByM}m / wide by ${d.wideByM}m`);
        break;
      case 'fault':
        console.log(`  ${C.y('FAULT')} ${who} (${d.reason})`);
        break;
      case 'double_bounce':
        console.log(`  ${C.dim('double bounce')} — ${who} could not get there`);
        break;
      case 'point':
        console.log(
          C.b(
            `POINT ${d.winnerName} — ${d.scoreAfter}   ` +
              `${d.rallyLength} shots in ${(Number(d.rallyDurationMs) / 1000).toFixed(1)}s ` +
              `(${d.reason}, deciding: ${d.decidingShot})\n`,
          ),
        );
        break;
      case 'rally_milestone':
        console.log(C.m(`  ~~ ${d.shots}-shot rally ~~`));
        break;
      case 'streak':
        console.log(C.m(`  >> ${who} has won ${d.length} in a row`));
        break;
      case 'comeback':
        console.log(C.m(`  >> COMEBACK: ${who} was down ${d.deficit}`));
        break;
      case 'game_point':
        console.log(C.b(C.y(`  *** GAME POINT ${who} ***`)));
        break;
      case 'match_end':
        console.log(C.b(C.g(`\nMATCH: ${d.winnerName} wins ${d.final}\n`)));
        break;
      default:
        if (!quiet && e.type !== 'bounce') console.log(C.dim(`  ${e.type}`));
    }
  }
}

console.log(C.b('— summary —'));
for (const line of match.summary()) console.log('  ' + line);
const s = match.getStats();
console.log(
  C.dim(
    `  ${s.rallies} rallies, ${s.totalShots} shots, longest ${s.longestRally}, ` +
      `sim time ${(t / 1000).toFixed(1)}s`,
  ),
);
if (nanSeen) process.exitCode = 1;
