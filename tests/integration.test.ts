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
  lane,
  parseMessage,
  qFromUnitZTo,
  quantQuat,
  s2cSchema,
  s2dSchema,
  vnorm,
  type PreloadedCue,
  type Quat,
  type S2C,
  type S2D,
  type Seat,
  type Snapshot,
  type Vec3,
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
  /** Dispatch order with arrival time and priority, for the overlap check. */
  readonly playedAt: { id: string; at: number; priority: number }[] = [];
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
          this.playedAt.push({ id: msg.id, at: Date.now(), priority: msg.priority });
          break;
        case 'EVENT':
          this.events.push(msg.e.type);
          break;
        case 'LITE':
          // Ready up, every point, exactly as the phone app does — the server
          // holds the next serve until both bats are up. A test client that
          // never tapped would be a phone nobody is holding, and nothing it did
          // afterwards would tell us anything about the game.
          if (this.seat !== null && !msg.ready[lane(this.seat)]) {
            this.send({ t: 'READY_POINT' });
          }
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

  /** The most recent message of a type. ROOM_STATE is re-sent on every change. */
  latest<T extends (S2D | S2C)['t']>(type: T): Extract<S2D | S2C, { t: T }> | undefined {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      if (this.inbox[i].t === type) return this.inbox[i] as Extract<S2D | S2C, { t: T }>;
    }
    return undefined;
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
    // Order matters: it is the order the lobby lists them in. Table tennis first
    // because it is the product — its own engine, its own physics — and the stub
    // last.
    expect(json.sports.map((s) => s.id)).toEqual([
      'tabletennis',
      'pickleball',
      'badminton',
      'bowling',
    ]);
    expect(json.sports.filter((s) => s.playable).map((s) => s.id)).toEqual([
      'tabletennis',
      'pickleball',
      'badminton',
    ]);
    expect(json.sports.find((s) => s.id === 'bowling')!.playable).toBe(false);
    // Playable on the shared engine, and labelled as such rather than letting
    // somebody find out by playing one.
    const beta = json.sports as { id: string; beta?: boolean }[];
    expect(beta.filter((s) => s.beta).map((s) => s.id)).toEqual(['pickleball', 'badminton']);
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

    // Generous, and it has to be: every point now carries the ready-up beat —
    // up to a LITE interval waiting for the tap, then `serve.readyDelayMs` — and
    // a match to 11 pays that twenty-odd times. This runs against a real socket
    // and a real clock, so the budget is wall time, not ticks.
    const end = await display.waitFor('MATCH_END', 120_000);
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

    /*
     * And no line was ever talked over.
     *
     * The display does not interrupt a cue once it has started, so a second cue
     * dispatched mid-line does not overlap it — it queues and plays late. The
     * director therefore stays quiet until the previous line is done, and the
     * match holds the next serve so that staying quiet does not mean missing the
     * moment. Priority 3 is the deliberate exception: the point itself must be
     * said, so it is allowed to queue.
     *
     * Measured on arrival time at a real client over a real socket.
     */
    const overlaps = display.playedAt.filter((cue, i) => {
      if (i === 0 || cue.priority >= 3) return false;
      const prev = display.playedAt[i - 1];
      const prevMs = display.cues.get(prev.id)?.durationMs ?? 0;
      return cue.at - prev.at < prevMs;
    });
    expect(
      overlaps.map((c) => display.cues.get(c.id)?.text ?? c.id),
    ).toEqual([]);
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
      // A real rotation rate, so the pose that reaches the server is one the
      // predictor has actually led forward rather than passed straight through.
      net.pose(qFromUnitZTo(vnorm([0, 0.25, 1])), performance.now(), [0, 120, 0]);
      await sleep(60);
    }
    net.serve();
    await sleep(800);
    expect(lite).toBeGreaterThan(0);
    expect(errors).toEqual([]);

    net.close();
    display.close();
  }, 180_000);
});

describe('match completion', () => {
  /**
   * Regression: the end-of-match guard read only the simulation's phase, which
   * stays 'gameover' forever — so MATCH_END went out sixty times a second, along
   * with a controller cue and a replay write each time. The visible symptom was
   * that "Back to lobby" did nothing: the display navigated away and was slammed
   * back onto the end card 16 ms later.
   */
  it('announces the end of the match exactly once', async () => {
    const display = new Client('display');
    await display.open();
    display.send({ t: 'HELLO', role: 'display' });
    await display.waitFor('WELCOME');
    display.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    await display.waitFor('ROOM_STATE');

    // A mismatch, so the match resolves quickly.
    display.send({ t: 'ADD_BOT', skill: 0.95 });
    display.send({ t: 'ADD_BOT', skill: 0.05 });
    display.send({ t: 'START' });

    await display.waitFor('MATCH_END', 200_000);
    // Keep listening well past the point where a per-tick broadcast would have
    // produced hundreds.
    await sleep(3000);

    const ends = display.inbox.filter((m) => m.t === 'MATCH_END');
    expect(ends.length).toBe(1);

    // The room stops ticking too, rather than spinning on a finished match.
    const before = display.snapshots.length;
    await sleep(600);
    expect(display.snapshots.length).toBe(before);
    display.close();
  }, 240_000);
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

    // Each screen shows one code: its own seat's. The other screen's arrival is
    // what the first one is told about, so the lobby can tell "nobody is here"
    // from "somebody is here, connecting".
    expect(bState.theirDisplay).toBe(true);
    await a.waitUntil(
      () => a.latest('ROOM_STATE')?.theirDisplay === true,
      4000,
      'seat 1 claimed by its own display',
    );

    a.close();
    b.close();
  }, 20_000);
});

