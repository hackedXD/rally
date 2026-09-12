/**
 * Calibration: 1.5 seconds of "hold the phone like a paddle, pointing at your
 * screen".
 *
 * Averaging over the window rather than snapping one sample matters — a single
 * frame captured while the player is still settling bakes a permanent few
 * degrees of error into every shot they take.
 */

import { TUNING, qnorm, qslerp, type Quat } from '@rally/protocol';
import type { Calibration, Fusion } from './fusion.js';

export interface CalibrationProgress {
  /** 0..1 */
  progress: number;
  done: boolean;
  /** Degrees of movement over the window. High means "hold still". */
  wobbleDeg: number;
}

export class Calibrator {
  private t0: number | null = null;
  private mean: Quat | null = null;
  private maxDev = 0;
  private samples = 0;

  start(t: number): void {
    this.t0 = t;
    this.mean = null;
    this.maxDev = 0;
    this.samples = 0;
  }

  get active(): boolean {
    return this.t0 !== null;
  }

  /** Feed the fused device quaternion. Returns progress. */
  feed(t: number, q: Quat): CalibrationProgress {
    if (this.t0 === null) return { progress: 0, done: false, wobbleDeg: 0 };
    this.samples++;

    if (!this.mean) {
      this.mean = qnorm(q);
    } else {
      // Running average on the sphere: slerp toward each new sample with a
      // decreasing weight. Cheap, stable, and good enough over 1.5 seconds.
      this.mean = qslerp(this.mean, q, 1 / Math.min(this.samples, 30));
      const dot = Math.abs(
        this.mean[0] * q[0] + this.mean[1] * q[1] + this.mean[2] * q[2] + this.mean[3] * q[3],
      );
      const devDeg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
      if (devDeg > this.maxDev) this.maxDev = devDeg;
    }

    const progress = Math.min(1, (t - this.t0) / TUNING.motion.calibrationMs);
    return { progress, done: progress >= 1, wobbleDeg: this.maxDev };
  }

  /** Finish, producing a calibration from the averaged pose. */
  finish(fusion: Fusion): Calibration {
    const cal = this.mean
      ? buildFrom(this.mean, fusion)
      : fusion.makeCalibration();
    this.t0 = null;
    fusion.setCalibration(cal);
    return cal;
  }

  cancel(): void {
    this.t0 = null;
  }
}

function buildFrom(meanQ: Quat, fusion: Fusion): Calibration {
  // Temporarily treat the averaged pose as current so the same derivation in
  // Fusion.makeCalibration is used, rather than duplicating the algebra.
  const saved = fusion.deviceQ;
  const asAny = fusion as unknown as { qDev: Quat };
  asAny.qDev = meanQ;
  const cal = fusion.makeCalibration();
  asAny.qDev = saved;
  return cal;
}
