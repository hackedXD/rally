/**
 * The contact model — decision #14, and the single most important algorithm in
 * the project.
 *
 *   The paddle you see is physical. The hit you get is generous.
 *
 * Step 1 predicts the ideal contact (see `predict.ts`). Step 2, here, scores the
 * swing on timing and aim. Step 3 turns that score into how much of the player's
 * intent survives versus how much the game quietly does for them. Step 4 — the
 * step everybody forgets — reconciles the visuals, and lives in `match.ts`
 * because it needs the authoritative contact point.
 */

import type { CourtSpec, Millis, Seat, SwingInput, Vec3 } from '@rally/protocol';
import { DEG, TUNING, clamp, clamp01, lerp, seatSign, remap01, vangle, vlen, vnorm } from '@rally/protocol';
import type { SimParams } from './params.js';
import type { ContactPrediction } from './predict.js';
import { faceNormal } from './shot.js';

export interface StrikeEval {
  hit: boolean;
  /** 0..1 combined swing quality. */
  quality: number;
  qTiming: number;
  qAim: number;
  /** How much of the player's intent survives. 0 = fully assisted. */
  blend: number;
  /** Signed timing error in ms. Negative = early. */
  dtTimingMs: number;
  aimErrDeg: number;
  /** Distance the paddle would have been from the ball, for whiff commentary. */
  missDistanceM: number;
  /** Effective strike window this swing was judged against, ms. */
  windowMs: number;
}

/**
 * The paddle normal that would send the ball somewhere sensible. Aim error is
 * measured against this, which gives the rule players actually intuit: point
 * the paddle at the other court.
 */
export function idealNormal(contact: Vec3, seat: Seat, court: CourtSpec): Vec3 {
  const toward = -seatSign(seat);
  const targetZ = toward * (court.length / 2) * TUNING.shot.safeDepth;
  const dx = -contact[0] * 0.35 - contact[0];
  const dz = targetZ - contact[2];
  const horiz = Math.hypot(dx, dz);
  return vnorm([dx, horiz * 0.22, dz]);
}

export function evaluateStrike(
  swing: SwingInput,
  tEval: Millis,
  prediction: ContactPrediction | null,
  seat: Seat,
  court: CourtSpec,
  params: SimParams,
  difficulty = 0,
): StrikeEval {
  const s = TUNING.strike;
  // Players auto-position, so the game cannot express "hard to reach". It
  // expresses the same thing as "hard to time": a ball with pace on it, or one
  // that dragged the receiver across the court, gets a tighter window and a
  // lower quality ceiling. Without this the rally never ends — returning is
  // otherwise automatic, and a 40-shot rally is not a demo.
  const d = clamp01(difficulty);
  const windowMs = params.windowMs * lerp(1, s.hardWindowScale, d);
  const qualityCap = lerp(1, s.hardQualityScale, d);

  if (!prediction) {
    return {
      hit: false,
      quality: 0,
      qTiming: 0,
      qAim: 0,
      blend: 0,
      dtTimingMs: Number.POSITIVE_INFINITY,
      aimErrDeg: 180,
      missDistanceM: 99,
      windowMs,
    };
  }

  const dtTiming = tEval - prediction.tIdeal;
  const qTiming = clamp01(1 - Math.abs(dtTiming) / windowMs);

  const normal = faceNormal(swing, seat);
  const ideal = idealNormal(prediction.p, seat, court);
  const aimErr = vangle(normal, ideal);
  const qAim = clamp01(1 - aimErr / (params.aimToleranceDeg * DEG));

  if (Math.abs(dtTiming) > windowMs) {
    // How far off they were, in metres of ball travel. Commentary material.
    const ballSpeed = Math.hypot(prediction.v[0], prediction.v[1], prediction.v[2]);
    return {
      hit: false,
      quality: 0,
      qTiming: 0,
      qAim,
      blend: 0,
      dtTimingMs: dtTiming,
      aimErrDeg: aimErr / DEG,
      missDistanceM: Math.min(9.9, (Math.abs(dtTiming) / 1000) * ballSpeed),
      windowMs,
    };
  }

  const quality = clamp01((s.timingWeight * qTiming + s.aimWeight * qAim) * qualityCap);

  // Step 3 — blend player intent with assistance. This is where leniency lives.
  const blend =
    quality < s.lowQualityCut
      ? s.assistLow
      : quality > s.highQualityCut
        ? s.assistHigh
        : lerp(
            s.assistLow,
            s.assistHigh,
            (quality - s.lowQualityCut) / Math.max(1e-6, s.highQualityCut - s.lowQualityCut),
          );

  return {
    hit: true,
    quality,
    qTiming,
    qAim,
    blend: clamp(blend, 0, 1),
    dtTimingMs: dtTiming,
    aimErrDeg: aimErr / DEG,
    missDistanceM: 0,
    windowMs,
  };
}

/**
 * How hard this ball is to return. Composed of the three things that actually
 * make a shot awkward, and published in the telegraph so every surface — the
 * ring on the court, the phone, the bot — reads the same number.
 */
export function strikeDifficulty(
  prediction: ContactPrediction,
  receiverWasAt: Vec3,
  court: CourtSpec,
  params: SimParams,
): number {
  const s = TUNING.strike;
  // Calibrated against the speed balls ARRIVE at, not the speed they are struck
  // at: a 19 m/s drive reaches the far baseline at about 7 after drag and a
  // bounce, so normalising against launch speed leaves difficulty pinned near
  // zero and the rally never ends.
  const pace = remap01(vlen(prediction.v), params.paceMin, params.paceMax);
  const travel = remap01(
    Math.hypot(prediction.p[0] - receiverWasAt[0], prediction.p[2] - receiverWasAt[2]),
    0.6,
    4.0,
  );
  const comfortable = court.tableHeight + params.contactHeight;
  const awkward = clamp01(Math.abs(prediction.p[1] - comfortable) / 0.9);
  return clamp01(
    s.diffPaceWeight * pace + s.diffTravelWeight * travel + s.diffHeightWeight * awkward,
  );
}
