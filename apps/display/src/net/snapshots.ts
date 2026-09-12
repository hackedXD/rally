/**
 * The snapshot buffer and the interpolator.
 *
 * Three different latencies coexist on screen, and getting this split right is
 * most of what makes remote play feel local:
 *
 *   your paddle        LOCALPOSE, applied immediately with a 3-sample filter
 *   ball / opponent    snapshot buffer, interpolated RENDER_DELAY behind server
 *   your hit reaction  predicted locally, corrected by the next snapshot
 *
 * This lives outside React's render cycle on purpose: it is written from a
 * WebSocket handler at 30 Hz and read from the r3f frame loop at 60+, and putting
 * either through `setState` would be a frame-time cost with no benefit.
 */

import {
  TUNING,
  lerp,
  qslerp,
  type BallState,
  type MatchPhase,
  type PlayerState,
  type Quat,
  type Reconcile,
  type ScoreState,
  type Seat,
  type Snapshot,
  type StrikeTelegraph,
  type Vec3,
} from '@rally/protocol';

export interface RenderState {
  t: number;
  phase: MatchPhase;
  phaseT: number;
  ball: BallState | null;
  /** True when the ball position is extrapolated rather than interpolated. */
  extrapolated: boolean;
  /** True when the buffer ran dry and the ball is frozen. */
  stalled: boolean;
  players: PlayerState[];
  score: ScoreState;
  strike: StrikeTelegraph | null;
  rally: number;
  tick: number;
  /**
   * Who has picked their bat up, by lane. Absent in a replay recorded before the
   * ready-up existed, where every bat was always in a hand.
   */
  ready: [boolean, boolean];
}

const GRAVITY = 9.81;

export class SnapshotBuffer {
  private buffer: Snapshot[] = [];
  /** Ball history for the winning-shot replay, newest last. */
  private history: { t: number; p: Vec3 }[] = [];
  private lastReconcile: Reconcile | null = null;
  private reconcileSeen = new Set<string>();

  /** Own-paddle pose, applied immediately with a small smoothing filter. */
  private localPose: Quat | null = null;
  private localSamples: Quat[] = [];
  ownSeat: Seat = 0;

  push(s: Snapshot): void {
    // Out-of-order or duplicate frames are dropped rather than reordered: the
    // cost of a sort at 30 Hz is not worth it, and one stale frame is invisible.
    const newest = this.buffer.at(-1);
    if (newest && s.tick <= newest.tick) return;
    this.buffer.push(s);
    while (this.buffer.length > 10) this.buffer.shift();

    if (s.ball) {
      this.history.push({ t: s.t, p: s.ball.p });
      const cutoff = s.t - TUNING.feel.replayLengthMs;
      while (this.history.length > 2 && this.history[0].t < cutoff) this.history.shift();
    }
    if (s.reconcile) {
      const key = `${s.reconcile.seat}:${s.reconcile.t}`;
      if (!this.reconcileSeen.has(key)) {
        this.reconcileSeen.add(key);
        this.lastReconcile = s.reconcile;
        if (this.reconcileSeen.size > 64) this.reconcileSeen.clear();
      }
    }
  }

  pushLocalPose(q: Quat): void {
    this.localSamples.push(q);
    if (this.localSamples.length > 3) this.localSamples.shift();
    // Three-sample slerp chain: enough to take the edge off sensor noise without
    // adding latency you can feel.
    let acc = this.localSamples[0];
    for (let i = 1; i < this.localSamples.length; i++) {
      acc = qslerp(acc, this.localSamples[i], 0.6);
    }
    this.localPose = acc;
  }

  /** Consume the pending reconcile instruction, if there is one. */
  takeReconcile(): Reconcile | null {
    const r = this.lastReconcile;
    this.lastReconcile = null;
    return r;
  }

  get ballHistory(): readonly { t: number; p: Vec3 }[] {
    return this.history;
  }

  get depth(): number {
    return this.buffer.length;
  }

