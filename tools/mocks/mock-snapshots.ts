/**
 * mock-snapshots — replaces W2 and W3 so the display can be built against a
 * moving world before either exists.
 *
 * Runs a real headless match and serves its snapshot stream over a WebSocket that
 * speaks the display half of the protocol, with configurable jitter and packet
 * loss. Testing the interpolator against a perfect stream tests nothing: the
 * whole point of the snapshot buffer is what it does when frames arrive late,
 * out of order, or not at all.
 *
 *   npm run mock:snapshots -- --jitter 80 --loss 0.05
 *   then open the display against ws://localhost:8790/ws
 */

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { TUNING, hrNowMs, makeServerClock, type S2D } from '@rally/protocol';
import { Bot, Match, emptyTickInput, getSport, makeRng, sportMeta, type BotView } from '@rally/sim';

const args = process.argv.slice(2);
const flag = (name: string, dflt: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};

const port = flag('port', 8790);
const jitterMs = flag('jitter', 40);
const loss = flag('loss', 0.02);
const seed = flag('seed', 4242);

const now = makeServerClock(hrNowMs);
const sport = getSport('pickleball');
const match = new Match({ sport, seed, names: ['Mock', 'Loop'], bots: [true, true] });
const rng = makeRng(seed ^ 0x9e3779b9);
const bots = [new Bot(0, rng, 0.55), new Bot(1, rng, 0.55)];

const clients = new Set<WebSocket>();
const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, mock: 'mock-snapshots', jitterMs, loss }));
});
const wss = new WebSocketServer({ server: http, path: '/ws' });

function broadcast(msg: S2D): void {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    // Packet loss and jitter, so the interpolator gets the conditions it is for.
    if (Math.random() < loss) continue;
    const delay = Math.random() * jitterMs;
    setTimeout(() => {
      if (ws.readyState === 1) ws.send(json);
    }, delay);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[mock-snapshots] display connected (${clients.size} total)`);
  ws.send(JSON.stringify({ t: 'WELCOME', clientId: 'mock', st: Math.round(now()) }));
  ws.send(
    JSON.stringify({
      t: 'ROOM_STATE',
      room: 'MOCK',
      seat: 0,
      pairToken: 'mock-token-mock-token',
      pairUrl: `http://localhost:${port}/c#r=MOCK&s=0&t=mock`,
      sport: 'pickleball',
      seats: [
        { seat: 0, name: 'Mock', ready: true, paired: true, bot: true, connected: true },
        { seat: 1, name: 'Loop', ready: true, paired: true, bot: true, connected: true },
      ],
      sports: [sportMeta(sport)],
      host: true,
    }),
  );
  ws.send(
    JSON.stringify({
      t: 'MATCH_START',
      sport: 'pickleball',
      st: Math.round(now()),
      names: ['Mock', 'Loop'],
    }),
  );
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as { t: string; c0?: number };
      if (msg.t === 'PING') {
        ws.send(JSON.stringify({ t: 'PONG', c0: msg.c0, st: Math.round(now()) }));
      }
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => clients.delete(ws));
});

const DT = 1 / TUNING.net.tickHz;
let t = 0;
let lastSnapshot = -1e9;
match.start(0);

setInterval(() => {
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
  for (const e of match.drainEvents()) broadcast({ t: 'EVENT', e });

  if (t - lastSnapshot >= 1000 / TUNING.net.snapshotHz) {
    lastSnapshot = t;
    broadcast({ t: 'SNAPSHOT', s: snap });
  }

  // Loop forever: restart as soon as a match ends.
  if (match.phase === 'gameover') {
    match.reset(sport);
    match.start(t);
    for (const b of bots) b.reset();
    broadcast({ t: 'MATCH_START', sport: 'pickleball', st: Math.round(t), names: ['Mock', 'Loop'] });
  }
}, 1000 / TUNING.net.tickHz);

http.listen(port, () => {
  console.log(
    `[mock-snapshots] ws://localhost:${port}/ws — jitter ${jitterMs}ms, ${(loss * 100).toFixed(0)}% loss`,
  );
});
