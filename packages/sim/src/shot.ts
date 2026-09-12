/**
 * The shot model: turn a swing into a ball velocity.
 *
 * The trick that makes every shot type land where it reads is to stop thinking
 * in velocities and think in *constraints*. A shot is fully determined by three
 * things we can choose deliberately:
 *
 *   1. where it should land        (shot type sets the depth, aim sets the line)
 *   2. how high it crosses the net (power: a hard drive skims, a soft ball loops)
 *   3. gravity                     (not negotiable)
 *
 * Fit a parabola through those and the launch velocity falls out — along with a
 * speed that is automatically sensible, because it is the speed the geometry
 * demands. Solving it this way is why a dink is never accidentally a rocket and
 * a smash is never accidentally a lob.
 */

import type { BallSpec, CourtSpec, ShotType, SwingInput, Vec3 } from '@rally/protocol';
import {
  DEG,
  TUNING,
  clamp,
  clamp01,
  lerp,
  remap01,
  seatSign,
  vlen,
  vnorm,
  vnormOr,
  type Seat,
} from '@rally/protocol';
import type { SimParams } from './params.js';
import { GRAVITY, surfaceAt } from './physics.js';
import { flightProbe } from './predict.js';
import type { Rng } from './rng.js';

export interface Shot {
  v: Vec3;
  type: ShotType;
  /** 0..1 — how hard the player actually swung. */
  power: number;
  /** Where the shot is aimed. Kept for event data and for the bot. */
  target: Vec3;
  /** Minimum height the solver demanded at the net plane, absolute world y. */
  netY: number;
  speed: number;
  /** Flight time the solver settled on, seconds. */
  flightT: number;
  /** True when placement was sacrificed to keep the ball in play. */
  rescued: boolean;
  /**
   * False when the solver could not find a trajectory that clears the net and
   * still lands on target. The ball is launched anyway — clipping the tape is a
   * legitimate outcome for a reckless swing — but the flag makes "why did that
   * hit the net" answerable instead of mysterious.
   */
  clearsNet: boolean;
}

