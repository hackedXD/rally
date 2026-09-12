/**
 * Sensor fusion: one quaternion, fused from the two things iOS Safari actually
 * gives you.
 *
 *   deviceorientation      gravity-referenced so it cannot drift, but noisy and
 *                          low-rate, and `alpha` is relative to page load rather
 *                          than true north
 *   devicemotion.rotationRate   smooth and fast, but integrating it drifts
 *
 * The gyro carries the fast motion; the orientation reading slowly pulls out
 * accumulated drift. That is the whole algorithm, and `fuseAlpha` is the only
 * knob: raise it if the paddle drifts during a rally, lower it if the paddle
 * feels sluggish or jittery.
 *
 * Pure: no `window`, no event listeners, no clock. Samples come in, quaternions
 * come out, which is what makes it testable against recorded swings instead of
 * against a phone in someone's hand.
 */

import {
  DEG,
  QUAT_IDENTITY,
  TUNING,
  qFromAxisAngle,
  qFromEulerYXZ,
  qconj,
  qmul,
  qnorm,
  qrot,
  qslerp,
  type Quat,
  type Vec3,
} from '@rally/protocol';

export const GRAVITY = 9.81;

/** Raw `deviceorientation`, degrees, exactly as the event reports it. */
export interface OrientationSample {
  alpha: number;
  beta: number;
  gamma: number;
  /** `screen.orientation.angle`, degrees. */
  screen: number;
}

/** Raw `devicemotion`, with `rotationRate` in deg/s and accel in m/s². */
export interface MotionSample {
  rotationRate?: { alpha: number; beta: number; gamma: number } | null;
  accelerationIncludingGravity?: { x: number; y: number; z: number } | null;
}

export interface Calibration {
  /**
   * Yaw correction. `alpha` is arbitrary on iOS, so the heading the player was
   * pointing at calibration time becomes "forward".
   */
  pre: Quat;
  /**
   * Device axes to paddle axes. Recorded at calibration so the same code works
   * whether someone holds the phone flat or edge-on.
   */
  post: Quat;
}

export const IDENTITY_CALIBRATION: Calibration = {
  pre: QUAT_IDENTITY,
  post: QUAT_IDENTITY,
};

// Constants for the W3C intrinsic Z-X'-Y'' recipe. Using the standard Three.js
// DeviceOrientationControls derivation rather than deriving it: it is easy to
// get subtly wrong and impossible to debug on a phone at 3am.
const ZEE: Vec3 = [0, 0, 1];
const Q1: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // -90 degrees about X

export function quatFromDeviceOrientation(s: OrientationSample): Quat {
  // The event reports degrees; the Euler conversion wants radians.
  let q = qFromEulerYXZ(s.beta * DEG, s.alpha * DEG, -s.gamma * DEG);
  q = qmul(q, Q1); // device frame -> looking out the back of the phone
  q = qmul(q, qFromAxisAngle(ZEE, -s.screen * DEG));
  return qnorm(q);
}

/** Paddle heading: rotation about world +Y of the paddle's face normal. */
export function headingOf(q: Quat): number {
  const n = qrot(q, [0, 0, 1]);
  return Math.atan2(n[0], n[2]);
}

export class Fusion {
  /** Fused device -> world rotation. World yaw is arbitrary until calibration. */
  private qDev: Quat = QUAT_IDENTITY;
  private haveOrientation = false;
  private lastT: number | null = null;
  private cal: Calibration = IDENTITY_CALIBRATION;

  /** Linear acceleration, yaw-corrected player frame, m/s². */
  private aPlayer: Vec3 = [0, 0, 0];

  get deviceQ(): Quat {
    return this.qDev;
  }

  /**
   * Paddle orientation in the canonical player frame: +Z is the direction the
   * player faces (toward the net), +Y is up, +X is their right. The server maps
   * this onto the seat's half of the court, so neither side of the net needs to
   * know which end it is playing from.
   */
  get paddleQ(): Quat {
    return qnorm(qmul(this.cal.pre, qmul(this.qDev, this.cal.post)));
  }

