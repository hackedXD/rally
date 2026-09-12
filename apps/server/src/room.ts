/**
 * A Room is one match: a sport, two seats, a simulation, and a commentary
 * director.
 *
 * Each player has their own display and their own phone, and they are remote from
 * each other — so a room fans out to up to two displays and up to two
 * controllers, and "your paddle" is forwarded to one display only.
 */

import {
  NAME_MAX,
  QUAT_IDENTITY,
  TUNING,
  dequantQuat,
  lane,
  otherSeat,
  qFromAxisAngle,
  qmul,
  roomCode as makeRoomCode,
  sanitizeName,
  seatSign,
  shortId,
  type GameEvent,
  type Millis,
  type Quat,
  type CueKind,
  type S2D,
  type Seat,
  type SeatInfo,
  type SportId,
  type SwingInput,
  type Vec3,
} from '@rally/protocol';
import {
  Bot,
  Match,
  PingPongMatch,
  SPORT_ORDER,
  getSport,
  pingpong,
  sportMeta,
  type BotView,
  type MatchEngine,
  type SportModule,
} from '@rally/sim';
import { CommentaryDirector } from './commentary/director.js';
import { EventBus } from './eventbus.js';
import { log } from './log.js';
import type { ReplayRecorder } from './replay.js';
import type { Conn } from './wire.js';

const logger = log.child('room');

/**
 * Seat 1 plays from the far end, so its paddle faces the other way.
 *
 * Controllers report orientation in a canonical player frame where +Z is "toward
 * the net". Mapping that onto the seat here means neither the phone nor the
 * simulation has to know which end of the court it is on.
 */
const SEAT1_FLIP: Quat = qFromAxisAngle([0, 1, 0], Math.PI);

/** True for sports simulated by the table tennis engine rather than the shared one. */
function usesPingPong(sport: SportModule): boolean {
  return sport.id === 'tabletennis';
}

/**
 * The simulation for a sport.
 *
 * Two engines, picked here and nowhere else. Everything downstream drives a
 * `MatchEngine` and never asks which one it got — see the interface for why the
 * seam is at this level rather than inside a sport module.
 */
function makeEngine(sport: SportModule, seed: number): MatchEngine {
  const names: [string, string] = ['Player 1', 'Player 2'];
  return usesPingPong(sport)
    ? new PingPongMatch({ sport, seed, names })
    : new Match({ sport, seed, names });
}

/**
 * How long a pair token stays scannable.
 *
 * Refreshed on every lobby broadcast rather than fixed from room creation: a
 * room waiting for a friend to arrive is a room whose QR code is on screen right
 * now, and expiring it out from under them turns "I'll text you the link" into
 * "rescan, it says the code is dead". The window still closes once the match
 * starts, which is when a code photographed off a screen would actually matter.
 */
const PAIR_TOKEN_TTL_MS = 5 * 60_000;

export function poseToWorld(seat: Seat, q: Quat): Quat {
  return lane(seat) === 1 ? qmul(SEAT1_FLIP, q) : q;
}

export function dirToWorld(seat: Seat, d: Vec3): Vec3 {
  return lane(seat) === 1 ? [-d[0], d[1], -d[2]] : d;
}

interface SeatSlot {
  seat: Seat;
  display: Conn | null;
  controller: Conn | null;
  name: string | null;
  ready: boolean;
  /**
   * Has this seat readied up for the NEXT POINT?
   *
   * Separate from `ready`, which is the lobby's "I am here" and latches for the
   * session. This one clears at the end of every point and is the gate on the
   * next serve.
   */
  pointReady: boolean;
  bot: Bot | null;
  pairToken: string;
  tokenUsed: boolean;
  tokenExpires: Millis;
  /** When the controller dropped, for the disconnect grace window. */
  droppedAt: Millis | null;
  pose: Quat;
  /**
   * The pose exactly as the phone sent it, in the canonical player frame.
   *
   * `pose` above is already mapped onto this seat's end of the court, which is
   * what the shared simulation wants. The table tennis engine does that mapping
   * itself — `paddleFrame` picks the bat face that looks down the table, which
   * it can only do from an unmapped pose — so it is handed this one instead.
   */
  rawPose: Quat;
  poseCt: number;
  /**
   * Table tennis: forward lean and cross-body travel, metres, and whether a
   * stroke is in progress.
   */
  reach: number;
  sway: number;
  holdPose: boolean;
  yawOffset: number;
  paused: boolean;
}