  get latest(): Snapshot | null {
    return this.buffer.at(-1) ?? null;
  }

  clear(): void {
    this.buffer = [];
    this.history = [];
    this.localSamples = [];
    this.localPose = null;
    this.lastReconcile = null;
  }

  /**
   * Sample the world at `serverTime - RENDER_DELAY`.
   *
   * If the buffer underruns, extrapolate the ball ballistically for at most
   * 120 ms and then freeze. A frozen ball reads as lag, which is honest; a ball
   * that teleports reads as a bug.
   */
  sample(serverNow: number): RenderState | null {
    if (!this.buffer.length) return null;
    const target = serverNow - TUNING.net.renderDelayMs;

    let a = this.buffer[0];
    let b = this.buffer[this.buffer.length - 1];
    if (target <= a.t) b = a;
    else if (target >= b.t) a = b;
    else {
      for (let i = 0; i < this.buffer.length - 1; i++) {
        if (this.buffer[i].t <= target && target <= this.buffer[i + 1].t) {
          a = this.buffer[i];
          b = this.buffer[i + 1];
          break;
        }
      }
    }

    const span = b.t - a.t;
    const f = span > 1 ? clamp01((target - a.t) / span) : 0;
    const base = f < 0.5 ? a : b;

    let ball: BallState | null = null;
    let extrapolated = false;
    let stalled = false;

    if (a.ball && b.ball) {
      ball = {
        p: [
          lerp(a.ball.p[0], b.ball.p[0], f),
          lerp(a.ball.p[1], b.ball.p[1], f),
          lerp(a.ball.p[2], b.ball.p[2], f),
        ],
        v: [
          lerp(a.ball.v[0], b.ball.v[0], f),
          lerp(a.ball.v[1], b.ball.v[1], f),
          lerp(a.ball.v[2], b.ball.v[2], f),
        ],
        spin: 0,
        b: base.ball?.b ?? 0,
        owner: base.ball?.owner ?? null,
      };
    } else if (base.ball) {
      ball = { ...base.ball };
    }

    // Underrun: the newest snapshot is already behind the render time.
    const newest = this.buffer[this.buffer.length - 1];
    if (target > newest.t && newest.ball) {
      const ahead = target - newest.t;
      const dt = Math.min(ahead, TUNING.net.extrapolateMaxMs) / 1000;
      extrapolated = dt > 0.001;
      stalled = ahead > TUNING.net.extrapolateMaxMs;
      ball = {
        p: [
          newest.ball.p[0] + newest.ball.v[0] * dt,
          newest.ball.p[1] + newest.ball.v[1] * dt - 0.5 * GRAVITY * dt * dt,
          newest.ball.p[2] + newest.ball.v[2] * dt,
        ],
        v: [newest.ball.v[0], newest.ball.v[1] - GRAVITY * dt, newest.ball.v[2]],
        spin: 0,
        b: newest.ball.b,
        owner: newest.ball.owner,
      };
    }

    const players: PlayerState[] = base.players.map((p, i) => {
      const pa = a.players[i] ?? p;
      const pb = b.players[i] ?? p;
      const interpolated: PlayerState = {
        ...p,
        p: [
          lerp(pa.p[0], pb.p[0], f),
          lerp(pa.p[1], pb.p[1], f),
          lerp(pa.p[2], pb.p[2], f),
        ],
        paddleQ: qslerp(pa.paddleQ, pb.paddleQ, f),
      };
      // Your own paddle comes from LOCALPOSE, with zero added delay.
      if (p.seat === this.ownSeat && this.localPose && !p.bot) {
        interpolated.paddleQ = this.localPose;
      }
      return interpolated;
    });

    return {
      t: target,
      phase: base.phase,
      phaseT: base.phaseT,
      ball,
      extrapolated,
      stalled,
      players,
      score: base.score,
      strike: base.strike ?? null,
      rally: base.rally,
      tick: base.tick,
      ready: base.ready ?? [true, true],
    };
  }
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