  get linearAccel(): Vec3 {
    return this.aPlayer;
  }

  get calibration(): Calibration {
    return this.cal;
  }

  get ready(): boolean {
    return this.haveOrientation;
  }

  setCalibration(cal: Calibration): void {
    this.cal = cal;
  }

  reset(): void {
    this.qDev = QUAT_IDENTITY;
    this.haveOrientation = false;
    this.lastT = null;
    this.aPlayer = [0, 0, 0];
  }

  /** Orientation branch. Gravity-referenced, so it is the drift anchor. */
  pushOrientation(s: OrientationSample): void {
    const qOrient = quatFromDeviceOrientation(s);
    if (!this.haveOrientation) {
      this.qDev = qOrient;
      this.haveOrientation = true;
      return;
    }
    // The gyro branch has already advanced qDev; nudge it toward the absolute
    // reading by a small amount. This is the complementary filter.
    this.qDev = qslerp(this.qDev, qOrient, TUNING.motion.fuseAlpha);
  }

  /**
   * Gyro branch plus the accelerometer. `t` is `performance.now()`; event
   * timestamps are not used because their epoch is inconsistent across browsers.
   */
  pushMotion(s: MotionSample, t: number): void {
    const dt = this.lastT === null ? 0 : Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;

    const rr = s.rotationRate;
    if (rr && dt > 0) {
      // rotationRate maps to device axes as omega = [beta, gamma, alpha].
      const wx = (rr.beta ?? 0) * DEG;
      const wy = (rr.gamma ?? 0) * DEG;
      const wz = (rr.alpha ?? 0) * DEG;
      const mag = Math.hypot(wx, wy, wz);
      if (mag > TUNING.motion.gyroDeadzone) {
        // q_gyro <- normalize(q + 0.5 * q (x) (0, wx, wy, wz) * dt)
        const dq = qmul(this.qDev, [wx, wy, wz, 0]);
        const k = 0.5 * dt;
        this.qDev = qnorm([
          this.qDev[0] + dq[0] * k,
          this.qDev[1] + dq[1] * k,
          this.qDev[2] + dq[2] * k,
          this.qDev[3] + dq[3] * k,
        ]);
      }
    }

    const acc = s.accelerationIncludingGravity;
    if (acc) {
      const sign = TUNING.motion.accelSign;
      const device: Vec3 = [acc.x * sign, acc.y * sign, acc.z * sign];
      // Device -> world, then remove gravity, then yaw-correct into player frame.
      const world = qrot(this.qDev, device);
      const linear: Vec3 = [world[0], world[1] - GRAVITY, world[2]];
      this.aPlayer = qrot(this.cal.pre, linear);
    }
  }

  /**
   * Build a calibration from the current pose. The player is holding the phone
   * like a paddle, pointing at their screen.
   */
  makeCalibration(): Calibration {
    const qCal = this.qDev;
    // Reference pose is the identity: face normal along +Z, head along +Y. Solve
    // identity = pre (x) qCal (x) post with pre a pure yaw correction.
    const headingRaw = headingOf(qCal);
    const pre = qFromAxisAngle([0, 1, 0], -headingRaw);
    const post = qnorm(qmul(qconj(qCal), qconj(pre)));
    return { pre, post };
  }

  /**
   * Re-zero yaw only, preserving how the player is holding the phone.
   *
   * Called at every serve. It costs nothing and eliminates the single most common
   * "it stopped aiming correctly" complaint, because gyro yaw drifts and `alpha`
   * has no absolute reference to pull it back.
   */
  rezeroYaw(): Calibration {
    const current = qnorm(qmul(this.qDev, this.cal.post));
    const pre = qFromAxisAngle([0, 1, 0], -headingOf(current));
    this.cal = { pre, post: this.cal.post };
    return this.cal;
  }

  /** Yaw offset currently applied, radians. Reported to the server for logging. */
  get yawOffset(): number {
    return 2 * Math.atan2(this.cal.pre[1], this.cal.pre[3]);
  }
}