export interface ShotContext {
  seat: Seat;
  court: CourtSpec;
  ball: BallSpec;
  /** Resolved per-match constants. Never read sport values from global TUNING. */
  params: SimParams;
  /** Contact point. */
  from: Vec3;
  /** Ball velocity arriving at contact. */
  incoming: Vec3;
  isServe: boolean;
  rng: Rng;
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Three to five shot types is plenty. Each one needs a distinct sound and a
 * distinct trajectory silhouette, or players won't perceive the difference.
 */
export function classifyShot(swing: SwingInput, ctx: ShotContext): ShotType {
  if (ctx.isServe) return 'serve';
  const s = TUNING.shot;
  const elevDeg = swing.elev / DEG;
  const netTop = surfaceAt(ctx.court, ctx.from[0], 0) + ctx.court.netHeight;
  const ballIsHigh = ctx.from[1] > netTop + 0.45;

  if (swing.speed >= s.smashMinSpeed && elevDeg <= s.smashMaxElevDeg && ballIsHigh) {
    return 'smash';
  }
  if (elevDeg >= s.lobMinElevDeg) return 'lob';
  if (swing.speed <= s.dinkMaxSpeed) return 'dink';
  if (swing.speed >= s.driveMinSpeed && elevDeg <= s.driveMaxElevDeg) return 'drive';
  return 'rally';
}

/** Fraction of the opponent's half each shot type aims into. */
function depthFor(type: ShotType, power: number): number {
  switch (type) {
    case 'serve':
      return TUNING.serve.targetDepth;
    case 'drive':
      return lerp(0.6, 0.82, power);
    case 'dink':
      return lerp(0.18, 0.34, power);
    case 'lob':
      return lerp(0.82, 0.96, power);
    case 'smash':
      return lerp(0.32, 0.62, power);
    default:
      return lerp(0.52, 0.76, power);
  }
}

// ── Aim ───────────────────────────────────────────────────────────────────────

/**
 * The direction the player actually pointed the paddle.
 *
 * The face normal does most of the work, the way a real paddle does; the swing
 * path contributes the rest. The z component is forced toward the opponent: a
 * paddle has two faces and nobody means to hit it backwards.
 */
export function playerAimDir(swing: SwingInput, seat: Seat): Vec3 {
  const toward = -seatSign(seat); // seat 0 (negative z) hits toward +z
  const n = faceNormal(swing, seat);
  const d = vnormOr(swing.dir, n);
  const mixed: Vec3 = [n[0] * 0.65 + d[0] * 0.35, n[1] * 0.65 + d[1] * 0.35, n[2] * 0.65 + d[2] * 0.35];
  const out = vnormOr(mixed, [0, 0, toward]);
  // Never let the aim point back over your own baseline.
  if (Math.sign(out[2]) !== toward || Math.abs(out[2]) < 0.15) {
    return vnorm([out[0], out[1], toward * 0.45]);
  }
  return out;
}

/** Paddle face normal in world space, flipped to face the opponent. */
export function faceNormal(swing: SwingInput, seat: Seat): Vec3 {
  const toward = -seatSign(seat);
  const q = swing.q;
  // Local +Z is the face normal (paddle frame: +Y grip → head, +Z face).
  const [x, y, z, w] = q;
  const n: Vec3 = [
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  ];
  return Math.sign(n[2]) === toward ? n : [-n[0], -n[1], -n[2]];
}

/**
 * Project the aim direction onto the opponent's court at a given depth.
 * Shot type chooses the depth; the paddle chooses the line.
 */
function aimTarget(aim: Vec3, ctx: ShotContext, depthFrac: number): Vec3 {
  const toward = -seatSign(ctx.seat);
  const half = ctx.court.length / 2;
  const targetZ = toward * half * clamp01(depthFrac);
  const dz = targetZ - ctx.from[2];
  const horiz = Math.hypot(aim[0], aim[2]);
  // Lateral travel per metre of depth, from the aim line.
  const slope = horiz < 1e-4 ? 0 : aim[0] / Math.max(Math.abs(aim[2]), 0.18);
  const targetX = ctx.from[0] + slope * Math.abs(dz);
  const y = surfaceAt(ctx.court, targetX, targetZ) + ctx.ball.radius;
  return [targetX, y, targetZ];
}

/** Where the assistance wants the ball to go: deep, central, always legal. */
function safeTarget(ctx: ShotContext, depthFrac: number): Vec3 {
  const toward = -seatSign(ctx.seat);
  const half = ctx.court.length / 2;
  const z = toward * half * clamp01(depthFrac);
  const x = clamp(
    -ctx.from[0] * 0.35 + ctx.rng.spread(TUNING.shot.safeSpread),
    -ctx.court.width / 2 + 0.45,
    ctx.court.width / 2 - 0.45,
  );
  return [x, surfaceAt(ctx.court, x, z) + ctx.ball.radius, z];
}

// ── The solver ────────────────────────────────────────────────────────────────

/**
 * Flight time, seconds. This is the real game-feel knob: it sets how long the
 * receiver has to read the ball, and therefore whether a rally is sustainable at
 * all. Everything else about a trajectory is downstream of it.
 */
function flightTimeFor(type: ShotType, power: number, scale: number): number {
  let t: number;
  switch (type) {
    case 'serve':
      // Serves arc a touch more than a rally ball so the bounce sits up into a
      // comfortable return height rather than skidding away from the receiver.
      t = lerp(1.45, 1.15, power);
      break;
    case 'drive':
      t = lerp(1.0, 0.8, power);
      break;
    case 'dink':
      t = lerp(1.1, 0.95, power);
      break;
    case 'lob':
      t = lerp(1.7, 2.1, power);
      break;
    case 'smash':
      t = lerp(0.68, 0.5, power);
      break;
    default:
      t = lerp(1.3, 1.0, power);
  }
  return t * scale;
}

/**
 * The closed form: launch velocity that carries the ball `S` metres horizontally
 * and `dy` metres vertically in exactly `T` seconds, ignoring drag.
 *
 *   vh = S / T
 *   vy = (dy + g T^2 / 2) / T
 */
export function solveByTime(
  dirH: Vec3,
  S: number,
  dy: number,
  T: number,
  gravityScale: number,
): Vec3 {
  const g = GRAVITY * gravityScale;
  const vh = S / T;
  const vy = (dy + 0.5 * g * T * T) / T;
  return [dirH[0] * vh, vy, dirH[2] * vh];
}

export interface TimedSolve {
  v: Vec3;
  /** Flight time actually used, after the search. */
  T: number;
  /** True when the shot is on course to clear the net. */
  clears: boolean;
  /**
   * True when accuracy had to be sacrificed to keep the ball in play. Useful
   * signal when tuning: a geometry that rescues often is one the shot model is
   * being asked for something close to impossible.
   */
  rescued: boolean;
}

/**
 * Solve for a shot that lands on `target` and clears the net by at least
 * `minClearance` metres — a SIGNED margin, so a negative value deliberately asks
 * for a ball that catches the tape.
 *
 * Three things are happening here, in priority order:
 *
 *   inner loop   — drag makes a drag-free parabola land well short, so stretch
 *                  the horizontal distance fed to the closed form until the
 *                  *measured* landing is on target. Measured with the same
 *                  integrator the match loop runs, so it is exact.
 *   time search  — both failure modes need to be reachable: a shot that clips the
 *                  tape is too flat and wants more time, one that drops short of
 *                  the net is too lofted and wants less. Sweeping beats reasoning
 *                  about which, and each attempt is cheap.
 *   rescue       — if nothing both clears and lands accurately, accept any
 *                  trajectory that clears and stays on the opponent's side. A
 *                  bad swing should still return the ball; it just returns it
 *                  somewhere boring. A fully-assisted shot finding the net reads
 *                  as the game cheating, and it is.
 */
export function solveTimed(
  from: Vec3,
  target: Vec3,
  T0: number,
  court: CourtSpec,
  ball: BallSpec,
  minClearance: number,
  latitude = 1,
): TimedSolve | null {
  const dx = target[0] - from[0];
  const dz = target[2] - from[2];
  const S = Math.hypot(dx, dz);
  if (S < 0.25 || !Number.isFinite(S)) return null;

  const dirH: Vec3 = [dx / S, 0, dz / S];
  const dy = target[1] - from[1];
  const netFloor =
    surfaceAt(court, from[0], 0) + court.netHeight + ball.radius + minClearance;
  const toward = Math.sign(dz);
  const tolerance = TUNING.shot.placementTolerance;

  /**
   * One attempt at a given flight time: solve the closed form, then stretch the
   * horizontal distance fed to it until the MEASURED landing is on target. Drag
   * makes a drag-free parabola land well short, and by a lot for a ball this
   * draggy, so the correction is the difference between a shot model that works
   * and one that is mysteriously inaccurate.
   */
  const attempt = (T: number) => {
    let Sadj = S;
    let v = solveByTime(dirH, Sadj, dy, T, ball.gravityScale);
    let probe = flightProbe(from, v, court, ball);
    for (let i = 0; i < 7; i++) {
      if (!probe.landing) break;
      const err = S - Math.hypot(probe.landing[0] - from[0], probe.landing[2] - from[2]);
      if (Math.abs(err) < 0.05) break;
      Sadj += err * 0.9;
      if (Sadj < 0.25) break;
      v = solveByTime(dirH, Sadj, dy, T, ball.gravityScale);
      probe = flightProbe(from, v, court, ball);
    }
    const clears = probe.netY !== null && probe.netY >= netFloor;
    const onTarget =
      clears &&
      probe.landing !== null &&
      Math.hypot(target[0] - probe.landing[0], target[2] - probe.landing[2]) < tolerance;
    const inPlay =
      clears && probe.landing !== null && Math.sign(probe.landing[2]) === toward;
    return { v, T, clears, onTarget, inPlay, netY: probe.netY ?? Number.NEGATIVE_INFINITY };
  };

  // Nearest the requested time first, then alternating shorter and longer, then
  // progressively loopier for the geometries that barely have an answer.
  //
  // `latitude` is how much of that search the player has earned. At 1 the game
  // hunts hard for a trajectory that works; at 0 the swing is committed and gets
  // only roughly the time it asked for. That is the mechanism behind pressure: a
  // rushed player does not get a worse *version* of the shot they wanted, they
  // get less help finding one that works at all — which is what being rushed
  // actually feels like, and it produces tape-clips and long balls on its own
  // without any special-case error dice.
  const ALL = [1, 1.15, 0.87, 1.33, 0.76, 1.55, 1.8, 2.2, 2.8];
  const span = Math.max(2, Math.round(1 + clamp01(latitude) * (ALL.length - 1)));
  const mayRescue = minClearance >= 0 && latitude > TUNING.shot.rescueLatitudeCut;

  let best: TimedSolve | null = null;
  let bestNetY = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < span; i++) {
    const a = attempt(T0 * ALL[i]);
    if (a.onTarget) return { v: a.v, T: a.T, clears: true, rescued: false };
    if (!best || a.netY > bestNetY) {
      best = { v: a.v, T: a.T, clears: a.clears, rescued: false };
      bestNetY = a.netY;
    }
  }