describe('table tennis over the wire', () => {
  /**
   * The sport that does not run the shared engine, end to end.
   *
   * Everything the other tests exercise — pairing, snapshots, the clock, the
   * commentary — routes through the same code for both engines, and is covered
   * once above. What is only true here is the three channels this engine added:
   * a bat with a position, driven by a pose; a `hold` that freezes it mid-stroke;
   * and a swing carrying the wrist's rotation, which is where its spin comes
   * from. None of those exist in the protocol for any other sport.
   */
  it('drives a bat from a pose and takes a swing with spin in it', async () => {
    const display = new Client('display');
    await display.open();
    display.send({ t: 'HELLO', role: 'display' });
    await display.waitFor('WELCOME');
    display.send({ t: 'ROOM_CREATE', sport: 'tabletennis' });
    const state = await display.waitFor('ROOM_STATE');
    const frag = new URLSearchParams(state.pairUrl.split('#')[1]);

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
    // The phone is told the sport because it picks a swing detector from it:
    // this one onsets on rotation, every other sport on acceleration.
    expect(paired.sport).toBe('tabletennis');

    phone.send({ t: 'READY', name: 'Ada' });
    display.send({ t: 'ADD_BOT', skill: 0.45 });
    display.send({ t: 'START' });
    const started = await display.waitFor('MATCH_START', 20_000);
    expect(started.sport).toBe('tabletennis');

    await display.waitUntil(() => display.snapshots.length > 20, 8000, 'snapshots');

    const batOf = (): Vec3 => {
      const p = display.snapshots.at(-1)!.players.find((x) => lane(x.seat) === 0);
      return p!.p;
    };

    // Tilt the bat's face toward the player's own right and hold it there. The
    // bat has to follow — this is the whole difference from the other sports,
    // where where you point and where you are are independent.
    const tilt = (rad: number): Quat => [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];
    const drive = async (q: Quat, hold = false): Promise<void> => {
      for (let i = 0; i < 30; i++) {
        phone.send({ t: 'POSE', seq: i, ct: performance.now(), q: quantQuat(q), z: 0.1, hold });
        await sleep(16);
      }
      await sleep(120);
    };

    await drive(tilt(0.5));
    const right = batOf();
    await drive(tilt(-0.5));
    const left = batOf();
    // Opposite tilts must put the bat on opposite sides of centre, and by
    // something you could see rather than a nudge.
    expect(Math.sign(right[0])).toBe(-Math.sign(left[0]));
    expect(Math.abs(right[0] - left[0])).toBeGreaterThan(0.4);

    // `hold` freezes the position for the length of a stroke. The pose stays
    // live, so the shot is unaffected; without it a swing drags the bat across
    // the table, in opposite directions on a forehand and a backhand.
    await drive(tilt(0.5), true);
    expect(batOf()).toEqual(left);

    // A swing carrying the wrist's rotation and the hand's velocity. It has to
    // reach the simulation as a hit — `speed`/`dir` alone would still play, but
    // flat, and the spin game is most of this sport.
    await display.waitUntil(
      () => display.snapshots.at(-1)?.phase === 'serve',
      20_000,
      'a serve to take',
    );
    const before = display.snapshots.at(-1)!.ball!;
    for (let i = 0; i < 12 && display.snapshots.at(-1)?.ball?.owner === null; i++) {
      phone.send({
        t: 'SWING',
        seq: 100 + i,
        ctPeak: performance.now(),
        speed: 6.5,
        dir: vnorm([0, 0.68, 0.73]),
        q: [0, 0, 0, 1],
        elev: 0.75,
        omega: [600, 0, 0],
        // Up HARD, and the number matters. The bat's rise is the hand's times
        // PADDLE.SWING_GAIN (0.36), so 6 m/s of hand is 2.16 m/s of bat — which
        // beats the serve toss's 1.8 m/s at every point in its arc. Swing softer
        // than the toss is climbing and the contact point drags UP the face
        // instead of down it, which is backspin: you cannot loop a ball that is
        // rising away from you. That is correct physics, and it made the sign
        // here depend on exactly where in the toss the swing landed.
        vsw: [0, 6.0, 2.4],
      });
      await sleep(180);
    }
    await display.waitUntil(
      () => display.snapshots.at(-1)?.ball?.owner === 0,
      6000,
      'the swing to register as a hit',
    );
    const after = display.snapshots.at(-1)!.ball!;
    // The toss goes straight up; a struck ball goes down the table.
    expect(Math.abs(before.v[2])).toBeLessThan(0.5);
    expect(after.v[2]).toBeGreaterThan(0.5);
    // ...and a stroke that brushed UP the back of it loaded topspin, which no
    // other sport in this protocol can even express. The sign is the whole point:
    // `omega` and `vsw` exist so a swing can say which way the hand went, and a
    // controller that sent only a speed and a direction would produce a flat ball
    // here rather than a wrong one.
    expect(after.spin).toBeGreaterThan(0);

    phone.close();
    display.close();
  }, 60_000);
});