export type RoomPhase = 'lobby' | 'preparing' | 'live' | 'finished';

export class Room {
  readonly code: string;
  sport: SportModule;
  match: MatchEngine;
  readonly bus = new EventBus();
  readonly director: CommentaryDirector;
  phase: RoomPhase = 'lobby';
  muted = false;
  createdAt: Millis;
  lastActivity: Millis;

  private slots: SeatSlot[];
  private serveRequests: Seat[] = [];
  /** When the last seat readied up, so the serve can wait a beat after it. */
  private pointReadyAt: Millis = 0;
  /** This point's beat, drawn once so it cannot jitter frame to frame. */
  private pointReadyDelay = 0;
  private lastSnapshotAt = -1e9;
  private lastLiteAt = -1e9;
  private seed: number;
  private recorder: ReplayRecorder | null = null;

  constructor(
    sportId: SportId,
    private readonly now: () => Millis,
    seed = Math.floor(Math.random() * 0x7fffffff),
    rand: () => number = Math.random,
  ) {
    this.code = makeRoomCode(rand);
    this.sport = getSport(sportId);
    this.seed = seed;
    this.createdAt = now();
    this.lastActivity = now();
    this.slots = [0, 1].map((i) => this.blankSlot(i as Seat, rand));
    this.match = makeEngine(this.sport, seed);
    this.director = new CommentaryDirector(
      {
        sport: this.sport,
        names: () => this.names(),
        now: this.now,
        stats: () => this.match.getStats(),
        score: () => this.match.getScore(),
        phase: () => this.match.phase,
        rally: () => this.match.rally,
        broadcast: (msg) => this.toDisplays(msg),
        broadcastAudio: (id, bytes) => this.audioToDisplays(id, bytes),
      },
      seed,
    );
    this.bus.on((e) => this.director.onEvent(e));
    this.bus.on((e) => this.recorder?.event(e));
  }

  private blankSlot(seat: Seat, rand: () => number): SeatSlot {
    return {
      seat,
      display: null,
      controller: null,
      name: null,
      ready: false,
      pointReady: false,
      bot: null,
      pairToken: shortId(22, rand),
      tokenUsed: false,
      tokenExpires: this.now() + PAIR_TOKEN_TTL_MS,
      droppedAt: null,
      pose: QUAT_IDENTITY,
      rawPose: QUAT_IDENTITY,
      poseCt: 0,
      reach: 0,
      sway: 0,
      holdPose: false,
      yawOffset: 0,
      paused: false,
    };
  }

  setRecorder(recorder: ReplayRecorder | null): void {
    this.recorder = recorder;
  }

  // ── Membership ──────────────────────────────────────────────────────────────

  names(): [string, string] {
    return [
      this.slots[0].name ?? (this.slots[0].bot ? 'Robo' : 'Player 1'),
      this.slots[1].name ?? (this.slots[1].bot ? 'Robo' : 'Player 2'),
    ];
  }

  /** Attach a display and give it a seat. Returns null when the room is full. */
  addDisplay(conn: Conn): Seat | null {
    const free = this.slots.find((s) => s.display === null);
    if (!free) return null;
    free.display = conn;
    conn.roomCode = this.code;
    conn.seat = free.seat;
    this.touch();
    return free.seat;
  }

  /**
   * Pair a controller. Pair tokens are single-use and time-limited (see
   * PAIR_TOKEN_TTL_MS): rejecting a reused token prevents the confusing failure
   * where two phones fight over one seat.
   */
  pairController(conn: Conn, seat: Seat, token: string): { ok: true } | { ok: false; code: string; message: string } {
    const slot = this.slots[lane(seat)];
    if (!slot) return { ok: false, code: 'NO_SEAT', message: 'That seat does not exist.' };
    if (slot.pairToken !== token) {
      return { ok: false, code: 'BAD_TOKEN', message: 'That QR code is not valid for this room.' };
    }
    if (this.now() > slot.tokenExpires) {
      return { ok: false, code: 'EXPIRED', message: 'That QR code has expired. Reload the display.' };
    }
    // Reconnecting with the same token inside the grace window restores the seat.
    if (slot.tokenUsed && slot.controller && slot.controller !== conn && slot.droppedAt === null) {
      return { ok: false, code: 'SEAT_TAKEN', message: 'Another phone is already on this seat.' };
    }

    slot.tokenUsed = true;
    slot.controller = conn;
    slot.droppedAt = null;
    slot.bot = null;
    conn.roomCode = this.code;
    conn.seat = seat;
    this.match.setBot(seat, false);
    this.touch();
    logger.info(`${this.code}: seat ${seat} paired (${conn.id})`);
    return { ok: true };
  }

