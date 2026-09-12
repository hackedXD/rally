/**
 * The entire physics engine. Roughly 150 lines, hand-rolled, deterministic,
 * tunable from one file. Resist the urge to add a real engine.
 *
 *   a = gravity + drag + magnus
 *   drag   = -DRAG_K * |v| * v
 *   magnus = MAGNUS_K * (omega x v)     — v1: omega = 0, term disabled
 *   integrate: semi-implicit Euler at the fixed 60 Hz tick
 */

import type { BallSpec, CourtSpec, Vec3 } from '@rally/protocol';
import { vadd, vlen, vmul } from '@rally/protocol';

export const GRAVITY = 9.81;

export interface BallBody {
  p: Vec3;
  v: Vec3;
  spin: number;
  /** Bounces since the ball last crossed the net plane. */
  b: number;
  /** Sign of the half the last bounce happened on, or 0 if none yet. */
  bounceSide: -1 | 0 | 1;
}

export type PhysicsHit =
  | { kind: 'none' }
  | { kind: 'bounce'; at: Vec3; inBounds: boolean; side: -1 | 1; speed: number }
  | { kind: 'net'; at: Vec3; speed: number }
  | { kind: 'crossed'; side: -1 | 1 }
  | { kind: 'floor'; at: Vec3; speed: number };

/** Surface height directly under a world position (table top, or the floor). */
export function surfaceAt(court: CourtSpec, x: number, z: number): number {
  if (court.tableHeight <= 0) return 0;
  const onTable = Math.abs(x) <= court.width / 2 && Math.abs(z) <= court.length / 2;
  return onTable ? court.tableHeight : 0;
}

export function isInBounds(court: CourtSpec, x: number, z: number): boolean {
  return Math.abs(x) <= court.width / 2 && Math.abs(z) <= court.length / 2;
}

/** Acceleration on the ball at a given velocity. */
export function ballAccel(ball: BallSpec, v: Vec3): Vec3 {
  const speed = vlen(v);
  const drag = vmul(v, -ball.dragK * speed);
  return [drag[0], -GRAVITY * ball.gravityScale + drag[1], drag[2]];
}

/**
 * Advance the ball one step and report the first significant interaction.
 *
 * Mutates `body`. Events are returned rather than emitted so that the caller —
 * the match loop, or the forward predictor running the identical code — decides
 * what they mean.
 */
export function stepBall(
  body: BallBody,
  dt: number,
  court: CourtSpec,
  ball: BallSpec,
): PhysicsHit {
  const z0 = body.p[2];

  // Semi-implicit Euler: accelerate first, then move with the new velocity.
  const a = ballAccel(ball, body.v);
  body.v = vadd(body.v, vmul(a, dt));
  const pNext = vadd(body.p, vmul(body.v, dt));

  // ── Net, checked on the z crossing so a fast ball cannot tunnel through ────
  if (z0 !== pNext[2] && Math.sign(z0) !== Math.sign(pNext[2]) && z0 !== 0) {
    const f = (0 - z0) / (pNext[2] - z0);
    const xAt = body.p[0] + (pNext[0] - body.p[0]) * f;
    const yAt = body.p[1] + (pNext[1] - body.p[1]) * f;
    const netBase = surfaceAt(court, xAt, 0);
    const netTop = netBase + court.netHeight;
    const withinPosts = Math.abs(xAt) <= court.width / 2 + 0.08;
    if (withinPosts && yAt - ball.radius <= netTop) {
      const speed = vlen(body.v);
      // Dribble down the near side of the net rather than teleport.
      body.p = [xAt, Math.max(yAt, netBase + ball.radius), -Math.sign(pNext[2]) * 0.02];
      body.v = [body.v[0] * 0.2, -Math.abs(body.v[1]) * 0.2 - 0.4, -body.v[2] * 0.12];
      return { kind: 'net', at: [xAt, yAt, 0], speed };
    }
    body.p = pNext;
    body.b = 0;
    body.bounceSide = 0;
    return { kind: 'crossed', side: pNext[2] < 0 ? -1 : 1 };
  }

  body.p = pNext;

  // ── Surface ───────────────────────────────────────────────────────────────
  const surf = surfaceAt(court, body.p[0], body.p[2]);
  if (body.p[1] - ball.radius <= surf && body.v[1] < 0) {
    const speed = vlen(body.v);
    const inBounds = isInBounds(court, body.p[0], body.p[2]);
    body.p = [body.p[0], surf + ball.radius, body.p[2]];
    body.v = [
      body.v[0] * ball.friction,
      -body.v[1] * ball.restitution,
      body.v[2] * ball.friction,
    ];
    // A bounce slower than this would roll, not bounce. Settle it.
    if (body.v[1] < 0.35) body.v = [body.v[0] * 0.5, 0, body.v[2] * 0.5];
    body.b += 1;
    const side: -1 | 1 = body.p[2] < 0 ? -1 : 1;
    body.bounceSide = side;

    // Off a table and onto the floor is not a bounce, it is gone.
    if (court.tableHeight > 0 && surf === 0) {
      return { kind: 'floor', at: [...body.p] as Vec3, speed };
    }
    return { kind: 'bounce', at: [...body.p] as Vec3, inBounds, side, speed };
  }

  return { kind: 'none' };
}

/** Clone a ball body. Prediction must never disturb the authoritative state. */
export function cloneBody(b: BallBody): BallBody {
  return { p: [...b.p] as Vec3, v: [...b.v] as Vec3, spin: b.spin, b: b.b, bounceSide: b.bounceSide };
}

export function bodyFinite(b: BallBody): boolean {
  return (
    Number.isFinite(b.p[0]) &&
    Number.isFinite(b.p[1]) &&
    Number.isFinite(b.p[2]) &&
    Number.isFinite(b.v[0]) &&
    Number.isFinite(b.v[1]) &&
    Number.isFinite(b.v[2])
  );
}