describe('playing another human', () => {
  it('hands the invite link and the second seat to a lone display', async () => {
    const a = new Client('display');
    await a.open();
    a.send({ t: 'HELLO', role: 'display' });
    await a.waitFor('WELCOME');
    a.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    const state = await a.waitFor('ROOM_STATE');

    // The invite opens a second display on the same origin that served this one.
    expect(new URL(state.joinUrl).searchParams.get('room')).toBe(state.room);

    // Nobody else is here yet, and this screen still advertises only its own
    // seat: there is one camera and one court view, so a second phone on this
    // screen was never a second player, only a second person swinging at
    // somebody else's view.
    expect(state.theirDisplay).toBe(false);
    const frag = new URLSearchParams(state.pairUrl.split('#')[1]);
    expect(frag.get('s')).toBe(String(state.seat));
    expect(frag.get('r')).toBe(state.room);

    a.close();
  }, 20_000);

  it('plays two phones against each other on one screen', async () => {
    const display = new Client('display');
    await display.open();
    display.send({ t: 'HELLO', role: 'display' });
    await display.waitFor('WELCOME');
    display.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    const state = await display.waitFor('ROOM_STATE');

    // One screen per player, which is the only way two people play: there is a
    // single camera and a single court view, so a second phone on one screen was
    // never a second player. The friend opens the invite link and scans the code
    // their OWN screen shows them.
    const away = new Client('display');
    await away.open();
    away.send({ t: 'HELLO', role: 'display' });
    await away.waitFor('WELCOME');
    away.send({ t: 'ROOM_JOIN', room: state.room });
    const awayState = await away.waitFor('ROOM_STATE');
    const displays = [display, away];

    const phones = await Promise.all(
      [state, awayState].map(async (st, seat) => {
        const frag = new URLSearchParams(st.pairUrl.split('#')[1]);
        const phone = new Client('controller');
        await phone.open();
        phone.send({
          t: 'HELLO',
          role: 'controller',
          room: frag.get('r'),
          seat: Number(frag.get('s')),
          pairToken: frag.get('t'),
        });
        await phone.waitFor('PAIRED');
        return phone;
      }),
    );

    phones[0].send({ t: 'CALIBRATED', yawOffset: 0 });
    phones[0].send({ t: 'READY', name: 'Ada' });
    phones[1].send({ t: 'CALIBRATED', yawOffset: 0 });
    phones[1].send({ t: 'READY', name: 'Bo' });

    // Both seats ready is the start signal; nobody has to press anything.
    const started = await display.waitFor('MATCH_START', 20_000);
    expect(started.names).toEqual(['Ada', 'Bo']);

    await display.waitUntil(() => display.snapshots.length > 3, 8000, 'snapshots');
    const players = display.snapshots.at(-1)!.players;
    expect(players.map((p) => p.bot)).toEqual([false, false]);
    expect(players.map((p) => p.name)).toEqual(['Ada', 'Bo']);

    for (const p of phones) p.close();
    display.close();
  }, 60_000);

  it('seats the first bot opposite you, and the second one in your own seat', async () => {
    // The order matters in both directions. First press must not bot the seat you
    // are sitting in while the far side is empty; second press must still be able
    // to, because two presses is how you set two bots playing each other — which
    // is also how the long-running match tests drive a game to its end.
    const display = new Client('display');
    await display.open();
    display.send({ t: 'HELLO', role: 'display' });
    await display.waitFor('WELCOME');
    display.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    await display.waitFor('ROOM_STATE');

    display.send({ t: 'ADD_BOT', skill: 0.9 });
    await display.waitUntil(
      () => display.latest('ROOM_STATE')?.seats[1].bot === true,
      4000,
      'a bot on seat 2',
    );
    expect(display.latest('ROOM_STATE')!.seats[0].bot).toBe(false);

    display.send({ t: 'ADD_BOT', skill: 0.1 });
    await display.waitUntil(
      () => display.latest('ROOM_STATE')?.seats[0].bot === true,
      4000,
      'a bot on seat 1 too',
    );
    expect(display.inbox.some((m) => m.t === 'ERROR')).toBe(false);

    display.close();
  }, 20_000);

  it('keeps two players apart when they arrive with the same name', async () => {
    // Trivially reachable: the display generates a name and remembers it in
    // localStorage, so two browser windows on one machine both turn up as it.
    // The commentator speaks "{player}" and "{opponent}" out loud, and "Ada takes
    // it from Ada" is not a sentence about a match.
    const display = new Client('display');
    await display.open();
    display.send({ t: 'HELLO', role: 'display' });
    await display.waitFor('WELCOME');
    display.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    const state = await display.waitFor('ROOM_STATE');

    // One screen per player, which is the only way two people play: there is a
    // single camera and a single court view, so a second phone on one screen was
    // never a second player. The friend opens the invite link and scans the code
    // their OWN screen shows them.
    const away = new Client('display');
    await away.open();
    away.send({ t: 'HELLO', role: 'display' });
    await away.waitFor('WELCOME');
    away.send({ t: 'ROOM_JOIN', room: state.room });
    const awayState = await away.waitFor('ROOM_STATE');
    const displays = [display, away];

    const phones = await Promise.all(
      [state, awayState].map(async (st, seat) => {
        const frag = new URLSearchParams(st.pairUrl.split('#')[1]);
        const phone = new Client('controller');
        await phone.open();
        phone.send({
          t: 'HELLO',
          role: 'controller',
          room: frag.get('r'),
          seat: Number(frag.get('s')),
          pairToken: frag.get('t'),
        });
        await phone.waitFor('PAIRED');
        return phone;
      }),
    );

    // One at a time: whoever readies first keeps the plain name, and a test that
    // races the two has no business asserting which.
    phones[0].send({ t: 'READY', name: 'Ada' });
    await sleep(250);
    phones[1].send({ t: 'READY', name: 'ada' });

    const started = await display.waitFor('MATCH_START', 20_000);
    expect(started.names[0]).toBe('Ada');
    // Case-insensitively the same name, so it is still disambiguated: read out
    // loud, "ada" and "Ada" are the same word.
    expect(started.names[1].toLowerCase()).not.toBe('ada');
    expect(started.names[1].toLowerCase()).toContain('ada');

    for (const p of phones) p.close();
    display.close();
  }, 60_000);

  it('refuses to bot over an opponent who is still connecting', async () => {
    const a = new Client('display');
    const b = new Client('display');
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'HELLO', role: 'display' });
    await a.waitFor('WELCOME');
    a.send({ t: 'ROOM_CREATE', sport: 'pickleball' });
    const state = await a.waitFor('ROOM_STATE');

    b.send({ t: 'HELLO', role: 'display' });
    await b.waitFor('WELCOME');
    b.send({ t: 'ROOM_JOIN', room: state.room });
    const bState = await b.waitFor('ROOM_STATE');
    expect(bState.seat).toBe(1);

    // Host pairs a phone and gets impatient.
    const aFrag = new URLSearchParams(state.pairUrl.split('#')[1]);
    const aPhone = new Client('controller');
    await aPhone.open();
    aPhone.send({
      t: 'HELLO',
      role: 'controller',
      room: state.room,
      seat: 0,
      pairToken: aFrag.get('t'),
    });
    await aPhone.waitFor('PAIRED');
    aPhone.send({ t: 'READY', name: 'Ada' });

    a.send({ t: 'START' });
    const err = await a.waitFor('ERROR');
    expect(err.code).toBe('SEAT_NOT_READY');
    // Emphatically not started: the whole point is that seat 1 is a person.
    await sleep(600);
    expect(a.inbox.some((m) => m.t === 'MATCH_START')).toBe(false);

    // The friend finishes pairing, and the match starts on its own.
    const bFrag = new URLSearchParams(bState.pairUrl.split('#')[1]);
    const bPhone = new Client('controller');
    await bPhone.open();
    bPhone.send({
      t: 'HELLO',
      role: 'controller',
      room: state.room,
      seat: 1,
      pairToken: bFrag.get('t'),
    });
    await bPhone.waitFor('PAIRED');
    bPhone.send({ t: 'READY', name: 'Bo' });

    const started = await b.waitFor('MATCH_START', 20_000);
    expect(started.names).toEqual(['Ada', 'Bo']);

    aPhone.close();
    bPhone.close();
    a.close();
    b.close();
  }, 60_000);
});
