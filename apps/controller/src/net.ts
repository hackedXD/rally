/**
 * The phone's connection.
 *
 * Two rules from §8.1.4 shape everything here: never block the sensor callback on
 * network work, and send SWING immediately and unbatched — it is the one
 * latency-critical message in the whole protocol.
 */

import {
  ClockSync,
  TUNING,
  parseMessage,
  quantQuat,
  s2cSchema,
  type CueKind,
  type MatchPhase,
  type Quat,
  type Seat,
  type SwingInput,
} from '@rally/protocol';

export interface Pairing {
  room: string;
  seat: Seat;
  token: string;
}

export interface LiteState {
  points: [number, number];
  yourServe: boolean;
  phase: MatchPhase;
  rally: number;
  you: Seat;
  opponent: string | null;
  gamePoint: boolean;
}

export interface NetHandlers {
  onState(state: 'connecting' | 'open' | 'closed'): void;
  onPaired(seat: Seat, opponent: string | null): void;
  onCue(kind: CueKind): void;
  onLite(lite: LiteState): void;
  onError(code: string, message: string): void;
}

export class ControllerNet {
  readonly clock = new ClockSync(() => performance.now());
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private poseTimer: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private seq = 0;
  private closedByUs = false;

  /** Latest pose, flushed on a timer rather than sent from the sensor callback. */
  private pendingPose: Quat | null = null;
  private pendingCt = 0;

  constructor(
    private readonly url: string,
    private readonly pairing: Pairing,
    private readonly handlers: NetHandlers,
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.handlers.onState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onState('open');
      this.send({
        t: 'HELLO',
        role: 'controller',
        room: this.pairing.room,
        seat: this.pairing.seat,
        pairToken: this.pairing.token,
      });
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), TUNING.net.pingIntervalMs);
      // Pose at 30 Hz, not 60: battery and thermals matter over a long demo day,
      // and display-side smoothing makes it visually indistinguishable.
      this.poseTimer = setInterval(() => this.flushPose(), 1000 / TUNING.net.poseHz);
    };

    ws.onmessage = (ev) => {
      const parsed = parseMessage(s2cSchema, String(ev.data));
      if (!parsed.ok) return;
      const msg = parsed.value;
      switch (msg.t) {
        case 'PONG':
          this.clock.accept(msg.c0, msg.st);
          break;
        case 'PAIRED':
          this.handlers.onPaired(msg.seat, msg.opponent);
          break;
        case 'CUE':
          this.handlers.onCue(msg.kind);
          break;
        case 'LITE':
          this.handlers.onLite(msg);
          break;
        case 'ERROR':
          this.handlers.onError(msg.code, msg.message);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      this.stopTimers();
      this.handlers.onState('closed');
      if (!this.closedByUs) this.scheduleReconnect();
    };
    ws.onerror = () => this.handlers.onState('closed');
  }

  /** Buffered; flushed on a timer so the sensor callback never touches the socket. */
  pose(q: Quat, ct: number): void {
    this.pendingPose = q;
    this.pendingCt = ct;
  }

  private flushPose(): void {
    if (!this.pendingPose || this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({
      t: 'POSE',
      seq: this.seq++,
      ct: this.pendingCt,
      q: quantQuat(this.pendingPose),
    });
    this.pendingPose = null;
  }

  /** Sent immediately and unbatched. This is the latency-critical path. */
  swing(s: SwingInput): void {
    this.send({
      t: 'SWING',
      seq: this.seq++,
      ctPeak: s.ctPeak,
      speed: s.speed,
      dir: s.dir,
      q: s.q,
      elev: s.elev,
    });
  }

  ready(name: string): void {
    this.send({ t: 'READY', name });
  }

  calibrated(yawOffset: number): void {
    this.send({ t: 'CALIBRATED', yawOffset });
  }

  serve(): void {
    this.send({ t: 'BUTTON', button: 'serve' });
  }

  mute(): void {
    this.send({ t: 'BUTTON', button: 'mute' });
  }

  paused(paused: boolean): void {
    this.send({ t: 'PAUSE', paused });
  }

  private ping(): void {
    this.send({ t: 'PING', c0: this.clock.stamp(), rtt: this.clock.rtt || undefined });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* the close handler will deal with it */
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnect) return;
    const delay = Math.min(6000, 400 * 2 ** Math.min(this.attempts++, 4));
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect();
    }, delay);
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.poseTimer) clearInterval(this.poseTimer);
    this.pingTimer = null;
    this.poseTimer = null;
  }

  close(): void {
    this.closedByUs = true;
    this.stopTimers();
    this.ws?.close();
  }

  get rtt(): number {
    return this.clock.rtt;
  }
}

/** Same-origin WebSocket URL, so a tunnel needs no configuration. */
export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * Parse the pairing out of the URL FRAGMENT.
 *
 * The token is in the fragment and not the query string on purpose: fragments are
 * not sent to the server in the HTTP request line, so a single-use pair token
 * never lands in an access log.
 */
export function readPairing(): Pairing | null {
  const frag = location.hash.replace(/^#/, '');
  if (!frag) return null;
  const params = new URLSearchParams(frag);
  const room = params.get('r');
  const seat = Number(params.get('s'));
  const token = params.get('t');
  if (!room || !token || !Number.isInteger(seat) || seat < 0 || seat > 3) return null;
  return { room: room.toUpperCase(), seat: seat as Seat, token };
}
