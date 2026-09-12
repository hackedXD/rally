/**
 * Keeping the table where the player left it.
 *
 * Pitch and roll are referenced to gravity and cannot drift. Yaw has nothing to
 * hold it: iOS's `alpha` wanders degrees per minute, and the court's heading is
 * stored in that same frame — so the bat slowly turns away from where the phone
 * really points until it renders edge-on while the player is holding it square.
 *
 * Three mechanisms, in the order they can be trusted, all ported from the pickle
 * project where they were arrived at the hard way:
 *
 *   `trackDrift`  the magnetometer. Absolute, so it cannot drift, and noisy
 *                 enough to be unusable alone. Complementary filter.
 *   `anchorYaw`   a bat held still and upright is pointing at the court, because
 *                 that is what waiting for a serve IS.
 *   `learnYaw`    each stroke nudges the estimate, if it already roughly agrees.
 *
 * A READY tap still beats all three — being told is never wrong — but a rally
 * lasts longer than a tap, and this is what holds the heading in between.
 */

/*
 * `headingOf` is not redefined here: `fusion.ts` already has it, taking a
 * quaternion and reading the facing direction off local +Z. That is this
 * project's frame; pickle's took a vector and used -Z because its frame puts +Z
 * behind the player. Same angle, stated in the convention each project uses.
 */

/** Shortest signed difference a − b, wrapped to [-PI, PI]. */
export const angleDelta = (a: number, b: number): number => {
  const d = (a - b) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d;
};

export interface YawState {
  yaw: number;
  confirmed: boolean;
  rejects: number;
}

export const noYaw = (): YawState => ({ yaw: 0, confirmed: false, rejects: 0 });

export const YAW = {
  BLEND: 0.06, //          gentle: this only has to track slow gyro drift
  ACCEPT: Math.PI / 4, //  a stroke further off than this is not "forward"
  RESNAP_AFTER: 3, //      ...unless everything disagrees, and we are the wrong one
} as const;

/**
 * Fold one stroke's heading into the estimate of where the court is.
 *
 * Strokes do not all point at the court. A backhand across the body, a wide
 * forehand, a stretch recovery — any of them can leave the hand travelling 90
 * degrees or more off the direction of play. Treating one of those as "the
 * player has turned round" is what puts the mirror back mid-rally, so:
 *
 *   - the FIRST stroke sets the heading outright, because before it there is
 *     nothing better than a guess
 *   - after that it is only nudged, and only by strokes that already roughly
 *     agree. Everything else is a backhand, not evidence
 *   - unless several in a row disagree, which means the heading is the thing
 *     that is wrong. Without this a single wild first stroke would reject every
 *     good stroke after it, forever
 */
export const learnYaw = (state: YawState, seen: number): YawState => {
  if (!state.confirmed) return { yaw: seen, confirmed: true, rejects: 0 };
  const d = angleDelta(seen, state.yaw);
  if (Math.abs(d) > YAW.ACCEPT) {
    const rejects = state.rejects + 1;
    return rejects >= YAW.RESNAP_AFTER
      ? { yaw: seen, confirmed: true, rejects: 0 }
      : { ...state, rejects };
  }
  return { yaw: state.yaw + d * YAW.BLEND, confirmed: true, rejects: 0 };
};

// ── Absolute yaw, from the magnetometer ──────────────────────────────────────
//
// `alpha` is dead reckoning: smooth, and drifting. The compass is the opposite —
// absolute, and far too noisy to drive a paddle. So take the long-term truth
// from one and the smoothness from the other.
//
// Only their DIFFERENCE is tracked, heavily damped. Alpha wandering shows up as
// that difference moving, and adding it back cancels the wander while leaving
// alpha's frame-to-frame smoothness completely alone.

/** Per sample. The compass is noisy, so it is trusted slowly. */
export const DRIFT_PULL = 0.012;
/** Degrees of reported accuracy past which the compass is not worth having. */
export const COMPASS_MAX_ERR = 25;

/** A compass heading (degrees clockwise from north) as an earth-frame angle. */
export const compassYaw = (headingDeg: number): number =>
  Math.PI / 2 - (headingDeg * Math.PI) / 180;

export interface DriftState {
  d: number;
  have: boolean;
}

export const newDrift = (): DriftState => ({ d: 0, have: false });

/**
 * Fold in one sample of "how far has alpha wandered".
 *
 * Returns the state unchanged when there is no usable compass, which is what
 * makes this safe to add at all: on a device without one, or indoors beside a
 * magnet where the reported accuracy is junk, nothing happens and the still-bat
 * anchor carries on alone.
 */
export const trackDrift = (
  state: DriftState,
  alphaYaw: number,
  headingDeg: unknown,
  accuracyDeg: unknown,
): DriftState => {
  if (typeof headingDeg !== 'number' || !Number.isFinite(headingDeg)) return state;
  if (typeof accuracyDeg === 'number' && (accuracyDeg < 0 || accuracyDeg > COMPASS_MAX_ERR)) {
    return state;
  }
  const seen = angleDelta(alphaYaw, compassYaw(headingDeg));
  if (!state.have) return { d: seen, have: true };
  return { d: state.d + angleDelta(seen, state.d) * DRIFT_PULL, have: true };
};

/**
 * The drift fix that does not need a compass.
 *
 * Learning from strokes alone cannot do it: the correction is 6% per stroke, and
 * once the error passes `YAW.ACCEPT` every stroke is rejected as a backhand — so
 * the drift runs away exactly when it matters most.
 *
 * A bat held still and upright is pointing at the court, so that reading
 * re-anchors the heading. A slow pull, so a deliberate aim off to one side is
 * not stolen; and a hard snap once a big disagreement has persisted, because
 * after several seconds of a still bat disagreeing by forty degrees, it is the
 * heading that is wrong and not the player.
 */
export const YAW_ANCHOR = {
  PULL: 0.02, //          per still sample; about a second to take up a small error
  SNAP_OVER: 0.6, //      radians of disagreement that stops being plausible aim
  SNAP_AFTER_MS: 2200, // ...once it has been held that long
} as const;

export const anchorYaw = (state: YawState, seen: number, stillMs: number): YawState => {
  if (!state.confirmed) return { yaw: seen, confirmed: true, rejects: 0 };
  const d = angleDelta(seen, state.yaw);
  if (Math.abs(d) > YAW_ANCHOR.SNAP_OVER && stillMs >= YAW_ANCHOR.SNAP_AFTER_MS) {
    return { ...state, yaw: seen };
  }
  return { ...state, yaw: state.yaw + d * YAW_ANCHOR.PULL };
};
