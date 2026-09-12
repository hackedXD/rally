/**
 * The display's connection to the server.
 *
 * One socket, one clock, one snapshot buffer. Every inbound message is validated
 * against the protocol schema except the two hot paths — SNAPSHOT and LOCALPOSE at
 * 30 Hz each — which get structural guards instead, because allocating a
 * validation result sixty times a second on the render thread costs frame time and
 * buys nothing against our own server.
 */

import {
  ClockSync,
  TUNING,
  decodeAudioFrame,
  isLocalPoseish,
  isSnapshotish,
  s2dSchema,
  safeParse,
  type GameEvent,
  type PreloadedCue,
  type S2D,
  type Seat,
  type SeatInfo,
  type Snapshot,
  type SportId,
  type SportMeta,
} from '@rally/protocol';
import { audio } from '../audio/engine.js';
import { SnapshotBuffer } from './snapshots.js';

export type ConnState = 'connecting' | 'open' | 'closed' | 'error';

export interface RoomView {
  code: string;
  seat: Seat;
  pairToken: string;
  pairUrl: string;
  /** Opens this room on a friend's machine; they take the other seat. */
  joinUrl: string;
  /** The other seat's phone link while no second display has claimed it. */
  otherPairUrl: string | null;
  sport: SportId;
  seats: SeatInfo[];
  sports: SportMeta[];
  host: boolean;
}

export interface ClientHandlers {
  onConn(state: ConnState, detail?: string): void;
  onRoom(room: RoomView): void;
  onMatchStart(sport: SportId, names: [string, string]): void;
  onEvent(e: GameEvent): void;
  onMatchEnd(winner: Seat, final: [number, number], summary: string[]): void;
  onLobbyStatus(text: string, progress: number, done: boolean): void;
  onTuning(values: Record<string, number>): void;
  onError(code: string, message: string): void;
}