  /**
   * Hand a seat back to the room: no phone, no name, not ready, new token.
   *
   * The QR the display is showing is built from `pairToken`, so the display has
   * to be told — `broadcastRoomState` is how the new code reaches the screen.
   */
  private releaseSeat(slot: SeatSlot): void {
    slot.controller = null;
    slot.droppedAt = null;
    slot.ready = false;
    slot.pointReady = false;
    slot.name = null;
    slot.paused = false;
    slot.pairToken = shortId(22, Math.random);
    slot.tokenUsed = false;
    slot.tokenExpires = this.now() + PAIR_TOKEN_TTL_MS;
    this.match.setNames(this.names());
  }

  removeConn(conn: Conn): void {
    for (const slot of this.slots) {
      if (slot.display === conn) slot.display = null;
      // `droppedAt === null` guards against re-stamping: a socket can be dropped
      // twice (the heartbeat terminates it, then the close event arrives), and
      // restarting the grace window each time would extend it indefinitely.
      if (slot.controller === conn && slot.droppedAt === null) {
        if (this.phase === 'live' || this.phase === 'preparing') {
          // Mid-match: freeze rather than forfeit. Ten-second grace window, then
          // the point is awarded — see tick().
          slot.droppedAt = this.now();
          logger.info(`${this.code}: seat ${slot.seat} controller dropped`);
        } else {
          // Outside a match there is nothing to hold the seat for, and holding it
          // is actively wrong: the lobby goes on showing a player who has closed
          // the tab, and the next phone to walk up finds the seat taken by a
          // ghost. Give it back, with a fresh token — pair tokens are single-use,
          // so reusing the old one fails the next scan and looks like a broken QR.
          this.releaseSeat(slot);
          logger.info(`${this.code}: seat ${slot.seat} released (left the lobby)`);
        }
      }
    }
    this.touch();
  }

  get empty(): boolean {
    return this.slots.every((s) => s.display === null && s.controller === null);
  }

  seatInfo(): SeatInfo[] {
    return this.slots.map((s) => ({
      seat: s.seat,
      name: s.name,
      ready: s.ready,
      paired: s.controller !== null || s.bot !== null,
      bot: s.bot !== null,
      connected: s.controller !== null ? s.droppedAt === null : s.bot !== null,
    }));
  }

  tokenFor(seat: Seat): string {
    return this.slots[lane(seat)].pairToken;
  }

  /** True when a display of its own is sitting on this seat. */
  hasDisplay(seat: Seat): boolean {
    return this.slots[lane(seat)].display !== null;
  }

  // ── Controller input ────────────────────────────────────────────────────────

  setReady(seat: Seat, name: string): void {
    this.setName(seat, name);
    this.slots[lane(seat)].ready = true;
    this.touch();
  }

  /**
   * Rename a seat, without touching whether it is ready.
   *
   * Separate from READY because the screen may own the name before any phone
   * exists — somebody types it in the lobby and then scans the code — and
   * because marking a seat ready is what starts matches.
   *
   * The opponent's phone is told directly. It learned the name it is showing
   * from its PAIRED, which is sent once; without this it goes on displaying
   * whoever the other player used to be until the first point is scored.
   */
  setName(seat: Seat, name: string): void {
    const slot = this.slots[lane(seat)];
    const next = this.uniqueName(name, seat);
    if (next === slot.name) return;
    slot.name = next;
    this.match.setNames(this.names());
    this.slots[lane(otherSeat(seat))].controller?.send({
      t: 'PAIRED',
      seat: otherSeat(seat),
      room: this.code,
      sport: this.sport.id,
      opponent: next,
    });
    this.touch();
  }

  /**
   * Keep the two players distinguishable.
   *
   * The commentator builds every line out of "{player}" and "{opponent}", so two
   * people called the same thing produce "Ada takes it from Ada" — spoken out
   * loud, in front of an audience. Easy to hit without trying: the display
   * generates a name and remembers it in localStorage, so two browser windows on
   * one machine arrive with exactly the same one.
   */
  private uniqueName(raw: string, seat: Seat): string {
    const fallback = `Player ${lane(seat) + 1}`;
    const name = sanitizeName(raw, fallback);
    const taken = this.slots[lane(otherSeat(seat))].name;
    if (!taken || taken.toLowerCase() !== name.toLowerCase()) return name;
    const suffixed = `${name.slice(0, NAME_MAX - 3).trimEnd()} II`;
    return suffixed.toLowerCase() === taken.toLowerCase() ? fallback : suffixed;
  }

