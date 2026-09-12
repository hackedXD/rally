/**
 * End-to-end: a real server process, real WebSockets, the real protocol.
 *
 * This is the W2 exit criteria as a test — two clients join the same room and
 * receive consistent snapshots, the clock offset converges, a swing sent in a
 * client's own clock is rewound correctly, and commentary cues arrive before the
 * first serve.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { getSport } from '@rally/sim';
import { ControllerNet } from '../apps/controller/src/net.js';
import {
  ClockSync,
  TUNING,
  parseMessage,
  qFromUnitZTo,
  quantQuat,
  s2cSchema,
  s2dSchema,
  vnorm,
  type PreloadedCue,
  type S2C,
  type S2D,
  type Seat,
  type Snapshot,
} from '@rally/protocol';

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

let server: ChildProcess;

/** A test client that validates every inbound message against the schema. */
class Client {
  ws: WebSocket;
  readonly inbox: (S2D | S2C)[] = [];
  readonly snapshots: Snapshot[] = [];
  readonly cues = new Map<string, PreloadedCue>();
  readonly played: string[] = [];
  readonly events: string[] = [];
  readonly invalid: string[] = [];
  clock = new ClockSync(() => performance.now());
  seat: Seat | null = null;
  room: string | null = null;
  pairUrl: string | null = null;

