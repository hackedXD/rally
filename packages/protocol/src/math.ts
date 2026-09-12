/**
 * Tiny, dependency-free vector and quaternion maths.
 *
 * This lives in `protocol` rather than in `sim` or `motion` because all three
 * of those plus both web apps need it, and importing Three.js into the
 * simulation or into a pure sensor-fusion package would be absurd.
 *
 * Every function is pure and allocation-light. Nothing here reads the clock or
 * the random number generator.
 */

import type { Quat, Vec3 } from './primitives.js';

export const EPS = 1e-9;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

// ── Vec3 ──────────────────────────────────────────────────────────────────────

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const vclone = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vlen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const vlenSq = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const vdist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const vcross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a);
  return l < EPS ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

/** Normalise, falling back to `fallback` for a degenerate input. */
export function vnormOr(a: Vec3, fallback: Vec3): Vec3 {
  const l = vlen(a);
  return l < EPS ? vclone(fallback) : [a[0] / l, a[1] / l, a[2] / l];
}

export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Angle between two vectors, radians, numerically safe. */
export function vangle(a: Vec3, b: Vec3): number {
  const d = vlen(a) * vlen(b);
  if (d < EPS) return 0;
  return Math.acos(clamp(vdot(a, b) / d, -1, 1));
}

export const vfinite = (a: Vec3): boolean =>
  Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