  /**
   * Have the commentator teach one tutorial step.
   *
   * The room supplies the two things the display cannot be trusted for: which
   * sport is actually being played, and which seat is asking. The words are the
   * commentator's own — see `commentary/tutor.ts`.
   */
  coach(seat: Seat, step: string, nudge: boolean): void {
    void this.director.coach(step, this.sport.id, seat, nudge);
  }

  setCalibrated(seat: Seat, yawOffset: number): void {
    this.slots[lane(seat)].yawOffset = yawOffset;
  }

  setPaused(seat: Seat, paused: boolean): void {
    this.slots[lane(seat)].paused = paused;
  }

  /** Pose, forwarded straight to this seat's own display (transport path A). */
  onPose(
    seat: Seat,
    quantised: readonly number[],
    ct: number,
    z?: number,
    dx?: number,
    hold?: boolean,
  ): void {
    const slot = this.slots[lane(seat)];
    const raw = dequantQuat(quantised);
    slot.rawPose = raw;
    slot.pose = poseToWorld(seat, raw);
    slot.poseCt = ct;
    if (Number.isFinite(z)) slot.reach = z as number;
    if (Number.isFinite(dx)) slot.sway = dx as number;
    slot.holdPose = hold === true;
    // Out of band and immediate: your own paddle should feel instant. Everything
    // else can be interpolated.
    //
    // Always a WORLD-frame paddle orientation, whichever engine is running — the
    // display draws a bat from it and must not have to know how the seat mapping
    // works. The two engines just arrive at it differently.
    const q = usesPingPong(this.sport)
      ? pingpong.paddleFrame(lane(seat), pingpong.toPpPose(raw)).worldQ
      : slot.pose;
    slot.display?.send({ t: 'LOCALPOSE', seat, q, ct });
  }

  onSwing(seat: Seat, swing: SwingInput, conn: Conn): void {
    if (this.phase !== 'live') return;
    // Swung before readying up. Told about it rather than dropped: a swing that
    // does nothing and says nothing reads as a broken sensor, and the phone
    // turns this cue into the same buzz a miss gets.
    if (this.serveGate(this.now())) {
      conn.send({ t: 'CUE', kind: 'whiff' });
      return;
    }
    // The table tennis engine wants the swing exactly as the phone reported it:
    // `vsw` is in the player's own motion frame and `paddleFrame` does the seat
    // mapping itself, so pre-rotating either would apply the flip twice.
    const world: SwingInput = usesPingPong(this.sport)
      ? swing
      : { ...swing, dir: dirToWorld(seat, swing.dir), q: poseToWorld(seat, swing.q) };
    // Convert the client's clock into server time; the simulation rewinds from
    // there, bounded by MAX_REWIND.
    const tServer = conn.clockSynced ? conn.toServer(swing.ctPeak) : this.now();
    this.match.applySwing(seat, world, tServer);
    // What a replay has to feed back in is the moment the swing was APPLIED, and
    // for the shared engine those are the same thing — it rewinds to `tServer`,
    // so replaying at `tServer` reproduces it exactly. The table tennis engine
    // does not rewind (see its `applySwing`), so its swings land at the tick they
    // arrived on, and that is the timestamp its replays need.
    this.recorder?.swing(seat, world, usesPingPong(this.sport) ? this.now() : tServer);
    this.touch();
  }

  /**
   * Ready up for the next point, from the phone.
   *
   * Two jobs on one tap, and the second is the one that matters: the phone
   * re-zeros its own yaw as it sends this, so the heading is re-anchored at the
   * start of every single point by somebody doing something they were going to
   * do anyway. Every way of GUESSING where the court is can be wrong. Being told
   * never is.
   */
  setPointReady(seat: Seat): void {
    const slot = this.slots[lane(seat)];
    if (slot.pointReady) return;
    slot.pointReady = true;
    if (this.bothPointReady) {
      this.pointReadyAt = this.now();
      this.pointReadyDelay =
        TUNING.serve.readyDelayMs + Math.random() * TUNING.serve.readyDelayJitterMs;
    }
    // Out of band rather than on the next 400 ms LITE: the other phone is
    // showing a lamp for this, and a lamp that takes half a second to light
    // reads as a button that missed.
    this.sendLite();
    this.touch();
  }