  // Rescue: clearance first, placement second.
  //
  // Latitude gates WHETHER a shot gets rescued, not how hard the rescue is
  // allowed to look — so a player who has earned help gets the full search. The
  // ball ends up short of where it was aimed but still in play, which is the
  // right trade: a bad swing should still return the ball, it just returns it
  // somewhere boring. An assisted shot finding the net reads as the game
  // cheating, and it is.
  if (mayRescue) {
    for (const mul of ALL) {
      const a = attempt(T0 * mul);
      if (a.inPlay) return { v: a.v, T: a.T, clears: true, rescued: true };
    }
  }
  return best;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export interface ShotPlan {
  /** 0 = fully assisted, 1 = entirely the player's intent. */
  blend: number;
  quality: number;
  /** 0..1 difficulty of the ball being returned. */
  difficulty: number;
}

/**
 * Build the shot. `blend` is where leniency lives: a bad swing still returns the
 * ball, it just returns it somewhere boring.
 */
export function mapSwingToShot(swing: SwingInput, ctx: ShotContext, plan: ShotPlan): Shot {
  const power = clamp01(remap01(swing.speed, 1.2, TUNING.motion.speedCeiling));
  const type = classifyShot(swing, ctx);
  const depth = depthFor(type, power);

  const aim = playerAimDir(swing, ctx.seat);
  const wanted = aimTarget(aim, ctx, depth);
  const safe = safeTarget(ctx, type === 'dink' ? depth : Math.min(depth, TUNING.shot.safeDepth));

  const blend = clamp01(plan.blend);
  const half = ctx.court.length / 2;

  /**
   * Pressure: what a hard ball met with a poor swing actually produces.
   *
   * Assistance alone is not enough of a model. If a badly-struck ball is simply
   * steered to a safe target it always lands in, which means a rally under
   * pressure never ends and every point runs to thirty shots. Real sports end
   * rallies because difficulty produces *errors* — balls that drift wide, drop
   * long, or catch the tape. So pressure perturbs the placement and eats into
   * the net clearance the assistance would otherwise guarantee.
   */
  const pressure = clamp01((1 - plan.quality) * (0.35 + plan.difficulty));
  const marginX = ctx.court.width / 2 + lerp(0.05, 1.4, blend);
  const marginZ = half + lerp(0.05, 1.2, blend);

  let target: Vec3 = [
    clamp(
      lerp(safe[0], wanted[0], blend) + ctx.rng.gauss(pressure * TUNING.shot.pressureSpread),
      -marginX - 1.2,
      marginX + 1.2,
    ),
    0,
    clamp(
      lerp(safe[2], wanted[2], blend) +
        -seatSign(ctx.seat) * ctx.rng.gauss(pressure * TUNING.shot.pressureSpread * 0.8),
      -marginZ - 1.2,
      marginZ + 1.2,
    ),
  ];
  // Keep the target on the opponent's side no matter how wild the aim.
  const toward = -seatSign(ctx.seat);
  if (Math.sign(target[2]) !== toward) target[2] = toward * 0.9;

  // Feasibility: a ball cannot be dropped arbitrarily short from arbitrarily far
  // back. Landing close behind the net while standing on your own baseline needs
  // a descent so steep that no spinless trajectory survives the drag — which is
  // exactly why the third shot drop is the hardest shot in real pickleball. So
  // the minimum landing distance past the net scales with how far back contact
  // was made. The pleasant consequence is that the same "soft swing" input reads
  // as a drop from the baseline and a dink from the kitchen line, with no extra
  // shot type and no special case.
  const behindNet = Math.abs(ctx.from[2]);
  const minPast = Math.max(1.2, behindNet * TUNING.shot.minLandingRatio);
  if (Math.abs(target[2]) < minPast) target[2] = toward * minPast;
  target[1] = surfaceAt(ctx.court, target[0], target[2]) + ctx.ball.radius;

  // Net clearance, as a SIGNED margin above the tape.
  //
  // A heavily assisted shot is promised a real margin and a player swinging with
  // genuine quality is allowed to skim. Pressure then eats into that margin in
  // metres, and is allowed to push it negative — which is how a net error
  // happens: because the player was under pressure and hit a poor ball, not
  // because the solver gave up. Those are very different things to debug, and
  // only one of them is a game mechanic.
  const minClearance =
    lerp(TUNING.shot.netClearance, 0.05, blend) - pressure * TUNING.shot.pressureNetBite;

  // A rushed shot is hit flatter and harder than the one that was intended.
  const T =
    flightTimeFor(type, power, ctx.params.flightScale) *
    (1 - pressure * TUNING.shot.pressureRush);

  const solved = solveTimed(
    ctx.from,
    target,
    T,
    ctx.court,
    ctx.ball,
    minClearance,
    1 - pressure,
  );
  let v = solved?.v ?? null;

  // Last-resort fallback: a plain loop up the middle. This must never be null —
  // a dead ball mid-rally is the worst failure the simulation can have.
  if (!v) {
    const dirH = vnorm([safe[0] - ctx.from[0], 0, safe[2] - ctx.from[2]]);
    const S = Math.hypot(safe[0] - ctx.from[0], safe[2] - ctx.from[2]);
    v = solveByTime(dirH, S * 1.12, safe[1] - ctx.from[1], 1.3, ctx.ball.gravityScale);
    target = safe;
  }

  return {
    v,
    type,
    power,
    target,
    netY: surfaceAt(ctx.court, ctx.from[0], 0) + ctx.court.netHeight + minClearance,
    speed: vlen(v),
    flightT: solved?.T ?? 1.3,
    clearsNet: solved?.clears ?? false,
    rescued: solved?.rescued ?? true,
  };
}

/** Serve: same solver, a fixed legal target, and a lot of assistance. */
export function mapServeToShot(swing: SwingInput, ctx: ShotContext): Shot {
  return mapSwingToShot(swing, ctx, {
    blend: 1 - TUNING.serve.assist,
    quality: 1,
    difficulty: 0,
  });
}
