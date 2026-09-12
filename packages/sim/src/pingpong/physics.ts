/**
 * Table tennis ball flight and collisions, transplanted from `pickle`.
 *
 * Pure functions: every step returns a new ball. This is a genuinely different
 * physics from `../physics.ts` — that one is a point with quadratic drag and a
 * restitution multiply, which is all pickleball and badminton need. Here the
 * ball carries angular velocity, curves in flight, and is resolved against
 * every surface with one Coulomb friction model. Spin is not decoration: it is
 * what makes a loop dip and a chop float, and it is the reason this file exists.
 */

import { vadd, vcross, vdot, vlen, vmul, vsub, type Vec3 } from '@rally/protocol';
import {
  BALL,
  DRAG,
  GRAVITY,
  MAGNUS,
  MU_NET,
  MU_TABLE,
  NET,
  REST_NET,
  REST_TABLE,
  SPIN_DECAY,
  TABLE,
  TICK,
  onTableFootprint,
} from './constants.js';

const SUBSTEPS = 4; //      a 14 m/s ball moves 23 cm per 60 Hz tick; it would tunnel
const NET_TAPE = 0.012; //  clip this close to the top and the ball dribbles over

export interface PpBall {
  p: Vec3;
  v: Vec3;
  spin: Vec3;
}

export type PpEventType = 'bounce' | 'net' | 'letcord' | 'floor';

export interface PpEvent {
  type: PpEventType;
  /** Which half the ball landed on. Present on 'bounce' only. */
  side?: 0 | 1;
  at?: Vec3;
  speed?: number;
}

export const makeBall = (p: Vec3, v: Vec3, spin: Vec3 = [0, 0, 0]): PpBall => ({ p, v, spin });

const integrate = (ball: PpBall, dt: number): PpBall => {
  const speed = vlen(ball.v);
  let v = vadd(ball.v, vmul(GRAVITY as unknown as Vec3, dt));
  v = vadd(v, vmul(ball.v, -DRAG * speed * dt)); //                  quadratic drag
  v = vadd(v, vmul(vcross(ball.spin, ball.v), MAGNUS * dt)); //      Magnus curve
  return {
    p: vadd(ball.p, vmul(v, dt)),
    v,
    spin: vmul(ball.spin, Math.max(0, 1 - SPIN_DECAY * dt)),
  };
};

/**
 * The net is a thin slab at z=0. Returns { ball, type } or null for a clean
 * pass. A ball that catches the very top of the tape dribbles over instead of
 * coming back — the let cord. It is the funniest thing that happens in a match,
 * so it gets its own branch.
 */
const hitNet = (prev: PpBall, next: PpBall): { type: PpEventType; ball: PpBall } | null => {
  const crossed = prev.p[2] * next.p[2] <= 0 && prev.p[2] !== next.p[2];
  if (!crossed) return null;

  const t = prev.p[2] / (prev.p[2] - next.p[2]);
  const yAt = prev.p[1] + (next.p[1] - prev.p[1]) * t;
  const xAt = prev.p[0] + (next.p[0] - prev.p[0]) * t;
  const tape = TABLE.TOP + NET.HEIGHT;
  if (yAt - BALL.R >= tape) return null;
  if (Math.abs(xAt) >= TABLE.WIDTH / 2 + NET.OVERHANG) return null;

  if (yAt + BALL.R > tape - NET_TAPE) {
    // clipped the cord: keeps going, but slowly and with a little pop
    return {
      type: 'letcord',
      ball: {
        p: [xAt, tape + BALL.R, Math.sign(next.p[2]) * BALL.R],
        v: [next.v[0] * 0.35, Math.abs(next.v[1]) * 0.3 + 0.5, next.v[2] * 0.3],
        spin: vmul(next.spin, 0.25),
      },
    };
  }

  const n: Vec3 = [0, 0, -Math.sign(next.v[2])];
  const c = contactImpulse(next.v, next.spin, n, REST_NET, MU_NET);
  return {
    type: 'net',
    ball: { p: [xAt, yAt, Math.sign(prev.p[2]) * BALL.R], v: c.v, spin: c.spin },
  };
};

/**
 * Rigid-sphere contact with Coulomb friction, in the surface's frame.
 *
 * The contact point of a spinning ball is not moving with the ball's centre — it
 * is moving at v + omega x r. Friction acts on THAT, which is why a backspin
 * ball skids and sits up while a topspin ball grips and kicks forward, and why a
 * brushed paddle imparts spin at all. One model, used by the table, the net and
 * the paddle; nothing here is a special case.
 *
 * Impulses are per unit mass. For a uniform sphere I/m = (2/5)R^2, so the
 * tangential impulse that exactly stops the contact point is (2/7)|u_t|; if
 * friction cannot supply that, the ball slides at mu * jn instead.
 *
 * @param surfaceV velocity of the surface itself (a swinging paddle)
 */
