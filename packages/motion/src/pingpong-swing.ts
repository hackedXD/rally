/**
 * Table tennis swing detection, transplanted from `pickle`.
 *
 * The state machine is the same shape as `./swing.ts` — arm, track the peak,
 * require the quiet at the end to HOLD, time out a swing that never ends,
 * refuse a twitch — because that one was taken from this one's ancestor in the
 * first place. Exactly one thing differs, and it is the reason this file exists:
 *
 *   `./swing.ts` onsets on LINEAR ACCELERATION.
 *   This one onsets on ROTATION RATE.
 *
 * A bat is swung by rotating the wrist, and rotation is already the signal table
 * tennis builds both its power and its face angle from. Onsetting on
 * acceleration instead means a wrist snap that barely moves the hand — a flick
 * serve, a net kill — never opens a swing at all, while the stroke it does open
 * peaks at a moment chosen by a different sensor than the one deciding what the
 * bat was doing.
 *
 * Pure and immutable, like everything else in this package: samples in, swings
 * out, so it can be run against a recording instead of against a phone in
 * someone's hand.
 */

export const PP_SWING = {
  ARM_DPS: 250, //      rotation rate that opens a swing
  RELEASE: 0.5, //      ...and the fraction of it that closes one
  /**
   * How long the quiet must hold before we believe it.
   *
   * Every millisecond here is a millisecond of delay between the stroke and the
   * ball leaving, and the ball can travel out of the strike window while we
   * wait. Two samples is enough to reject a single dropped one; more just costs
   * shots.
   */
  QUIET_MS: 24,
  MAX_MS: 700, //       past this it is shaking, not swinging
  COOLDOWN_MS: 200, //  one stroke is one event; this eats the follow-through
  /**
   * A twitch is not a swing — but this sits just above ARM_DPS on purpose. Set
   * well above it, it silently swallows real strokes, which reads as "I cannot
   * hit the ball" rather than as a rejected twitch.
   */
  MIN_PEAK_DPS: 300,
  MIN_HAND_MS: 0.5, //  ...unless the hand genuinely travelled
} as const;

export type PpSwingPhase = 'idle' | 'armed' | 'cooldown';

export interface PpSwingState<T> {
  phase: PpSwingPhase;
  peak: number;
  handPeak: number;
  armedAt: number;
  quietSince: number | null;
  firedAt: number;
  /** Whatever the caller captured at peak rate. */
  at: T | null;
}

export const newPpSwing = <T>(): PpSwingState<T> => ({
  phase: 'idle',
  peak: 0,
  handPeak: 0,
  armedAt: 0,
  quietSince: null,
  firedAt: 0,
  at: null,
});

export interface PpSwingSample<T> {
  t: number;
  /** Rotation rate magnitude, deg/s. */
  dps: number;
  /** Integrated hand speed this swing, m/s. 0 when unavailable. */
  handSpeed?: number;
  /** The caller's payload, captured at peak. */
  sample?: T | null;
}

/**
 * Feed one sensor sample. Returns `[state, fired | null]` where `fired` is the
 * sample captured at PEAK rotation — the instant of contact, not the end of the
 * follow-through, by which point the phone points somewhere meaningless.
 */
export function stepPpSwing<T>(
  s: PpSwingState<T>,
  { t, dps, handSpeed = 0, sample = null }: PpSwingSample<T>,
  k = PP_SWING,
): [PpSwingState<T>, T | null] {
  if (s.phase === 'cooldown') {
    return [t - s.firedAt > k.COOLDOWN_MS ? { ...s, phase: 'idle' } : s, null];
  }

  if (s.phase === 'idle') {
    if (dps <= k.ARM_DPS) return [s, null];
    return [
      { ...newPpSwing<T>(), phase: 'armed', armedAt: t, peak: dps, handPeak: handSpeed, at: sample },
      null,
    ];
  }

  // armed
  let next = s;
  if (dps > s.peak) next = { ...next, peak: dps, at: sample };
  if (handSpeed > next.handPeak) next = { ...next, handPeak: handSpeed };

  const quiet = dps < k.ARM_DPS * k.RELEASE;
  next = { ...next, quietSince: quiet ? (next.quietSince ?? t) : null };

  const settled = next.quietSince !== null && t - next.quietSince >= k.QUIET_MS;
  const ranLong = t - next.armedAt > k.MAX_MS;
  if (!settled && !ranLong) return [next, null];

  // A twitch, a shiver, or a phone put down on a table is not a stroke. Drop it
  // silently rather than launching a ball nobody swung at.
  const real = next.peak >= k.MIN_PEAK_DPS || next.handPeak >= k.MIN_HAND_MS;
  return [{ ...next, phase: 'cooldown', firedAt: t }, real ? next.at : null];
}

/**
 * What the phone's own motion is allowed to do, transplanted from `pickle`.
 *
 * Only the depth axis uses these. Orientation cannot say how far forward a hand
 * is — tilting your wrist says nothing about it — so depth is the one place this
 * project integrates acceleration, and these are what stop that from drifting
 * into nonsense. Treat the result as a spring-loaded control, never as where the
 * hand really is.
 */
export const PP_FUSION = {
  LEAK: 0.94, //         per-sample velocity leak; unbounded integration drifts
  STILL_ACC: 0.4, //     m/s² below which the hand counts as stationary
  STILL_DPS: 30, //      deg/s ditto
  ZUPT: 0.45, //         velocity retained per sample while stationary
  SPRING: 0.004, //      per-sample pull back to neutral while moving
  /**
   * ...and much harder once the hand parks. This is the drift fix: error cannot
   * accumulate across a rally because every pause between shots resets it.
   */
  SPRING_STILL: 0.06,
} as const;

/** Metres of forward travel at full stretch. Mirrors the sim's REACH_Z. */
export const PP_REACH_Z = 0.4;

/**
 * One step of the forward lean.
 *
 * Deliberately the one thing this project otherwise refuses to do — integrate
 * acceleration — and it is only survivable because the spring makes drift die
 * instead of accumulate.
 *
 * `aForward` is acceleration along the direction the player faces, m/s².
 */
export function stepReach(
  state: { reach: number; vel: number },
  aForward: number,
  accelMag: number,
  dps: number,
  dt: number,
  k = PP_FUSION,
): { reach: number; vel: number } {
  const still = dps < k.STILL_DPS && accelMag < k.STILL_ACC;
  let vel = (state.vel + aForward * dt) * (still ? k.ZUPT : k.LEAK);
  let reach = state.reach + vel * dt;
  reach -= reach * (still ? k.SPRING_STILL : k.SPRING);
  reach = Math.max(-PP_REACH_Z, Math.min(PP_REACH_Z, reach));
  if (!Number.isFinite(reach) || !Number.isFinite(vel)) {
    reach = 0;
    vel = 0;
  }
  return { reach, vel };
}