  /**
   * A bot seat is always ready — it has no gyroscope to re-centre and nothing to
   * tap, and making a human wait on it would deadlock every single-player game.
   */
  private seatPointReady(slot: SeatSlot): boolean {
    return slot.bot !== null || slot.pointReady;
  }

  private get bothPointReady(): boolean {
    return this.slots.every((s) => this.seatPointReady(s));
  }

  /** Back to un-ready, which is what makes the tap happen every point. */
  private clearPointReady(): void {
    for (const slot of this.slots) slot.pointReady = false;
  }

  /**
   * Is the next serve held?
   *
   * True while a bat is still being squared up, and for `readyDelayMs` after the
   * last one is — see that constant for why the beat is there. Only ever raised
   * during the serve phase: a gate that stayed up during a rally would freeze a
   * ball that is already in the air.
   */
  private serveGate(now: Millis): boolean {
    if (this.match.phase !== 'serve') return false;
    if (!this.bothPointReady) return true;
    return now - this.pointReadyAt < this.pointReadyDelay;
  }

  requestServe(seat: Seat): void {
    if (!this.serveRequests.includes(seat)) this.serveRequests.push(seat);
    this.touch();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.director.setMuted(muted);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  selectSport(sportId: SportId): boolean {
    if (this.phase === 'live') return false;
    const sport = getSport(sportId);
    if (!sport.playable) return false;
    // An engine swap, not just a reset: the two simulations share no state, so
    // switching to or from table tennis has to replace the object rather than
    // hand a pingpong court to a match that auto-positions players onto it.
    const swap = usesPingPong(sport) !== usesPingPong(this.sport);
    this.sport = sport;
    if (swap) this.match = makeEngine(sport, this.seed);
    else this.match.reset(sport);
    this.match.setNames(this.names());
    // Phones paired before the sport was chosen are holding the wrong swing
    // detector: table tennis onsets a swing on rotation and the others on
    // acceleration. PAIRED is what tells them, so it is sent again.
    for (const slot of this.slots) {
      slot.controller?.send({
        t: 'PAIRED',
        seat: slot.seat,
        room: this.code,
        sport: sport.id,
        opponent: this.names()[lane(otherSeat(slot.seat))],
      });
    }
    this.touch();
    return true;
  }

  /**
   * Seat a bot. `avoid` is the seat of whoever asked.
   *
   * A preference order rather than a filter, because every seat has to stay
   * reachable — pressing this twice is how you set two bots playing each other:
   *
   *   1. an empty seat that is not yours — the ordinary "give me an opponent".
   *      Without this first, Add bot from a player who has not paired a phone yet
   *      lands in their OWN seat, the first one a scan reaches, handing their side
   *      of the court to the computer while the far side sits empty;
   *   2. your own seat — a bot plays for you, and you watch;
   *   3. a seat somebody else's display is sitting at. Last, and only once there
   *      is nowhere else: it takes a waiting player's place.
   */
  addBot(skill: number, avoid: Seat | null = null): Seat | null {
    const open = (s: SeatSlot): boolean => s.controller === null && s.bot === null;
    const yours = (s: SeatSlot): boolean => avoid !== null && lane(s.seat) === lane(avoid);
    const order: ((s: SeatSlot) => boolean)[] = [
      (s) => open(s) && !yours(s) && s.display === null,
      (s) => open(s) && yours(s),
      open,
    ];
    for (const pick of order) {
      const free = this.slots.find(pick);
      if (!free) continue;
      this.seatBot(free, skill);
      return free.seat;
    }
    return null;
  }

  private seatBot(slot: SeatSlot, skill: number): void {
    slot.bot = new Bot(slot.seat, makeBotRng(this.seed + slot.seat), skill);
    slot.name = slot.name ?? botName(slot.seat);
    slot.ready = true;
    this.match.setBot(slot.seat, true, skill);
    this.match.setNames(this.names());
    this.touch();
  }

  get readyToStart(): boolean {
    return this.slots.every((s) => s.ready && (s.controller !== null || s.bot !== null));
  }

  /**
   * A seat that belongs to somebody else's screen and has no phone on it yet.
   *
   * This is the one seat a bot must never be dropped into: a person is sitting
   * there, mid-calibration. Your OWN unpaired seat is fair game — pressing Start
   * without a phone is how you ask to watch the bots play.
   */
  private reservedForSomeoneElse(slot: SeatSlot, requester: Seat | null): boolean {
    if (slot.controller !== null || slot.bot !== null) return false;
    if (slot.display === null) return false;
    return requester === null || lane(slot.seat) !== lane(requester);
  }

  /**
   * Why START from this seat would not start a match right now, or null.
   *
   * Without this, pressing Start while a friend is still calibrating replaces
   * them with a bot, and the match they came for is already over when they
   * finish.
   */
  startBlocker(requester: Seat | null = null): string | null {
    const waiting = this.slots.find((s) => this.reservedForSomeoneElse(s, requester));
    if (!waiting) return null;
    const who = this.slots[lane(waiting.seat)].name ?? `Player ${lane(waiting.seat) + 1}`;
    return `${who} is still connecting a phone. Give them a moment, or add bots and start without them.`;
  }

  /**
   * Start the match. The cold bank is written first and pushed to the displays
   * before the first serve, covered by the lobby's ready-up animation — but it
   * never blocks for more than `prepareCapMs`, because a demo must not stall on
   * somebody else's API.
   */
  async start(requester: Seat | null = null, prepareCapMs = 12_000): Promise<void> {
    if (this.phase === 'live' || this.phase === 'preparing') return;
    // Anyone still unfilled gets a bot, so START always starts something — except
    // a seat held by another player's display, which `startBlocker` has already
    // turned away and which is not ours to fill.
    for (const slot of this.slots) {
      if (
        slot.controller === null &&
        slot.bot === null &&
        !this.reservedForSomeoneElse(slot, requester)
      ) {
        this.seatBot(slot, TUNING.bot.skill);
      }
      slot.ready = true;
    }
    this.phase = 'preparing';
    this.match.setNames(this.names());

    await Promise.race([
      this.director.prepare(),
      new Promise<void>((r) => setTimeout(r, prepareCapMs)),
    ]);

    if (this.phase !== 'preparing') return; // disposed while preparing
    this.phase = 'live';
    this.clearPointReady();
    this.match.reset(this.sport);
    this.match.setNames(this.names());
    this.match.start(this.now());
    for (const slot of this.slots) {
      this.match.setBot(slot.seat, slot.bot !== null, slot.bot?.skill);
    }

    this.toDisplays({
      t: 'MATCH_START',
      sport: this.sport.id,
      st: Math.round(this.now()),
      names: this.names(),
    });
    this.recorder?.start(this.sport.id, this.names(), this.seed);
    logger.info(`${this.code}: match started (${this.names().join(' vs ')})`);
    this.touch();
  }

  /**
   * Call the match off and hand the room back to the lobby.
   *
   * The bots go with it. They were seated by `start()` to fill whatever nobody
   * was holding, and leaving them behind means the next match begins with an
   * opponent nobody asked for — and with `readyToStart` already satisfied, so it
   * could begin on its own before anybody had picked a sport.
   */
  abort(): void {
    if (this.phase === 'lobby') return;
    this.phase = 'lobby';
    this.director.reset();
    this.match.reset(this.sport);
    this.clearPointReady();
    this.serveRequests = [];
    for (const slot of this.slots) {
      if (slot.bot !== null) {
        slot.bot = null;
        this.match.setBot(slot.seat, false);
      }
      // A seat is ready again only if somebody is actually holding it.
      slot.ready = slot.controller !== null;
      slot.paused = false;
    }
    this.recorder?.close();
    this.toDisplays({ t: 'MATCH_ABORT' });
    for (const slot of this.slots) slot.controller?.send({ t: 'CUE', kind: 'match_end' });
    logger.info(`${this.code}: match abandoned`);
    this.touch();
  }

  rematch(): void {
    this.clearPointReady();
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    this.director.reset();
    this.match.reset(this.sport);
    this.match.setNames(this.names());
    this.match.start(this.now());
    this.phase = 'live';
    this.toDisplays({
      t: 'MATCH_START',
      sport: this.sport.id,
      st: Math.round(this.now()),
      names: this.names(),
    });
    this.touch();
  }

  dispose(): void {
    this.director.dispose();
    this.bus.clear();
    this.recorder?.close();
    this.phase = 'finished';
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  tick(dt: number, now: Millis): void {
    if (this.phase !== 'live') return;

    // Disconnect handling: freeze rather than forfeit, then award after the grace
    // window expires.
    let paused = false;
    for (const slot of this.slots) {
      if (slot.bot) continue;
      if (slot.droppedAt !== null) {
        if (now - slot.droppedAt > TUNING.net.disconnectGraceMs) {
          this.awardByDefault(otherSeat(slot.seat));
          return;
        }
        paused = true;
      }
      if (slot.paused) paused = true;
    }

    // Nobody may serve until both bats are ready.
    const gated = this.serveGate(now);
    const phaseBefore = this.match.phase;

    // Bots read the same telegraph the display renders and emit the same swings a
    // phone does, so they exercise the exact strike path a human does. They wait
    // on the ready-up like everyone else — without that the bot serves into a
    // player who is still holding the phone up getting centred, which is exactly
    // the moment the tap exists to protect.
    if (!paused && !gated && !this.match.drivesOwnBots) {
      const telegraph = this.match.getTelegraph();
      const prediction = this.match.getPrediction();
      for (const slot of this.slots) {
        if (!slot.bot) continue;
        const view: BotView = {
          phase: this.match.phase,
          telegraph,
          serverSeat: this.match.getScore().server,
          court: this.sport.court,
          contact: prediction?.p ?? null,
          contactHeight: prediction?.p[1] ?? 0,
          difficulty: this.match.getDifficulty(),
          windowMs: this.match.getParams().windowMs,
        };
        const swing = slot.bot.update(now, view);
        if (swing) {
          this.match.applySwing(
            slot.seat,
            swing,
            this.match.phase === 'serve' ? now : swing.ctPeak,
          );
          this.recorder?.swing(slot.seat, swing, now);
        }
      }
    }

    const pp = usesPingPong(this.sport);
    const snapshot = this.match.step(dt, {
      t: now,
      pose: pp
        ? { 0: this.slots[0].rawPose, 1: this.slots[1].rawPose }
        : { 0: this.slots[0].pose, 1: this.slots[1].pose },
      reach: { 0: this.slots[0].reach, 1: this.slots[1].reach },
      sway: { 0: this.slots[0].sway, 1: this.slots[1].sway },
      holdPose: { 0: this.slots[0].holdPose, 1: this.slots[1].holdPose },
      connected: {
        0: this.slots[0].bot !== null || this.slots[0].droppedAt === null,
        1: this.slots[1].bot !== null || this.slots[1].droppedAt === null,
      },
      serveRequests: this.serveRequests,
      serveGate: gated,
      // Hold play while the commentator still has something to say. Capped
      // inside the director, so a bad estimate slows the game rather than
      // stopping it.
      holdUntil: this.director.airtimeUntil(),
      paused,
    });
    this.serveRequests = [];

    // Any way out of a rally ends the ready-up, the last point of the match
    // included — otherwise the bats stay standing to attention over the end card
    // and a rematch starts with a seat already ready.
    if (phaseBefore === 'rally' && this.match.phase !== 'rally') this.clearPointReady();

    const events = this.match.drainEvents();
    if (events.length) {
      this.bus.publish(events);
      for (const e of events) this.toDisplays({ t: 'EVENT', e });
      for (const e of events) this.cueControllers(e);
    }

    // Snapshots at 30 Hz; pose forwarding is out of band and immediate.
    const snapshotInterval = 1000 / TUNING.net.snapshotHz;
    if (now - this.lastSnapshotAt >= snapshotInterval) {
      this.lastSnapshotAt = now;
      this.toDisplays({
        t: 'SNAPSHOT',
        s: {
          ...snapshot,
          ready: [this.seatPointReady(this.slots[0]), this.seatPointReady(this.slots[1])],
        },
      });
      this.recorder?.snapshot(snapshot);
    }

    // The phone only needs the score, and not often.
    if (now - this.lastLiteAt >= 400) {
      this.lastLiteAt = now;
      this.sendLite();
    }

    if (this.match.phase === 'gameover' && this.phase === 'live') this.finish();
  }

  private finish(): void {
    // Before anything else. The simulation stays in 'gameover' forever, so a
    // guard that only reads the match phase re-fires every tick — 60 MATCH_END
    // broadcasts a second, 60 controller cues, 60 replay writes, and a display
    // that cannot leave the end card because it is slammed back onto it 16 ms
    // after the player navigates away.
    this.phase = 'finished';
    const winner = this.match.getWinner() ?? 0;
    this.toDisplays({
      t: 'MATCH_END',
      winner,
      final: [...this.match.getScore().points] as [number, number],
      summary: this.match.summary(),
    });
    for (const slot of this.slots) {
      slot.controller?.send({ t: 'CUE', kind: 'match_end' });
    }
    this.recorder?.end(winner, this.match.summary());
    logger.info(
      `${this.code}: match finished ${this.match.getScore().points.join('-')} ` +
        `to ${this.names()[lane(winner)]}`,
    );
  }

  private awardByDefault(winner: Seat): void {
    logger.warn(`${this.code}: seat ${otherSeat(winner)} never came back; awarding the match`);
    this.toDisplays({
      t: 'MATCH_END',
      winner,
      final: [...this.match.getScore().points] as [number, number],
      summary: [`${this.names()[lane(otherSeat(winner))]} disconnected.`],
    });
    this.phase = 'finished';
  }

  /**
   * Phone-side feedback. iOS Safari has no Vibration API, so the phone plays a
   * 6 ms filtered-noise click locally on receipt — zero network dependency on the
   * thing that has to feel instant.
   */
  private cueControllers(e: GameEvent): void {
    const send = (seat: Seat, kind: CueKind) => {
      this.slots[lane(seat)].controller?.send({ t: 'CUE', kind });
    };
    switch (e.type) {
      case 'hit':
      case 'serve':
        if (e.seat !== undefined) send(e.seat, 'hit');
        if (e.seat !== undefined) send(otherSeat(e.seat), 'incoming');
        break;
      case 'whiff':
        if (e.seat !== undefined) send(e.seat, 'whiff');
        break;
      case 'point':
        send(Number(e.data.winner) as Seat, 'point_won');
        send(Number(e.data.loser) as Seat, 'point_lost');
        break;
      default:
        break;
    }
    if (this.match.phase === 'serve') {
      this.slots[lane(this.match.getScore().server)].controller?.send({
        t: 'CUE',
        kind: 'your_serve',
      });
    }
  }

  private sendLite(): void {
    const score = this.match.getScore();
    for (const slot of this.slots) {
      const c = slot.controller;
      if (!c) continue;
      c.send({
        t: 'LITE',
        points: [...score.points] as [number, number],
        yourServe: score.server === slot.seat,
        phase: this.match.phase,
        rally: this.match.rally,
        you: slot.seat,
        opponent: this.slots[lane(otherSeat(slot.seat))].name,
        gamePoint: score.gamePoint && score.gamePointSeat === slot.seat,
        ready: [this.seatPointReady(this.slots[0]), this.seatPointReady(this.slots[1])],
        seated: [this.slots[0].controller !== null, this.slots[1].controller !== null],
      });
    }
  }

  // ── Fan-out ─────────────────────────────────────────────────────────────────

  toDisplays(msg: S2D): void {
    for (const slot of this.slots) slot.display?.send(msg);
  }

  audioToDisplays(cueId: string, bytes: Uint8Array): void {
    for (const slot of this.slots) slot.display?.sendAudio(cueId, bytes);
  }

  sportsMeta() {
    return SPORT_ORDER.map((id) => sportMeta(getSport(id)));
  }

  /**
   * Room state is actually sent by the SessionManager, which is the only thing
   * that knows the public origin the QR code needs. This exists so a room can ask
   * for a refresh without reaching back into the session layer.
   */
  broadcastRoomState(): void {
    // The codes are about to be drawn on a screen, so make sure they are still
    // good. See PAIR_TOKEN_TTL_MS.
    if (this.phase === 'lobby') {
      const until = this.now() + PAIR_TOKEN_TTL_MS;
      for (const slot of this.slots) {
        if (slot.controller === null) slot.tokenExpires = until;
      }
    }
    this.touch();
  }

  displayFor(seat: Seat): Conn | null {
    return this.slots[lane(seat)].display;
  }

  private touch(): void {
    this.lastActivity = this.now();
  }
}

function makeBotRng(seed: number) {
  // The bot takes an injected RNG; seeding per seat keeps two bots from acting in
  // lockstep while staying reproducible for a replay.
  let a = (seed ^ 0x5bf03635) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + next() * (hi - lo),
    spread: (m: number) => (next() * 2 - 1) * m,
    chance: (p: number) => next() < p,
    gauss: (sd: number) => ((next() + next() + next() - 1.5) / 0.5) * sd * 0.577,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    state: () => a,
  };
}

const BOT_NAMES = ['Volley', 'Robo'];
function botName(seat: Seat): string {
  return BOT_NAMES[lane(seat)] ?? 'Robo';
}

export { seatSign };
