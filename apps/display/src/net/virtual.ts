/**
 * The keyboard-and-mouse controller.
 *
 * It opens its OWN WebSocket as `role: 'controller'` and speaks the exact same
 * protocol a phone does, using this display's own pair token. Nothing on the
 * server knows the difference, which is the point: no special-casing, no second
 * input path to keep in sync, and the desk-bound version of the game exercises
 * precisely the code the phone version does.
 *
 * Mouse position aims the paddle. Hold to wind up, release to swing — the charge
 * maps to swing speed, so the same shot vocabulary is available.
 */

import {
  TUNING,
  qFromUnitZTo,
  quantQuat,
  vnorm,
  type Seat,
  type Vec3,
} from '@rally/protocol';

export interface VirtualState {
  connected: boolean;
  charge: number;
  aim: { x: number; y: number };
  lastSwingSpeed: number;
  yourServe: boolean;
  swings: number;
}

const MAX_CHARGE_MS = 620;

export class VirtualController {
  private ws: WebSocket | null = null;
  private raf = 0;
  private poseTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private chargeStart: number | null = null;

  /** Aim, normalised: x is -1 (left) to 1 (right), y is -1 (low) to 1 (high). */
  private aimX = 0;
  private aimY = 0.28;

  state: VirtualState = {
    connected: false,
    charge: 0,
    aim: { x: 0, y: 0.28 },
    lastSwingSpeed: 0,
    yourServe: false,
    swings: 0,
  };

  onChange: (s: VirtualState) => void = () => undefined;

  constructor(
    private readonly url: string,
    readonly room: string,
    private readonly seat: Seat,
    private readonly token: string,
    private readonly name: string,
  ) {}

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: 'HELLO',
          role: 'controller',
          room: this.room,
          seat: this.seat,
          pairToken: this.token,
        }),
      );
      ws.send(JSON.stringify({ t: 'CALIBRATED', yawOffset: 0 }));
      ws.send(JSON.stringify({ t: 'READY', name: this.name }));
      this.state.connected = true;
      this.emit();

      this.poseTimer = setInterval(() => this.sendPose(), 1000 / TUNING.net.poseHz);
      this.pingTimer = setInterval(
        () => ws.send(JSON.stringify({ t: 'PING', c0: performance.now() })),
        TUNING.net.pingIntervalMs,
      );
      ws.send(JSON.stringify({ t: 'PING', c0: performance.now() }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          t: string;
          yourServe?: boolean;
          ready?: boolean[];
          you?: number;
        };
        if (msg.t === 'LITE') {
          this.state.yourServe = Boolean(msg.yourServe);
          // Ready up on this seat's behalf, every point. The ready-up exists to
          // re-anchor a phone's drifting gyro heading before the next serve;
          // a mouse has no heading to drift, so there is nothing here to hold
          // the gate up for — and a seat that never tapped would stop the match
          // for the player who is using a phone properly.
          const me = msg.you === 1 || msg.you === 3 ? 1 : 0;
          if (msg.ready && !msg.ready[me]) ws.send(JSON.stringify({ t: 'READY_POINT' }));
          this.emit();
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.state.connected = false;
      this.emit();
    };
    ws.onerror = () => {
      this.state.connected = false;
      this.emit();
    };
    this.tick();
  }

  /** Mouse or touch position over the canvas, in normalised coordinates. */
  setAim(nx: number, ny: number): void {
    this.aimX = clamp(nx, -1, 1);
    // Screen up should aim high, so invert.
    this.aimY = clamp(0.55 - ny * 0.85, -0.35, 0.95);
    this.state.aim = { x: this.aimX, y: this.aimY };
  }

  beginCharge(): void {
    if (this.chargeStart === null) this.chargeStart = performance.now();
  }

  /** Release: emit the swing. Returns the speed that was sent. */
  releaseCharge(): number {
    if (this.chargeStart === null) return 0;
    const held = Math.min(MAX_CHARGE_MS, performance.now() - this.chargeStart);
    this.chargeStart = null;
    const charge = held / MAX_CHARGE_MS;
    // A tap is a dink, a full hold is a drive. Same mapping as a real swing.
    const speed = 1.6 + charge * (TUNING.motion.speedCeiling - 1.6);
    this.swing(speed);
    this.state.charge = 0;
    this.state.lastSwingSpeed = speed;
    this.state.swings++;
    this.emit();
    return speed;
  }

  serve(): void {
    this.ws?.send(JSON.stringify({ t: 'BUTTON', button: 'serve' }));
  }

  private aimVector(): Vec3 {
    // Local player frame: +Z toward the net, +Y up, +X right.
    const horiz = Math.cos(this.aimY * 0.9);
    return vnorm([this.aimX * 0.85 * horiz, Math.sin(this.aimY * 0.9), horiz]);
  }

  private sendPose(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const q = qFromUnitZTo(this.aimVector());
    this.ws.send(
      JSON.stringify({ t: 'POSE', seq: this.seq++, ct: performance.now(), q: quantQuat(q) }),
    );
  }

  private swing(speed: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const aim = this.aimVector();
    const elev = Math.asin(clamp(aim[1], -1, 1));
    this.ws.send(
      JSON.stringify({
        t: 'SWING',
        seq: this.seq++,
        ctPeak: performance.now(),
        speed,
        dir: aim,
        q: qFromUnitZTo(aim),
        elev,
      }),
    );
  }

  private tick = (): void => {
    if (this.chargeStart !== null) {
      const held = Math.min(MAX_CHARGE_MS, performance.now() - this.chargeStart);
      const charge = held / MAX_CHARGE_MS;
      if (Math.abs(charge - this.state.charge) > 0.01) {
        this.state.charge = charge;
        this.emit();
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private emit(): void {
    this.onChange({ ...this.state, aim: { ...this.state.aim } });
  }

  disconnect(): void {
    cancelAnimationFrame(this.raf);
    if (this.poseTimer) clearInterval(this.poseTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.poseTimer = null;
    this.pingTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.state.connected = false;
  }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
