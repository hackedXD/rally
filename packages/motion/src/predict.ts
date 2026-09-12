/**
 * Latency compensation on the paddle pose: rotate it forward to where the hand
 * will be when the pose lands, rather than sending where the hand was.
 *
 * The pose the server acts on is always a little old. The sensor sampled, the
 * phone buffered it until the next flush, the wire carried it. Over that gap the
 * paddle has kept turning, so the paddle the rules see — and the one drawn on
 * both displays — is the paddle you were holding, not the one you are holding.
 * At 600 deg/s, a 70 ms trip is 42 degrees of paddle face. That is not a
 * subtlety; it is the difference between a flat drive and a chop.
 *
 * The fix is what VR runtimes call timewarp, and it is not a model that has to
 * be trained — it is rigid-body kinematics:
 *
 *   q' = q (x) exp(omega * dt / 2)
 *
 * Three things make it work rather than making it worse:
 *
 * **Constant omega, and no acceleration term.** Over 40-90 ms a wrist through a
 * stroke really is turning at a constant rate, so there is little left for a
 * second-order term to win — and the second derivative of a noisy signal is
 * noise. Angular acceleration overshoots hardest exactly when the paddle is
 * moving fastest, which is contact: the one moment the pose has to be right.
 *
 * **The rate is measured, not differenced.** `Fusion.omegaDeg` comes straight off
 * the gyro, so there is no differencing of a quantised 30 Hz pose stream to
 * amplify, and no one-sample lag in the velocity estimate.
 *
 * **The horizon is measured, not assumed.** A venue network is the one number
 * nobody can guess from a desk, and the clock sync the protocol already runs
 * hands it over for free. It is capped anyway — see `maxLeadMs`.
 *
 * What is deliberately NOT predicted: the swing sample, which is contact and was
 * measured exactly; and the calibration pose, because a guess about the future is
 * a bad thing to anchor a frame to. Both live on their own paths in `sensors.ts`,
 * which is what keeps this to the pose and only the pose.
 *
 * Pure: no clock, no `window`. A pose and a rotation rate go in, a pose comes
 * out, which is what lets it be tested against arithmetic instead of against a
 * phone in someone's hand.
 */

import { DEG, TUNING, qFromRotVec, qmul, qnorm, type Quat, type Vec3 } from '@rally/protocol';

/**
 * The pose `dtMs` from now, if the paddle keeps turning as it is turning.
 *
 * `omegaDeg` is the rotation rate in the PADDLE's own axes — the frame
 * `Fusion.omegaDeg` reports and the frame `Fusion.paddleQ` maps out of — so the
 * delta composes on the RIGHT. Composing on the left would rotate about the
 * player's axes instead, which is the same quaternion only when the paddle
 * happens to be square to them, i.e. in exactly the case where the correction
 * does not matter.
 *
 * Returns the input unchanged for a zero horizon or a still paddle, so the
 * mouse controller and a phone sitting on a table both cost nothing.
 */
export function predictQ(q: Quat, omegaDeg: Vec3, dtMs: number): Quat {
  if (!(dtMs > 0)) return q;
  const rate = Math.hypot(omegaDeg[0], omegaDeg[1], omegaDeg[2]);
  // A hand held still reports a degree or two a second of gyro noise. Leading on
  // that would add jitter to the one thing on screen that was steady.
  if (!(rate > TUNING.predict.minRateDps)) return q;
  const dt = dtMs / 1000;
  const rot: Vec3 = [omegaDeg[0] * DEG * dt, omegaDeg[1] * DEG * dt, omegaDeg[2] * DEG * dt];
  return qnorm(qmul(q, qFromRotVec(rot)));
}

/**
 * How far ahead to aim, in ms, for a sample of a given age on a measured link.
 *
 * `ageMs` is how long the sample has already been sitting on the phone: poses
 * are sampled at the sensor's rate and flushed at `net.poseHz`, so the newest
 * one has waited up to a flush interval before it goes anywhere. Measurable
 * exactly, and worth as much as half the wire trip at 30 Hz.
 *
 * `rttMs` is halved, because the pose has to be right when it ARRIVES, which is
 * one way, not two.
 *
 * Everything is clamped into [0, maxLeadMs]: a clock that ran backwards must not
 * predict backwards, and a network having a bad minute must be capped rather
 * than followed.
 */
export function leadTime(ageMs: number, rttMs: number): number {
  const p = TUNING.predict;
  const wire = Number.isFinite(rttMs) && rttMs > 0 ? rttMs / 2 : 0;
  const age = Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0;
  const lead = (age + wire + p.sensorLagMs) * p.leadScale;
  return Math.min(p.maxLeadMs, Math.max(0, lead));
}

/**
 * Both halves together: the pose to put on the wire, and the horizon it was led
 * by so the caller can report it.
 *
 * The horizon is a diagnostic worth surfacing rather than hiding. It is invisible
 * right up until it is the reason nothing works, which is the wrong moment to
 * start guessing at it.
 */
export interface LedPose {
  q: Quat;
  leadMs: number;
}

export function leadPose(q: Quat, omegaDeg: Vec3, ageMs: number, rttMs: number): LedPose {
  const leadMs = leadTime(ageMs, rttMs);
  return { q: predictQ(q, omegaDeg, leadMs), leadMs };
}
