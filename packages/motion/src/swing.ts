/**
 * Swing detection.
 *
 * Do NOT integrate acceleration continuously — the drift is unusable within a
 * second or two. Integrate only inside the swing burst, which bounds the error to
 * a few hundred milliseconds and is the difference between a paddle that works
 * and one that slowly wanders off into the stands.
 *
 *   IDLE       |a| > SWING_ONSET_ACCEL            -> start integrating
 *   SWINGING   track peak speed, direction, orientation
 *              |a| < SWING_END_ACCEL held, or timeout -> emit
 *   REFRACTORY a fixed dead time, so one swing is one event
 */

import { TUNING, vlen, vnorm, type Quat, type SwingInput, type Vec3 } from '@rally/protocol';

export type SwingPhase = 'idle' | 'swinging' | 'refractory';

export interface SwingDetectorState {
  phase: SwingPhase;
  /** Current integrated speed, m/s. Drives the wind-up meter on the phone. */
  speed: number;
  peakSpeed: number;
}

export class SwingDetector {
  private phase: SwingPhase = 'idle';
  private v: Vec3 = [0, 0, 0];
  private tOnset = 0;
  private tQuiet: number | null = null;
  private tRefractoryEnd = 0;
  private lastT: number | null = null;

  private vPeak = 0;
  private dirPeak: Vec3 = [0, 0, 1];
  private qPeak: Quat = [0, 0, 0, 1];
  private tPeak = 0;

  get state(): SwingDetectorState {
    return { phase: this.phase, speed: vlen(this.v), peakSpeed: this.vPeak };
  }

  reset(): void {
    this.phase = 'idle';
    this.v = [0, 0, 0];
    this.vPeak = 0;
    this.tQuiet = null;
    this.lastT = null;
  }

  /**
   * Feed one sample. `a` is linear acceleration in the yaw-corrected player
   * frame; `q` is the paddle orientation at this sample; `t` is
   * `performance.now()`.
   *
   * Returns a swing when one completes, otherwise null.
   */
  feed(t: number, a: Vec3, q: Quat): SwingInput | null {
    const m = TUNING.motion;
    const dt = this.lastT === null ? 0 : Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;
    const mag = vlen(a);

    switch (this.phase) {
      case 'refractory':
        if (t >= this.tRefractoryEnd) this.phase = 'idle';
        return null;

      case 'idle':
        if (mag > m.swingOnsetAccel) {
          this.phase = 'swinging';
          this.v = [0, 0, 0];
          this.vPeak = 0;
          this.tOnset = t;
          this.tQuiet = null;
          this.dirPeak = vnorm(a);
          this.qPeak = q;
          this.tPeak = t;
        }
        return null;

      case 'swinging': {
        if (dt > 0) {
          this.v = [a[0] * dt + this.v[0], a[1] * dt + this.v[1], a[2] * dt + this.v[2]];
        }
        const speed = vlen(this.v);
        if (speed > this.vPeak) {
          this.vPeak = speed;
          this.dirPeak = vnorm(this.v);
          this.qPeak = q;
          this.tPeak = t;
        }

        if (mag < m.swingEndAccel) {
          if (this.tQuiet === null) this.tQuiet = t;
        } else {
          this.tQuiet = null;
        }

        const quietLongEnough =
          this.tQuiet !== null && t - this.tQuiet >= m.swingEndHoldMs;
        const tooLong = t - this.tOnset > m.swingMaxMs;
        if (!quietLongEnough && !tooLong) return null;

        this.phase = 'refractory';
        this.tRefractoryEnd = t + m.refractoryMs;

        // A twitch is not a swing. Emitting one produces phantom shots while a
        // player is just holding the phone and talking.
        if (this.vPeak < m.minSwingSpeed) {
          this.v = [0, 0, 0];
          return null;
        }

        const dir = vnorm(this.dirPeak);
        return {
          speed: Math.min(this.vPeak, m.speedCeiling * 1.6),
          dir,
          q: this.qPeak,
          elev: Math.asin(Math.max(-1, Math.min(1, dir[1]))),
          // performance.now() at the peak sample, NOT event.timeStamp: that
          // field's epoch is inconsistent across browsers.
          ctPeak: this.tPeak,
        };
      }
    }
  }
}
