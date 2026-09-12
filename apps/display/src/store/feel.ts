/**
 * Game feel state.
 *
 * Deliberately outside React: every field here is written from a WebSocket
 * handler and read in the render loop, 60+ times a second. Routing a screen shake
 * through `setState` would re-render the whole tree to move the camera three
 * pixels.
 *
 * Priority order is §8.4.3's, which is worth following exactly — the top of the
 * list is where the perceived quality actually comes from.
 */

import { TUNING, type ShotType, type Vec3 } from '@rally/protocol';

export interface ReplayClip {
  /** Ball positions, oldest first. */
  points: { t: number; p: Vec3 }[];
  startedAt: number;
  durationMs: number;
  /** Where the camera swoops toward. */
  focus: Vec3;
}

class FeelState {
  /** Screen shake amplitude in pixels, decaying. */
  shake = 0;
  shakeUntil = 0;
  /** Hitstop: freeze the simulation clock briefly on a hard contact. */
  hitstopUntil = 0;
  /** Ball scale punch on contact. */
  flashUntil = 0;
  /** Last contact point, for the impact ring. */
  impact: { p: Vec3; at: number; strength: number } | null = null;
  /** Paddle reconciliation: drive the paddle through the real contact point. */
  reconcile: {
    seat: number;
    p: Vec3;
    at: number;
    kind: 'hit' | 'whiff';
  } | null = null;
  replay: ReplayClip | null = null;
  /** Trail positions, newest last. */
  trail: Vec3[] = [];

  hit(strength: number, at: Vec3, shot: ShotType): void {
    const s = Math.min(1, strength);
    this.shake = Math.max(this.shake, TUNING.feel.shakeMaxPx * s);
    this.shakeUntil = performance.now() + TUNING.feel.shakeDecayMs;
    this.flashUntil = performance.now() + TUNING.feel.flashMs;
    this.impact = { p: at, at: performance.now(), strength: s };
    // Hitstop only on hard shots: applying it to a dink makes the game feel
    // sluggish rather than weighty.
    if (shot === 'smash' || (shot === 'drive' && s > 0.7)) {
      this.hitstopUntil = performance.now() + TUNING.feel.hitstopMs;
    }
  }

  pushTrail(p: Vec3): void {
    const last = this.trail.at(-1);
    if (last && Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) + Math.abs(last[2] - p[2]) < 1e-4) {
      return;
    }
    this.trail.push(p);
    while (this.trail.length > TUNING.feel.trailLength) this.trail.shift();
  }

  clearTrail(): void {
    this.trail = [];
  }

  /** Shake offset in normalised screen units, already decayed. */
  shakeOffset(now: number): [number, number] {
    if (now > this.shakeUntil || this.shake <= 0) return [0, 0];
    const remaining = (this.shakeUntil - now) / TUNING.feel.shakeDecayMs;
    const amp = (this.shake * remaining * remaining) / 1000;
    return [
      Math.sin(now * 0.09) * amp + Math.sin(now * 0.21) * amp * 0.6,
      Math.cos(now * 0.11) * amp + Math.cos(now * 0.19) * amp * 0.6,
    ];
  }

  get inHitstop(): boolean {
    return performance.now() < this.hitstopUntil;
  }

  /**
   * The highest crowd reaction per line of code in the whole project: the ball
   * history already exists for lag compensation, so extending it to three seconds
   * and replaying the winning shot in slow motion is nearly free.
   */
  startReplay(points: readonly { t: number; p: Vec3 }[], focus: Vec3): void {
    if (points.length < 8) return;
    this.replay = {
      points: points.map((p) => ({ t: p.t, p: p.p })),
      startedAt: performance.now(),
      durationMs:
        ((points.at(-1)!.t - points[0].t) / TUNING.feel.replaySlowMo) || 1200,
      focus,
    };
  }

  /** Ball position during a replay, or null when the replay is over. */
  replayBall(now: number): { p: Vec3; progress: number } | null {
    const r = this.replay;
    if (!r) return null;
    const elapsed = now - r.startedAt;
    const progress = elapsed / r.durationMs;
    if (progress >= 1) {
      this.replay = null;
      return null;
    }
    const span = r.points.at(-1)!.t - r.points[0].t;
    const target = r.points[0].t + span * progress;
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      if (a.t <= target && target <= b.t) {
        const f = b.t - a.t > 0 ? (target - a.t) / (b.t - a.t) : 0;
        return {
          p: [
            a.p[0] + (b.p[0] - a.p[0]) * f,
            a.p[1] + (b.p[1] - a.p[1]) * f,
            a.p[2] + (b.p[2] - a.p[2]) * f,
          ],
          progress,
        };
      }
    }
    return { p: r.points.at(-1)!.p, progress };
  }

  cancelReplay(): void {
    this.replay = null;
  }

  reset(): void {
    this.shake = 0;
    this.hitstopUntil = 0;
    this.flashUntil = 0;
    this.impact = null;
    this.reconcile = null;
    this.replay = null;
    this.trail = [];
  }
}

export const feel = new FeelState();