export class RallyClient {
  readonly clock = new ClockSync(() => performance.now());
  readonly snapshots = new SnapshotBuffer();
  state: ConnState = 'closed';
  room: RoomView | null = null;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByUs = false;
  private pendingSport: SportId = 'pickleball';
  private joinCode: string | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: ClientHandlers,
  ) {}

  connect(sport: SportId, joinCode: string | null = null): void {
    this.pendingSport = sport;
    this.joinCode = joinCode;
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    this.cleanupSocket();
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.attempts = 0;
      this.setState('open');
      this.send({ t: 'HELLO', role: 'display' });
      if (this.joinCode) this.send({ t: 'ROOM_JOIN', room: this.joinCode });
      else this.send({ t: 'ROOM_CREATE', sport: this.pendingSport });

      this.ping();
      this.pingTimer = setInterval(() => this.ping(), TUNING.net.pingIntervalMs);
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const frame = decodeAudioFrame(new Uint8Array(ev.data));
        if (frame) audio.pushStream(frame.id, frame.audio);
        return;
      }
      this.handleText(String(ev.data));
    };

    ws.onerror = () => this.setState('error');
    ws.onclose = () => {
      this.cleanupSocket();
      this.setState('closed');
      if (!this.closedByUs) this.scheduleReconnect();
    };
  }

  private handleText(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const tag = (json as { t?: string }).t;

    // Hot paths first, with cheap structural guards.
    if (tag === 'SNAPSHOT') {
      const s = (json as { s?: unknown }).s;
      if (isSnapshotish(s)) this.snapshots.push(s as Snapshot);
      return;
    }
    if (tag === 'LOCALPOSE') {
      if (isLocalPoseish(json)) {
        this.snapshots.pushLocalPose((json as { q: [number, number, number, number] }).q);
      }
      return;
    }

    const parsed = safeParse(s2dSchema, json);
    if (!parsed.ok) {
      console.warn('[net] dropped invalid message:', parsed.error);
      return;
    }
    this.dispatch(parsed.value);
  }

  private dispatch(msg: S2D): void {
    switch (msg.t) {
      case 'PONG':
        this.clock.accept(msg.c0, msg.st);
        return;

      case 'ROOM_STATE': {
        const view: RoomView = {
          code: msg.room,
          seat: msg.seat,
          pairToken: msg.pairToken,
          pairUrl: msg.pairUrl,
          joinUrl: msg.joinUrl,
          otherPairUrl: msg.otherPairUrl,
          sport: msg.sport,
          seats: msg.seats,
          sports: msg.sports,
          host: msg.host,
        };
        this.room = view;
        this.snapshots.ownSeat = msg.seat;
        this.handlers.onRoom(view);
        return;
      }

      case 'MATCH_START':
        this.snapshots.clear();
        audio.reset();
        this.handlers.onMatchStart(msg.sport, msg.names);
        return;

      case 'EVENT':
        this.handlers.onEvent(msg.e as GameEvent);
        return;

      case 'CUE_PRELOAD':
        void audio.preload(msg.cues as PreloadedCue[]);
        return;

      case 'CUE_PLAY':
        audio.playCue(msg.id, msg.priority);
        return;

      case 'CUE_STREAM_BEGIN':
        audio.beginStream(msg.id, msg.priority, msg.speak ?? false, msg.text);
        return;

      case 'CUE_TEXT':
        audio.streamText(msg.id, msg.text);
        return;

      case 'CUE_STREAM_END':
        void audio.endStream(msg.id);
        return;

      case 'MATCH_END':
        this.handlers.onMatchEnd(msg.winner, msg.final, msg.summary);
        return;

      case 'LOBBY_STATUS':
        this.handlers.onLobbyStatus(msg.text, msg.progress, msg.done);
        return;

      case 'TUNING':
        this.handlers.onTuning(msg.values);
        return;

      case 'ERROR':
        // A shared link outlives the room it points at. Rather than stranding the
        // display with no room at all, open a fresh one and let them start over —
        // the code in the address bar is a hint, not a requirement.
        if (msg.code === 'NO_ROOM' && this.joinCode && !this.room) {
          this.joinCode = null;
          this.send({ t: 'ROOM_CREATE', sport: this.pendingSport });
          this.handlers.onError(msg.code, `${msg.message} Opened a new room instead.`);
          return;
        }
        this.handlers.onError(msg.code, msg.message);
        return;

      default:
        return;
    }
  }

  private ping(): void {
    this.send({ t: 'PING', c0: this.clock.stamp(), rtt: this.clock.rtt || undefined });
  }

  send(msg: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  selectSport(sport: SportId): void {
    this.pendingSport = sport;
    this.send({ t: 'SPORT_SELECT', sport });
  }

  addBot(skill: number): void {
    this.send({ t: 'ADD_BOT', skill });
  }

  /**
   * Move this display into someone else's room, on the live socket.
   *
   * `joinCode` is updated too, so a reconnect lands back in the friend's room
   * rather than silently creating a fresh empty one.
   */
  joinRoom(code: string): void {
    const room = code.trim().toUpperCase();
    if (room.length !== 4) return;
    this.joinCode = room;
    this.send({ t: 'ROOM_JOIN', room });
  }

  start(): void {
    this.send({ t: 'START' });
  }

  rematch(): void {
    this.send({ t: 'REMATCH' });
  }

  audioUnlocked(): void {
    this.send({ t: 'AUDIO_UNLOCKED' });
  }

  setMuted(muted: boolean): void {
    this.send({ t: 'MUTE', muted });
  }

  tune(patch: Record<string, Record<string, number>>): void {
    this.send({ t: 'TUNE', patch });
  }

  serverNow(): number {
    return this.clock.serverNow();
  }

  close(): void {
    this.closedByUs = true;
    this.cleanupSocket();
    this.ws?.close();
  }

  // ── Reconnection ────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempts++, 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Rejoin the same room rather than creating a new one.
      if (this.room) this.joinCode = this.room.code;
      this.open();
    }, delay);
  }

  private cleanupSocket(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
    }
  }

  private setState(state: ConnState, detail?: string): void {
    this.state = state;
    this.handlers.onConn(state, detail);
  }
}

/** Same-origin WebSocket URL, so a tunnel needs no configuration. */
export function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
