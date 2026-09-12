/**
 * Forward prediction. Runs the identical physics step as the authoritative loop,
 * on a clone, at the same dt — so a prediction and reality never disagree about
 * anything except the sub-tick interpolation used to sharpen `tIdeal`.
 *
 * Used for three things:
 *   - `tIdeal` and the contact point, published in `Snapshot.strike` so the
 *     display can telegraph the timing ring;
 *   - auto-positioning, which puts the player exactly where the contact will
 *     happen (players don't move themselves — that is the locked design);
 *   - the bot, which needs to know when to swing.
 *
 * Prediction runs ONCE per shot, at launch. It is never recomputed mid-flight,
 * because a `tIdeal` that drifts by even 20 ms makes timing feel random — and it
 * does not need to be, since the physics is deterministic.
 */

import type { BallSpec, CourtSpec, Millis, Seat, Vec3 } from '@rally/protocol';
import { TUNING, seatSign, vlerp } from '@rally/protocol';
import { cloneBody, stepBall, surfaceAt, type BallBody } from './physics.js';
import type { SimParams } from './params.js';

const PREDICT_MAX_S = 4.0;

export type ContactKind = 'volley' | 'groundstroke';

export interface ContactPrediction {
  /** Absolute server time of ideal contact. */
  tIdeal: Millis;
  /** Where the contact happens. The player is auto-positioned here. */
  p: Vec3;
  /** Ball velocity at contact. */
  v: Vec3;
  kind: ContactKind;
}

export interface PredictOptions {
  /** Bounces the ball has already taken on the receiver's side. */
  bouncesAlready?: number;
  /** Serves must bounce before they can be returned. */
  mustBounce?: boolean;
}

export interface LandingPrediction {
  t: Millis;
  p: Vec3;
  inBounds: boolean;
  /** True when the ball will hit the net before getting anywhere. */
  net: boolean;
}

/**
 * When and where the receiving player will meet the ball.
 *
 * Two candidate contacts are considered and the earliest wins:
 *   - a volley, as the ball crosses the receiver's body plane in the air at a
 *     sane height;
 *   - a groundstroke, as the ball descends back through contact height after
 *     bouncing on the receiver's side.
 *
 * A fast flat drive produces the first; a dink or a lob produces the second.
 * That is the whole reason players never have to choose.
 */
export function predictContact(
  body: BallBody,
  court: CourtSpec,
  ball: BallSpec,
  receiver: Seat,
  tNow: Millis,
  params: SimParams,
  opts: PredictOptions = {},
): ContactPrediction | null {
  const dt = params.dt;
  const side = seatSign(receiver);
  const bodyZ = Math.max(0.8, court.length / 2 - 0.6);
  const reachZ = court.length / 2 + params.reachDepth;
  const contactY = court.tableHeight + params.contactHeight;

  const sim = cloneBody(body);
  let t = tNow;
  let prev: Vec3 = [...sim.p] as Vec3;
  let bounces = opts.bouncesAlready ?? 0;
  const steps = Math.ceil(PREDICT_MAX_S / dt);

  for (let i = 0; i < steps; i++) {
    const hit = stepBall(sim, dt, court, ball);
    const tPrev = t;
    t += dt * 1000;

    if (hit.kind === 'net' || hit.kind === 'floor') return null;
    if (hit.kind === 'crossed') bounces = 0;
    if (hit.kind === 'bounce' && hit.side === side) {
      bounces++;
      // Two bounces means the receiver already failed to return it.
      if (bounces >= 2) return null;
      // Bounced out: there is nothing left worth hitting.
      if (!hit.inBounds) return null;
    }

    const z = sim.p[2];
    const y = sim.p[1];
    if (Math.sign(z) === side) {
      // Volley: crossing the body plane, in the air, at a reachable height.
      if (
        bounces === 0 &&
        !opts.mustBounce &&
        Math.abs(prev[2]) < bodyZ &&
        Math.abs(z) >= bodyZ &&
        y > surfaceAt(court, sim.p[0], z) + 0.22 &&
        y < 2.2
      ) {
        const f = frac(Math.abs(prev[2]), Math.abs(z), bodyZ);
        return contact(tPrev, t, prev, sim, f, 'volley');
      }

      // Groundstroke: the first moment after the bounce that the ball is both
      // descending and at a reachable height.
      //
      // Note the condition is NOT "descends through contact height" — a flat
      // shot can bounce so low that it never reaches contact height at all, and
      // requiring it gives the receiver no contact opportunity whatsoever. This
      // way a high bounce is met on the way down at a comfortable height, and a
      // low skidding one is met at the top of its bounce, which is what a player
      // would actually do.
      if (bounces >= 1 && sim.v[1] < 0 && y <= contactY) {
        const f = prev[1] > contactY ? frac(prev[1], y, contactY) : 1;
        return contact(tPrev, t, prev, sim, f, 'groundstroke');
      }

      // Past the point of no return.
      if (Math.abs(z) > reachZ) {
        if (bounces >= 1) {
          // A scrambling return right at the back fence. Still allow it.
          return contact(tPrev, t, prev, sim, 1, 'groundstroke');
        }
        return null;
      }
    }
    prev = [...sim.p] as Vec3;
  }
  return null;
}

