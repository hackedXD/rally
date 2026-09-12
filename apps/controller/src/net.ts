/**
 * The phone's connection.
 *
 * Two rules from §8.1.4 shape everything here: never block the sensor callback on
 * network work, and send SWING immediately and unbatched — it is the one
 * latency-critical message in the whole protocol.
 *
 * Deliberately free of DOM dependencies beyond `WebSocket`: the URL helpers live
 * in `url.ts`. That is what lets a test drive this exact class against a real
 * server, which is the only way a message-ordering bug is ever caught.
 */

import { leadPose } from '@rally/motion';
import {
  ClockSync,
  TUNING,
  parseMessage,
  quantQuat,
  r,
  s2cSchema,
  type CueKind,
  type MatchPhase,
  type Quat,
  type Seat,
  type SportId,
  type SwingInput,
  type Vec3,
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
  /** Who has readied up for the next point, seat-indexed. A bot seat reads true. */
  ready: [boolean, boolean];
  /** Which seats have a phone on them at all, seat-indexed. */
  seated: [boolean, boolean];
}

export interface NetHandlers {
  onState(state: 'connecting' | 'open' | 'closed'): void;
  onPaired(seat: Seat, opponent: string | null, sport: SportId): void;
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
  private pendingOmega: Vec3 = [0, 0, 0];
  private pendingReach = 0;
  private pendingSway = 0;
  private pendingHold = false;

  /**
   * Horizon the last flushed pose was rotated forward by, ms. Reported on the
   * phone's own readout: prediction is invisible right up until it is the reason
   * nothing works, which is the wrong moment to start guessing at it.
   */
  leadMs = 0;

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

      // HELLO goes out FIRST, before anything else and before the app is told the
      // socket is open. The server rejects any message from a connection that has
      // not identified itself, and the app's own 'open' handler sends CALIBRATED
      // and READY synchronously — so notifying it first puts those on the wire
      // ahead of the handshake and the server answers "send HELLO first".
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

      this.handlers.onState('open');
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
          this.handlers.onPaired(msg.seat, msg.opponent, msg.sport);
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

  /**
   * Buffered; flushed on a timer so the sensor callback never touches the socket.
   *
   * `omegaDeg` is the paddle's rotation rate in its own axes, straight off the
   * gyro. It is buffered alongside the pose rather than sent: what goes on the
   * wire is one predicted pose, and the rate is what predicts it.
   */
  pose(q: Quat, ct: number, omegaDeg: Vec3, reach = 0, sway = 0, hold = false): void {
    this.pendingPose = q;
    this.pendingCt = ct;
    this.pendingOmega = omegaDeg;
    this.pendingReach = reach;
    this.pendingSway = sway;
    this.pendingHold = hold;
  }

  private flushPose(): void {
    if (!this.pendingPose || this.ws?.readyState !== WebSocket.OPEN) return;
    // Latency compensation. The sample has been sitting here since the sensor
    // fired — up to a flush interval — and the wire is about to cost half a round
    // trip on top, so send where the paddle WILL be rather than where it was.
    // Both halves of that are measured; see `leadTime`.
    const { q, leadMs } = leadPose(
      this.pendingPose,
      this.pendingOmega,
      performance.now() - this.pendingCt,
      this.clock.rtt,
    );
    this.leadMs = leadMs;
    this.send({
      t: 'POSE',
      seq: this.seq++,
      // The moment the pose being sent is FOR, which is no longer the moment it
      // was sampled. Stamping it with the sample time would leave anything
      // downstream that reasons about pose age off by exactly the lead.
      ct: this.pendingCt + leadMs,
      q: quantQuat(q),
      // Table tennis only, and omitted rather than zeroed when it does not
      // apply — a field that is always there and always 0 invites somebody to
      // read it as "the hand is at neutral" rather than "not this sport".
      ...(this.pendingReach !== 0 || this.pendingSway !== 0 || this.pendingHold
        ? { z: r(this.pendingReach), dx: r(this.pendingSway), hold: this.pendingHold }
        : {}),
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
      ...(s.omega ? { omega: s.omega.map((v) => Math.round(v)) as Vec3 } : {}),
      ...(s.vsw ? { vsw: s.vsw.map((v) => r(v, 2)) as Vec3 } : {}),
    });
  }

  ready(name: string): void {
    this.send({ t: 'READY', name });
  }

  /** Held at the court and re-centred, for this point. See READY_POINT. */
  readyPoint(): void {
    this.send({ t: 'READY_POINT' });
  }

  rematch(): void {
    this.send({ t: 'REMATCH' });
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