export const contactImpulse = (
  v: Vec3,
  spin: Vec3,
  n: Vec3,
  e: number,
  mu: number,
  surfaceV: Vec3 = [0, 0, 0],
): { v: Vec3; spin: Vec3 } => {
  const rel = vsub(v, surfaceV);
  const vn = vdot(rel, n);
  if (vn >= 0) return { v, spin }; // already separating

  const u = vadd(rel, vcross(spin, vmul(n, -BALL.R))); // contact point velocity
  const ut = vsub(u, vmul(n, vdot(u, n)));
  const utMag = vlen(ut);

  const jn = -(1 + e) * vn;
  const jt = Math.min((2 / 7) * utMag, mu * jn); // stick if friction allows, else slide
  const Jt: Vec3 = utMag > 1e-9 ? vmul(ut, -jt / utMag) : [0, 0, 0];

  return {
    v: vadd(vadd(v, vmul(n, jn)), Jt),
    // dOmega = (r x J) / (I/m),  r = -R n
    spin: vadd(spin, vmul(vcross(n, Jt), -5 / (2 * BALL.R))),
  };
};

const bounceTable = (ball: PpBall): PpBall => {
  const c = contactImpulse(ball.v, ball.spin, [0, 1, 0], REST_TABLE, MU_TABLE);
  return { p: [ball.p[0], TABLE.TOP + BALL.R, ball.p[2]], v: c.v, spin: c.spin };
};

const bounceFloor = (ball: PpBall): PpBall => ({
  p: [ball.p[0], BALL.R, ball.p[2]],
  v: [ball.v[0] * 0.7, -ball.v[1] * 0.5, ball.v[2] * 0.7],
  spin: vmul(ball.spin, 0.5),
});

/**
 * Advance one substep. Returns { ball, events } where events name what the match
 * rules care about: 'bounce' (with side), 'net', 'letcord', 'floor'.
 */
const substep = (ball: PpBall, dt: number): { ball: PpBall; events: PpEvent[] } => {
  const events: PpEvent[] = [];
  let next = integrate(ball, dt);

  const netted = hitNet(ball, next);
  if (netted) {
    events.push({ type: netted.type, at: next.p, speed: vlen(next.v) });
    next = netted.ball;
  }

  const overTable = onTableFootprint(next.p);
  if (overTable && next.v[1] < 0 && next.p[1] - BALL.R <= TABLE.TOP) {
    events.push({
      type: 'bounce',
      side: next.p[2] < 0 ? 0 : 1,
      at: next.p,
      speed: vlen(next.v),
    });
    next = bounceTable(next);
  } else if (next.p[1] - BALL.R <= 0 && next.v[1] < 0) {
    events.push({ type: 'floor', at: next.p, speed: vlen(next.v) });
    next = bounceFloor(next);
  }

  return { ball: next, events };
};

/** Advance a full 60 Hz tick, substepped to avoid tunnelling. */
export const step = (ball: PpBall, dt: number = TICK): { ball: PpBall; events: PpEvent[] } => {
  let cur = ball;
  const events: PpEvent[] = [];
  for (let i = 0; i < SUBSTEPS; i++) {
    const r = substep(cur, dt / SUBSTEPS);
    cur = r.ball;
    events.push(...r.events);
  }
  return { ball: cur, events };
};

/**
 * Play a shot forward until it first resolves: a table bounce, the net, or the
 * floor. Returns null if it is somehow still airborne. Used to answer the only
 * question that matters when assisting a swing — would this one have landed?
 */
export const firstLanding = (
  ball: PpBall,
  maxSeconds = 3,
): { type: PpEventType; side?: 0 | 1; at: Vec3 } | null => {
  let cur = ball;
  for (let i = 0; i < maxSeconds / TICK; i++) {
    const r = step(cur);
    cur = r.ball;
    for (const e of r.events) {
      if (e.type === 'bounce') return { type: 'bounce', side: e.side, at: e.at ?? cur.p };
      if (e.type === 'net' || e.type === 'floor') return { type: e.type, at: e.at ?? cur.p };
    }
  }
  return null;
};

/** Where the ball will be in `ms`, ignoring collisions. Used for hit lookahead. */
export const predict = (ball: PpBall, ms: number): Vec3 => {
  let cur = ball;
  const n = Math.ceil(ms / 1000 / TICK);
  for (let i = 0; i < n; i++) cur = integrate(cur, TICK);
  return cur.p;
};