/** Spherical interpolation between two directions. Handles the antipodal case. */
export function slerpDir(a: Vec3, b: Vec3, t: number): Vec3 {
  const na = vnorm(a);
  const nb = vnorm(b);
  const d = clamp(vdot(na, nb), -1, 1);
  if (d > 0.9995) return vnorm(vlerp(na, nb, t));
  if (d < -0.9995) {
    // Antipodal: pick any perpendicular axis and rotate through it.
    const axis = vnorm(vcross(na, Math.abs(na[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    return vnorm(rotateAboutAxis(na, axis, Math.PI * t));
  }
  const theta = Math.acos(d) * t;
  const rel = vnorm(vsub(nb, vmul(na, d)));
  return vnorm(vadd(vmul(na, Math.cos(theta)), vmul(rel, Math.sin(theta))));
}

export function rotateAboutAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const k = vnorm(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Rodrigues' rotation formula.
  return vadd(vadd(vmul(v, c), vmul(vcross(k, v), s)), vmul(k, vdot(k, v) * (1 - c)));
}

/** Rotate a vector about world +Y by `angle` radians. */
export function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

// ── Scalars ───────────────────────────────────────────────────────────────────

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const clamp01 = (x: number): number => clamp(x, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Map x from [inLo, inHi] onto [0, 1], clamped. */
export const remap01 = (x: number, inLo: number, inHi: number): number =>
  inHi - inLo < EPS ? 0 : clamp01((x - inLo) / (inHi - inLo));

export const smoothstep = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential smoothing factor. */
export const damp = (lambda: number, dt: number): number => 1 - Math.exp(-lambda * dt);

export const sign = (x: number): number => (x < 0 ? -1 : 1);

// ── Quat ──────────────────────────────────────────────────────────────────────

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export const qclone = (q: Quat): Quat => [q[0], q[1], q[2], q[3]];

export function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (l < EPS) return [0, 0, 0, 1];
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Hamilton product: the rotation `b` followed by the rotation `a`. */
export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Rotate a vector by a quaternion. */
export function qrot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (q_vec × v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const a = vnorm(axis);
  const h = angle / 2;
  const s = Math.sin(h);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
}

export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    d = -d;
  }
  if (d > 0.9995) {
    return qnorm([
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]);
  }
  const theta0 = Math.acos(clamp(d, -1, 1));
  const theta = theta0 * t;
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (d * Math.sin(theta)) / sinTheta0;
  const s1 = Math.sin(theta) / sinTheta0;
  return qnorm([
    a[0] * s0 + bx * s1,
    a[1] * s0 + by * s1,
    a[2] * s0 + bz * s1,
    a[3] * s0 + bw * s1,
  ]);
}

/**
 * Intrinsic Tait-Bryan angles in 'YXZ' order, matching Three.js's Euler
 * convention. Used by the device-orientation fusion path in `@rally/motion`.
 */
export function qFromEulerYXZ(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

/** Yaw (rotation about world +Y) extracted from a quaternion, radians. */
export function yawOf(q: Quat): number {
  const fwd = qrot(q, [0, 0, -1]);
  return Math.atan2(fwd[0], -fwd[2]);
}

export const qfinite = (q: Quat): boolean =>
  Number.isFinite(q[0]) && Number.isFinite(q[1]) && Number.isFinite(q[2]) && Number.isFinite(q[3]);

// ── Quantisation (pose is sent at 30 Hz; every byte counts) ───────────────────

/** Pack a unit quaternion into four int16s. */
export function quantQuat(q: Quat): [number, number, number, number] {
  const n = qnorm(q);
  return [
    Math.round(clamp(n[0], -1, 1) * 32767),
    Math.round(clamp(n[1], -1, 1) * 32767),
    Math.round(clamp(n[2], -1, 1) * 32767),
    Math.round(clamp(n[3], -1, 1) * 32767),
  ];
}

export function dequantQuat(q: readonly number[]): Quat {
  return qnorm([
    (q[0] ?? 0) / 32767,
    (q[1] ?? 0) / 32767,
    (q[2] ?? 0) / 32767,
    (q[3] ?? 32767) / 32767,
  ]);
}

/** Round to `places` decimals. Used to keep JSON snapshots compact. */
export const r = (x: number, places = 3): number => {
  const m = 10 ** places;
  return Math.round(x * m) / m;
};

export const rv = (v: Vec3, places = 3): Vec3 => [r(v[0], places), r(v[1], places), r(v[2], places)];

/**
 * Shortest-arc rotation taking local +Z onto `dir`. Used to synthesise a paddle
 * orientation for the bot, the auto-serve, and the keyboard controller, all of
 * which know where they want to aim but have no sensor to ask.
 */
export function qFromUnitZTo(dir: Vec3): Quat {
  const d = vnorm(dir);
  if (vlen(d) < EPS) return [0, 0, 0, 1];
  const dot = clamp(d[2], -1, 1);
  if (dot > 0.999999) return [0, 0, 0, 1];
  if (dot < -0.999999) return [0, 1, 0, 0]; // 180 degrees about Y
  const axis: Vec3 = [-d[1], d[0], 0]; // cross([0,0,1], d)
  const s = Math.sqrt((1 + dot) * 2);
  return qnorm([axis[0] / s, axis[1] / s, axis[2] / s, s / 2]);
}

// ── Rotation vectors (the exponential map on SO(3)) ───────────────────────────

/**
 * Rotation vector (axis * angle, radians) -> quaternion. The exponential map.
 *
 * This and `qToRotVec` are what let a rotation be treated as a vector for the
 * length of one arithmetic step — scaled by a horizon, added onto a pose — which
 * is what the pose predictor in `@rally/motion` is built out of. Quaternions
 * multiply; angular velocities add, and only in this representation.
 */
export function qFromRotVec(r: Vec3): Quat {
  const theta = vlen(r);
  // sin(θ/2)/θ -> 1/2 as θ -> 0. Below this the series and the division agree to
  // float precision, and the division does not.
  if (theta < 1e-7) return qnorm([r[0] / 2, r[1] / 2, r[2] / 2, 1]);
  const s = Math.sin(theta / 2) / theta;
  return [r[0] * s, r[1] * s, r[2] * s, Math.cos(theta / 2)];
}

/**
 * Quaternion -> rotation vector, always the short way round.
 *
 * q and -q are the same rotation; the sign is chosen so the result is the arc
 * under 180 degrees. Without that a paddle crossing the boundary reports a
 * 359-degree turn and everything downstream sees a rotation rate in the
 * thousands.
 */
export function qToRotVec(q: Quat): Vec3 {
  const n = qnorm(q);
  const flip = n[3] < 0 ? -1 : 1;
  const x = n[0] * flip;
  const y = n[1] * flip;
  const z = n[2] * flip;
  const w = n[3] * flip;
  const sin = Math.hypot(x, y, z);
  if (sin < 1e-9) return [2 * x, 2 * y, 2 * z];
  const theta = 2 * Math.atan2(sin, clamp(w, -1, 1));
  const k = theta / sin;
  return [x * k, y * k, z * k];
}

/** Angle between two orientations, radians. The one honest error metric. */
export function qAngle(a: Quat, b: Quat): number {
  return vlen(qToRotVec(qmul(a, qconj(b))));
}