/** Sub-tick crossing fraction, so `tIdeal` is not quantised to the tick rate. */
function frac(from: number, to: number, at: number): number {
  const d = from - to;
  if (Math.abs(d) < 1e-9) return 1;
  const f = (from - at) / d;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

function contact(
  tPrev: Millis,
  tNext: Millis,
  prev: Vec3,
  sim: BallBody,
  f: number,
  kind: ContactKind,
): ContactPrediction {
  return {
    tIdeal: tPrev + (tNext - tPrev) * f,
    p: vlerp(prev, sim.p, f),
    v: [...sim.v] as Vec3,
    kind,
  };
}

/** Where the ball will first land, and whether that is in or out. */
export function predictLanding(
  body: BallBody,
  court: CourtSpec,
  ball: BallSpec,
  tNow: Millis,
  dt = 1 / TUNING.net.tickHz,
): LandingPrediction | null {
  const sim = cloneBody(body);
  let t = tNow;
  const steps = Math.ceil(PREDICT_MAX_S / dt);
  for (let i = 0; i < steps; i++) {
    const hit = stepBall(sim, dt, court, ball);
    t += dt * 1000;
    if (hit.kind === 'net') return { t, p: hit.at, inBounds: false, net: true };
    if (hit.kind === 'floor') return { t, p: hit.at, inBounds: false, net: false };
    if (hit.kind === 'bounce') return { t, p: hit.at, inBounds: hit.inBounds, net: false };
  }
  return null;
}

/**
 * Integrate until the ball lands and report the landing point. The shot solver
 * uses this to compensate for drag: solve a drag-free parabola, see where it
 * actually lands, move the aim point, solve again.
 */
export function flightLanding(
  from: Vec3,
  v: Vec3,
  court: CourtSpec,
  ball: BallSpec,
  dt = 1 / TUNING.net.tickHz,
): Vec3 | null {
  const sim: BallBody = {
    p: [...from] as Vec3,
    v: [...v] as Vec3,
    spin: 0,
    b: 0,
    bounceSide: 0,
  };
  const steps = Math.ceil(PREDICT_MAX_S / dt);
  for (let i = 0; i < steps; i++) {
    const hit = stepBall(sim, dt, court, ball);
    if (hit.kind === 'bounce' || hit.kind === 'floor') return hit.at;
    if (hit.kind === 'net') return null;
  }
  return null;
}

export interface FlightProbe {
  /** Where the ball actually lands, with drag applied. */
  landing: Vec3 | null;
  /** Actual height as the ball crosses the net plane, or null if it never does. */
  netY: number | null;
}

/**
 * Measure what a launch velocity *really* does once drag is applied.
 *
 * The shot solver fits a drag-free parabola, and for a draggy ball that parabola
 * is a lie in two places that matter: the ball lands short, and it crosses the
 * net lower than asked. Probing both and correcting the two constraints
 * separately converges in two or three iterations, which is how `solveWithDrag`
 * can promise a net clearance and actually deliver it.
 */
export function flightProbe(
  from: Vec3,
  v: Vec3,
  court: CourtSpec,
  ball: BallSpec,
  dt = 1 / TUNING.net.tickHz,
): FlightProbe {
  const sim: BallBody = {
    p: [...from] as Vec3,
    v: [...v] as Vec3,
    spin: 0,
    b: 0,
    bounceSide: 0,
  };
  let netY: number | null = null;
  let prev: Vec3 = [...from] as Vec3;
  const steps = Math.ceil(PREDICT_MAX_S / dt);

  for (let i = 0; i < steps; i++) {
    const hit = stepBall(sim, dt, court, ball);

    if (netY === null && Math.sign(prev[2]) !== Math.sign(sim.p[2]) && prev[2] !== 0) {
      const f = (0 - prev[2]) / (sim.p[2] - prev[2]);
      netY = prev[1] + (sim.p[1] - prev[1]) * f;
    }
    if (hit.kind === 'net') {
      // It struck the tape. Report the height it got to, so the caller can lift.
      return { landing: null, netY: netY ?? hit.at[1] };
    }
    if (hit.kind === 'bounce' || hit.kind === 'floor') return { landing: hit.at, netY };
    prev = [...sim.p] as Vec3;
  }
  return { landing: null, netY };
}
