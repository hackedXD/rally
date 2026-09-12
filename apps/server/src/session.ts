/**
 * SessionManager — rooms, seats, pairing, and the message router.
 *
 * Everything here is synchronous and cheap: the tick loop runs in the same
 * process, so a slow handler is a dropped frame for every room on the server.
 */

import {
  TUNING,
  applyTuningPatch,
  flattenTuning,
  type AnyInbound,
  type C2S,
  type D2S,
  type Millis,
  type Seat,
  type SportId,
} from '@rally/protocol';
import { Room } from './room.js';
import { makeRecorder } from './replay.js';
import { log } from './log.js';
import type { Conn } from './wire.js';

const logger = log.child('session');

/** Rooms with nobody in them are reaped after this long. */
const IDLE_REAP_MS = 10 * 60_000;

export class SessionManager {
  private rooms = new Map<string, Room>();
  private conns = new Set<Conn>();
  /** Resolves the public origin used to build the controller QR URL. */
  originFor: (conn: Conn) => string = () => 'http://localhost:8787';

  constructor(private readonly now: () => Millis) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  get connCount(): number {
    return this.conns.size;
  }

  register(conn: Conn): void {
    this.conns.add(conn);
  }

  drop(conn: Conn): void {
    this.conns.delete(conn);
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : null;
    room?.removeConn(conn);
    if (room) room.broadcastRoomState(), this.decorateRoomState(room);
  }

  // ── Routing ─────────────────────────────────────────────────────────────────

  handle(conn: Conn, msg: AnyInbound): void {
    conn.lastSeen = this.now();

    if (msg.t === 'PING') {
      conn.observePing(msg.c0, this.now(), msg.rtt);
      conn.send({ t: 'PONG', c0: msg.c0, st: Math.round(this.now()) });
      return;
    }

    if (msg.t === 'HELLO') {
      this.onHello(conn, msg);
      return;
    }

    if (conn.role === 'display') this.onDisplay(conn, msg as D2S);
    else if (conn.role === 'controller') this.onController(conn, msg as C2S);
    else conn.send({ t: 'ERROR', code: 'NO_HELLO', message: 'Send HELLO first.' });
  }

  private onHello(conn: Conn, msg: Extract<AnyInbound, { t: 'HELLO' }>): void {
    conn.role = msg.role;
    conn.send({ t: 'WELCOME', clientId: conn.id, st: Math.round(this.now()) });

    if (msg.role === 'controller') {
      const room = this.rooms.get(msg.room);
      if (!room) {
        conn.send({ t: 'ERROR', code: 'NO_ROOM', message: 'That room is gone. Rescan the QR code.' });
        return;
      }
      const result = room.pairController(conn, msg.seat, msg.pairToken);
      if (!result.ok) {
        conn.send({ t: 'ERROR', code: result.code, message: result.message });
        return;
      }
      conn.send({
        t: 'PAIRED',
        seat: msg.seat,
        room: room.code,
        sport: room.sport.id,
        opponent: room.names()[msg.seat === 0 ? 1 : 0],
      });
      this.refresh(room);
    }
  }