  constructor(private readonly kind: 'display' | 'controller') {
    this.ws = new WebSocket(WS);
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const parsed =
        this.kind === 'display'
          ? parseMessage(s2dSchema, data.toString())
          : parseMessage(s2cSchema, data.toString());
      if (!parsed.ok) {
        this.invalid.push(`${parsed.error}: ${data.toString().slice(0, 100)}`);
        return;
      }
      const msg = parsed.value as S2D | S2C;
      this.inbox.push(msg);
      switch (msg.t) {
        case 'PONG':
          this.clock.accept(msg.c0, msg.st);
          break;
        case 'ROOM_STATE':
          this.seat = msg.seat;
          this.room = msg.room;
          this.pairUrl = msg.pairUrl;
          break;
        case 'PAIRED':
          this.seat = msg.seat;
          this.room = msg.room;
          break;
        case 'SNAPSHOT':
          this.snapshots.push(msg.s);
          break;
        case 'CUE_PRELOAD':
          for (const c of msg.cues) this.cues.set(c.id, c);
          break;
        case 'CUE_PLAY':
          this.played.push(msg.id);
          break;
        case 'EVENT':
          this.events.push(msg.e.type);
          break;
        default:
          break;
      }
    });
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  ping(): void {
    this.send({ t: 'PING', c0: this.clock.stamp(), rtt: this.clock.rtt || undefined });
  }

  /** Wait for a message of a given type. */
  async waitFor<T extends (S2D | S2C)['t']>(
    type: T,
    timeoutMs = 8000,
  ): Promise<Extract<S2D | S2C, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.inbox.find((m) => m.t === type);
      if (found) return found as Extract<S2D | S2C, { t: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await sleep(25);
    }
  }

  async waitUntil(pred: () => boolean, timeoutMs = 8000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Dink, rally, drive, lob — the whole vocabulary, cycled. */
const SHOT_MENU = [
  { speed: 2.4, elev: 0.3 },
  { speed: 5.5, elev: 0.2 },
  { speed: 8.5, elev: 0.04 },
  { speed: 4.6, elev: 0.55 },
  { speed: 7.0, elev: 0.12 },
];

beforeAll(async () => {
  server = spawn(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.node.json', 'apps/server/src/index.ts'],
    {
      env: { ...process.env, PORT: String(PORT), RALLY_LOG: 'error', RALLY_FORCE_OFFLINE_AI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stderr?.on('data', (d) => {
    const s = String(d);
    if (!s.includes('ExperimentalWarning')) process.stderr.write(`[server] ${s}`);
  });
  // Wait for the health endpoint.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await sleep(200);
  }
}, 60_000);

afterAll(() => {
  server?.kill('SIGTERM');
});

describe('server endpoints', () => {
  it('reports health and a running tick loop', async () => {
    // /healthz answers as soon as the listener is up, which is a moment before
    // the loop starts, so poll rather than asserting on the first response.
    let tick = { ticks: 0, dropped: 0 };
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && tick.ticks <= 10) {
      const json = (await fetch(`${BASE}/healthz`).then((r) => r.json())) as {
        ok: boolean;
        tick: { ticks: number; dropped: number };
      };
      expect(json.ok).toBe(true);
      tick = json.tick;
      if (tick.ticks <= 10) await sleep(200);
    }
    expect(tick.ticks).toBeGreaterThan(10);
    expect(tick.dropped).toBe(0);
  });

  it('lists the sports, including the stub', async () => {
    const json = (await fetch(`${BASE}/api/sports`).then((r) => r.json())) as {
      sports: { id: string; playable: boolean }[];
    };
    expect(json.sports.map((s) => s.id)).toEqual(['pickleball', 'tabletennis', 'bowling']);
    expect(json.sports.find((s) => s.id === 'bowling')!.playable).toBe(false);
  });
});

describe('pairing and a full match', () => {
  it('pairs a phone by QR URL, plays a match, and commentates it', async () => {
    const display = new Client('display');
    await display.open();
    display.send({ t: 'HELLO', role: 'display' });
    await display.waitFor('WELCOME');

    display.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    const state = await display.waitFor('ROOM_STATE');
    expect(state.room).toMatch(/^[A-Z2-9]{4}$/);
    expect(state.host).toBe(true);
    expect(state.seat).toBe(0);

    // The pair token must be in the URL FRAGMENT, never the query string:
    // fragments are not sent in the HTTP request line and so never reach a log.
    // The trailing-slash form, which works against both the dev server and the
    // production static mount.
    expect(state.pairUrl).toContain('/c/#');
    const frag = new URLSearchParams(state.pairUrl.split('#')[1]);
    expect(frag.get('r')).toBe(state.room);
    expect(frag.get('s')).toBe('0');
    expect(frag.get('t')).toBe(state.pairToken);

    // Clock sync: the client converges within a few seconds.
    for (let i = 0; i < 6; i++) {
      display.ping();
      await sleep(120);
    }
    expect(display.clock.isSynced).toBe(true);

    // The phone scans the QR and pairs.
    const phone = new Client('controller');
    await phone.open();
    phone.send({
      t: 'HELLO',
      role: 'controller',
      room: frag.get('r'),
      seat: 0,
      pairToken: frag.get('t'),
    });
    const paired = await phone.waitFor('PAIRED');
    expect(paired.seat).toBe(0);
    expect(paired.sport).toBe('pickleball');

    for (let i = 0; i < 6; i++) {
      phone.ping();
      await sleep(110);
    }
    expect(phone.clock.isSynced).toBe(true);
    // The offset should be a sane magnitude and stable.
    expect(Math.abs(phone.clock.jitter)).toBeLessThan(200);

    // A reused pair token must be rejected, or two phones fight over one seat.
    const imposter = new Client('controller');
    await imposter.open();
    imposter.send({
      t: 'HELLO',
      role: 'controller',
      room: frag.get('r'),
      seat: 0,
      pairToken: frag.get('t'),
    });
    const err = await imposter.waitFor('ERROR');
    expect(err.code).toBe('SEAT_TAKEN');
    imposter.close();

    // Fill the other seat with a bot and start.
    phone.send({ t: 'CALIBRATED', yawOffset: 0.1 });
    phone.send({ t: 'READY', name: 'Ada' });
    display.send({ t: 'ADD_BOT', skill: 0.45 });
    display.send({ t: 'START' });

    const started = await display.waitFor('MATCH_START', 20_000);
    expect(started.sport).toBe('pickleball');
    expect(started.names[0]).toBe('Ada');

    // The cold bank must have been pushed BEFORE the first serve: that is the
    // entire reason cached commentary can fire in one network hop.
    expect(display.cues.size).toBeGreaterThan(10);
    const intro = [...display.cues.values()].find((c) => c.cls === 'match.intro');
    expect(intro).toBeDefined();
    expect(intro!.text.length).toBeGreaterThan(5);

    // Snapshots flow at roughly 30 Hz.
    await display.waitUntil(() => display.snapshots.length > 40, 8000, 'snapshots');
    const span =
      display.snapshots.at(-1)!.t - display.snapshots[0]!.t;
    const rate = ((display.snapshots.length - 1) / span) * 1000;
    expect(rate).toBeGreaterThan(TUNING.net.snapshotHz * 0.7);
    expect(rate).toBeLessThan(TUNING.net.snapshotHz * 1.4);

    // Pose is forwarded out of band, straight back to this seat's own display.
    const aim = vnorm([0, 0.25, 1]);
    for (let i = 0; i < 5; i++) {
      phone.send({ t: 'POSE', seq: i, ct: performance.now(), q: quantQuat(qFromUnitZTo(aim)) });
      await sleep(40);
    }
    const localPose = await display.waitFor('LOCALPOSE');
    expect(localPose.seat).toBe(0);

    // Drive the human seat: swing whenever our own strike window opens. The
    // timestamp is in the PHONE's clock, so this exercises the server's rewind.
    let swings = 0;
    const deadline = Date.now() + 200_000;
    let lastTelegraph = -1;
    const windowMs = getSport('pickleball').strike.windowMs;
    while (Date.now() < deadline) {
      const snap = display.snapshots.at(-1);
      if (!snap) {
        await sleep(20);
        continue;
      }
      if (snap.phase === 'gameover') break;
      if (snap.phase === 'serve' && snap.score.server === 0) {
        phone.send({ t: 'BUTTON', button: 'serve' });
        await sleep(120);
        continue;
      }
      const tel = snap.strike;
      if (tel && tel.seat === 0 && tel.tIdeal !== lastTelegraph) {
        const waitMs = tel.tIdeal - display.clock.serverNow();
        if (waitMs > -windowMs && waitMs < 1500) {
          lastTelegraph = tel.tIdeal;
          // Swing like a person, not like a metronome: a perfect-timing client
          // makes every rally last forever and tests nothing about the window.
          const jitter = (Math.random() * 2 - 1) * 45;
          if (waitMs + jitter > 0) await sleep(waitMs + jitter);
          // Vary the shot, so the test covers the whole shot vocabulary rather
          // than one safe rally ball repeated forty times.
          const shot = SHOT_MENU[swings % SHOT_MENU.length];
          const lateral = (Math.random() * 2 - 1) * 0.5;
          const aim = vnorm([lateral, Math.sin(shot.elev) + 0.05, 1]);
          // ctPeak is in the phone's own clock; the server converts and rewinds.
          phone.send({
            t: 'SWING',
            seq: swings++,
            ctPeak: phone.clock.toClient(phone.clock.serverNow()),
            speed: shot.speed,
            dir: [aim[0], Math.sin(shot.elev), Math.cos(shot.elev)],
            q: qFromUnitZTo(aim),
            elev: shot.elev,
          });
          continue;
        }
      }
      await sleep(16);
    }

    const end = await display.waitFor('MATCH_END', 20_000);
    expect([0, 1]).toContain(end.winner);
    expect(end.final[0] + end.final[1]).toBeGreaterThan(6);
    expect(end.summary.length).toBeGreaterThan(0);

    // The human actually connected with some of those swings.
    expect(swings).toBeGreaterThan(5);
    const hits = display.events.filter((e) => e === 'hit').length;
    expect(hits).toBeGreaterThan(4);
    // And the varied swings produced more than one kind of shot.
    const shots = new Set(
      display.inbox
        .filter((m): m is Extract<S2D, { t: 'EVENT' }> => m.t === 'EVENT')
        .map((m) => m.e.data.shot)
        .filter(Boolean),
    );
    expect(shots.size).toBeGreaterThan(1);

    // Commentary fired, and never played the same cue twice.
    expect(display.played.length).toBeGreaterThan(3);
    expect(new Set(display.played).size).toBe(display.played.length);
    const spokenTexts = display.played
      .map((id) => display.cues.get(id)?.text)
      .filter((t): t is string => Boolean(t));
    expect(new Set(spokenTexts).size).toBe(spokenTexts.length);

    // The phone got its score feed and its local cues.
    expect(phone.inbox.some((m) => m.t === 'LITE')).toBe(true);
    expect(phone.inbox.some((m) => m.t === 'CUE')).toBe(true);

    // Not one malformed message in either direction.
    expect(display.invalid).toEqual([]);
    expect(phone.invalid).toEqual([]);

    display.close();
    phone.close();
  }, 280_000);
});

describe('the real phone client', () => {
  /**
   * Drives `ControllerNet` — the actual class the phone runs — rather than a
   * hand-rolled test client.
   *
   * Regression: the app's own 'open' handler sends CALIBRATED and READY
   * synchronously, and the client used to notify it BEFORE sending HELLO. That
   * put two messages on the wire ahead of the handshake, the server answered
   * "send HELLO first", and the phone showed an error screen instead of joining.
   * A bespoke test client cannot catch that, because it builds its own ordering.
   */
  it('pairs, syncs and plays without a protocol error', async () => {
    const display = new Client('display');
    await display.open();
    display.send({ t: 'HELLO', role: 'display' });
    await display.waitFor('WELCOME');
    display.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    const state = await display.waitFor('ROOM_STATE');

    const seen: string[] = [];
    const errors: { code: string; message: string }[] = [];
    let paired = false;
    let lite = 0;

    const net = new ControllerNet(
      WS,
      { room: state.room, seat: 0, token: state.pairToken },
      {
        onState: (s) => {
          seen.push(s);
          // Exactly what the app does here, and the shape of the original bug.
          if (s === 'open') {
            net.calibrated(0.1);
            net.ready('Ada');
          }
        },
        onPaired: () => {
          paired = true;
        },
        onCue: () => undefined,
        onLite: () => {
          lite++;
        },
        onError: (code, message) => errors.push({ code, message }),
      },
    );
    net.connect();

    const deadline = Date.now() + 10_000;
    while (!paired && Date.now() < deadline) await sleep(25);

    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(paired).toBe(true);
    expect(seen).toContain('open');

    // The clock converges off the client's own ping loop.
    await sleep(TUNING.net.pingIntervalMs * 2 + 500);
    expect(net.clock.isSynced).toBe(true);

    // And READY actually registered, rather than being dropped before HELLO.
    display.send({ t: 'ADD_BOT', skill: 0.5 });
    await sleep(300);
    const latest = [...display.inbox]
      .reverse()
      .find((m): m is Extract<S2D, { t: 'ROOM_STATE' }> => m.t === 'ROOM_STATE')!;
    expect(latest.seats[0].ready).toBe(true);
    expect(latest.seats[0].name).toBe('Ada');

    // Pose and swings flow, and the phone gets its score feed back.
    display.send({ t: 'START' });
    await display.waitFor('MATCH_START', 20_000);
    for (let i = 0; i < 5; i++) {
      net.pose(qFromUnitZTo(vnorm([0, 0.25, 1])), performance.now());
      await sleep(60);
    }
    net.serve();
    await sleep(800);
    expect(lite).toBeGreaterThan(0);
    expect(errors).toEqual([]);

    net.close();
    display.close();
  }, 60_000);
});

describe('protocol hardening', () => {
  it('drops garbage without dropping the connection', async () => {
    const c = new Client('display');
    await c.open();
    c.send({ t: 'HELLO', role: 'display' });
    await c.waitFor('WELCOME');

    c.ws.send('not json');
    c.ws.send(JSON.stringify({ t: 'NONSENSE' }));
    c.ws.send(JSON.stringify({ t: 'ROOM_JOIN', room: '!!!!' }));
    c.ws.send(JSON.stringify({ t: 'SWING', speed: 'fast' }));
    await sleep(300);

    // Still alive and still answering.
    c.ping();
    await c.waitUntil(() => c.inbox.some((m) => m.t === 'PONG'), 4000, 'pong');
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.close();
  }, 30_000);

  it('rejects joining a room that does not exist', async () => {
    const c = new Client('display');
    await c.open();
    c.send({ t: 'HELLO', role: 'display' });
    await c.waitFor('WELCOME');
    c.send({ t: 'ROOM_JOIN', room: 'ZZZZ' });
    const err = await c.waitFor('ERROR');
    expect(err.code).toBe('NO_ROOM');
    c.close();
  }, 20_000);

  it('refuses to start a sport that ships as a stub', async () => {
    const c = new Client('display');
    await c.open();
    c.send({ t: 'HELLO', role: 'display' });
    await c.waitFor('WELCOME');
    c.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    await c.waitFor('ROOM_STATE');
    c.send({ t: 'SPORT_SELECT', sport: 'bowling' });
    const err = await c.waitFor('ERROR');
    expect(err.code).toBe('NOT_PLAYABLE');
    c.close();
  }, 20_000);

  it('lets two displays share one room, each on its own seat', async () => {
    const a = new Client('display');
    const b = new Client('display');
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'HELLO', role: 'display' });
    await a.waitFor('WELCOME');
    a.send({ t: 'ROOM_CREATE', sport: 'tabletennis' });
    const state = await a.waitFor('ROOM_STATE');

    b.send({ t: 'HELLO', role: 'display' });
    await b.waitFor('WELCOME');
    b.send({ t: 'ROOM_JOIN', room: state.room });
    const bState = await b.waitFor('ROOM_STATE');
    expect(bState.room).toBe(state.room);
    expect(bState.seat).toBe(1);
    expect(bState.host).toBe(false);
    // Each display's QR encodes its OWN seat.
    expect(bState.pairUrl).toContain('s=1');
    expect(bState.pairToken).not.toBe(state.pairToken);

    a.close();
    b.close();
  }, 20_000);
});