  private onDisplay(conn: Conn, msg: D2S): void {
    switch (msg.t) {
      case 'ROOM_CREATE': {
        const room = new Room(msg.sport, this.now);
        room.setRecorder(makeRecorder(room.code, this.now));
        this.rooms.set(room.code, room);
        room.addDisplay(conn);
        logger.info(`room ${room.code} created (${msg.sport}), ${this.rooms.size} live`);
        this.refresh(room);
        return;
      }

      case 'ROOM_JOIN': {
        const room = this.rooms.get(msg.room);
        if (!room) {
          conn.send({ t: 'ERROR', code: 'NO_ROOM', message: 'No room with that code.' });
          return;
        }
        if (room.addDisplay(conn) === null) {
          conn.send({ t: 'ERROR', code: 'FULL', message: 'That room is full.' });
          return;
        }
        this.refresh(room);
        return;
      }

      case 'SPORT_SELECT': {
        const room = this.roomOf(conn);
        if (!room) return;
        if (!room.selectSport(msg.sport)) {
          conn.send({
            t: 'ERROR',
            code: 'NOT_PLAYABLE',
            message: 'That sport ships as an interface stub, not a game.',
          });
        }
        this.refresh(room);
        return;
      }

      case 'ADD_BOT': {
        const room = this.roomOf(conn);
        if (!room) return;
        if (room.addBot(msg.skill) === null) {
          conn.send({ t: 'ERROR', code: 'FULL', message: 'Both seats are taken.' });
        }
        this.refresh(room);
        return;
      }

      case 'READY':
      case 'START': {
        const room = this.roomOf(conn);
        if (!room) return;
        void room.start();
        return;
      }

      case 'REMATCH': {
        const room = this.roomOf(conn);
        room?.rematch();
        return;
      }

      case 'AUDIO_UNLOCKED':
        conn.audioUnlocked = true;
        return;

      case 'MUTE': {
        const room = this.roomOf(conn);
        conn.muted = msg.muted;
        room?.setMuted(msg.muted);
        return;
      }

      case 'TUNE': {
        // Dev-only live tuning. Patch the globals, then have every room re-resolve
        // its own constants — sport values are per-match by design.
        applyTuningPatch(msg.patch);
        for (const room of this.rooms.values()) room.match.refreshParams();
        const values = flattenTuning(TUNING);
        for (const room of this.rooms.values()) room.toDisplays({ t: 'TUNING', values });
        logger.info('tuning patched', Object.keys(msg.patch).join(','));
        return;
      }

      default:
        return;
    }
  }

  private onController(conn: Conn, msg: C2S): void {
    const room = this.roomOf(conn);
    const seat = conn.seat;
    if (!room || seat === null) return;

    switch (msg.t) {
      case 'POSE':
        room.onPose(seat, msg.q, msg.ct);
        return;
      case 'SWING':
        room.onSwing(seat, msg, conn);
        return;
      case 'BUTTON':
        if (msg.button === 'serve') room.requestServe(seat);
        else room.setMuted(!room.muted);
        return;
      case 'CALIBRATED':
        room.setCalibrated(seat, msg.yawOffset);
        return;
      case 'READY':
        room.setReady(seat, msg.name);
        this.refresh(room);
        if (room.readyToStart && room.phase === 'lobby') void room.start();
        return;
      case 'PAUSE':
        room.setPaused(seat, msg.paused);
        return;
      default:
        return;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private roomOf(conn: Conn): Room | null {
    return conn.roomCode ? this.rooms.get(conn.roomCode) ?? null : null;
  }

  /** Re-send ROOM_STATE with the pair URL filled in. */
  private refresh(room: Room): void {
    room.broadcastRoomState();
    this.decorateRoomState(room);
  }

  /**
   * The display needs a complete URL for its QR code, and only the server knows
   * the public origin — so the server builds it rather than having the display
   * guess. The pair token goes in the URL FRAGMENT: fragments are not sent in the
   * HTTP request line and so never land in an access log.
   */
  private decorateRoomState(room: Room): void {
    for (const seat of [0, 1] as Seat[]) {
      const display = room.displayFor(seat);
      if (!display) continue;
      const origin = this.originFor(display);
      const url =
        `${origin}/c#r=${room.code}&s=${seat}&t=${encodeURIComponent(room.tokenFor(seat))}`;
      display.send({
        t: 'ROOM_STATE',
        room: room.code,
        seat,
        pairToken: room.tokenFor(seat),
        pairUrl: url,
        sport: room.sport.id,
        seats: room.seatInfo(),
        sports: room.sportsMeta(),
        host: seat === 0,
      });
    }
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  tickRooms(dt: number, now: Millis): void {
    for (const room of this.rooms.values()) room.tick(dt, now);
  }

  /** Reap idle rooms. Called occasionally, never in the hot path. */
  sweep(now: Millis): void {
    for (const [code, room] of this.rooms) {
      if (room.empty && now - room.lastActivity > IDLE_REAP_MS) {
        room.dispose();
        this.rooms.delete(code);
        logger.info(`room ${code} reaped`);
      }
    }
  }

  roomList(): { code: string; sport: SportId; phase: string; seats: number }[] {
    return [...this.rooms.values()].map((r) => ({
      code: r.code,
      sport: r.sport.id,
      phase: r.phase,
      seats: r.seatInfo().filter((s) => s.paired).length,
    }));
  }

  disposeAll(): void {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }
}
