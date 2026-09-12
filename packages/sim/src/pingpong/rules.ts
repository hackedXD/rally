/**
 * Table tennis rules, and the swing -> ball mapping. Transplanted from `pickle`.
 *
 * Pure functions over an immutable match object. Nothing in here knows about a
 * socket, a clock, or a snapshot — `./match.ts` is the adapter that turns this
 * into something Rally's server can run.
 */

import {
  clamp,
  qmul,
  qrot,
  vadd,
  vcross,
  vdot,
  vlen,
  vlerp,
  vmul,
  vnorm,
  vsub,
  type Quat,
  type Vec3,
} from '@rally/protocol';
import {
  AIM,
  ASSIST,
  BALL,
  BLADE_FORGIVENESS,
  BLADE_R,
  HIT_ZONE,
  PADDLE,
  PLACEMENT_BUCKETS,
  PLACEMENT_SPREAD,
  QUAD,
  SERVE_ROTATION,
  SERVE_TOSS_V,
  STEER_AIM,
  STEER_GAIN,
  STEER_REF,
  STROKE_MIN,
  TABLE,
  TICK,
  WIN_SCORE,
  dirOf,
  homeZ,
  rightOf,
} from './constants.js';
import { contactImpulse, firstLanding, makeBall, step, type PpBall, type PpEvent } from './physics.js';

/**
 * Rally's player frame into this engine's.
 *
 * They disagree about one axis, and it is the one that matters. Rally's
 * controller reports a pose in a frame where +Z is the direction the player
 * FACES and the paddle's face normal is local +Z. This engine came from a
 * project whose player frame has +Z BEHIND the player and whose face normal is
 * local -Z. Two conventions, one physical bat.
 *
 * The change of basis is `diag(1, 1, -1)` — a reflection, applied on both sides
 * (the world axis and the paddle's own), which composes back into a rotation and
 * so is expressible as a quaternion: negate x and y, keep z and w.
 *
 * Getting this wrong does not look like a frame bug. It looks like reaching
 * right moving the bat left — and only left and right, because the vertical axis
 * is untouched, which is exactly the kind of half-working that reads as bad
 * tracking rather than as a sign.
 */
export const toPpPose = (q: Quat): Quat => [-q[0], -q[1], q[2], q[3]];

/**
 * Hand velocity, same change of basis. An ordinary vector, so only z flips.
 */
export const toPpHandVel = (v: Vec3): Vec3 => [v[0], v[1], -v[2]];

/**
 * Wrist rotation rate, same change of basis — and NOT the same formula.
 *
 * Angular velocity is a pseudovector: under a reflection it picks up an extra
 * sign, so `-R w` rather than `R w`. Concretely, x and y flip and z does not,
 * which is the exact opposite of what happens to the hand's velocity. Swap the
 * two and a forward swing sends the ball backwards.
 */
export const toPpOmega = (w: Vec3): Vec3 => [-w[0], -w[1], w[2]];

const DEG = Math.PI / 180;
const YAW180: Quat = [0, 1, 0, 0]; // seat 0 faces +z; their calibrated forward needs flipping
const IDEAL_CONTACT = TABLE.LEN / 2 + 0.15;
// The ready position quadrants are measured from: table centre, bat up.
const NEUTRAL_X = 0;
export const NEUTRAL_Y = TABLE.TOP + 0.25;
export const NEUTRAL: readonly [number, number] = [NEUTRAL_X, NEUTRAL_Y];
const MAX_SPIN = 600; //     rad/s ~= 95 rev/s, about what a pro generates
const AIM_ANGLES = [-8, -4, 0, 4, 8, 12, 17, 22, 28, 34, 41, 48]; // elevation, degrees
/**
 * Speed multipliers ordered by distance from the player's own swing, so the
 * closest rescue wins. Both directions: a shot can fail by being too weak to
 * cross OR too hot and long, and only searching upward fixes half of them.
 *
 * Deliberately NARROW. These used to run from 0.42x to 2.2x, which meant the
 * assist could rescue a feeble shot by quintupling its speed — so how hard you
 * swung barely reached the ball. Keeping them close to 1 leaves the assist doing
 * what it should (pointing the shot somewhere that lands) and leaves the speed
 * where it belongs (whatever the player actually hit it at).
 */
const AIM_SPEEDS = [1, 0.92, 1.1, 0.82, 1.3, 0.7, 1.6, 0.55, 1.9];
/**
 * A noisy wrist maps into a playable cone, not a continuum. Without this a 40
 * degree wobble sends the ball 40 degrees wide and no assist can save it.
 */
const MAX_YAW = 20 * DEG;
const MIN_EL = -10 * DEG;
const MAX_EL = 35 * DEG;

/** Clamp a vector's magnitude without changing its direction. */
const clampLen = (a: Vec3, max: number): Vec3 => {
  const l = vlen(a);
  return l <= max ? a : vmul(a, max / l);
};

export type PpPhase = 'serve' | 'rally' | 'point' | 'over';

export interface PpHand {
  x: number;
  y: number;
  z?: number;
}

export interface PpMatchState {
  phase: PpPhase;
  /** Tracked bat position per seat, when a phone is driving one. */
  hands: (PpHand | null)[];
  /** Bat orientation per seat, for touching the ball. */
  poses: (Quat | null)[];
  /** Last tick's bat position, to get its velocity. */
  paddlePrev: (Vec3 | null)[];
  server: 0 | 1;
  score: [number, number];
  ball: PpBall;
  lastHit: 0 | 1 | null;
  bouncesSinceHit: number;
  rallyHits: number;
  lastEvent: PpLastEvent | null;
  winner: 0 | 1 | null;
}

export type PpLastEvent =
  | { type: 'hit'; player: 0 | 1; speed: number; touch?: boolean }
  | { type: 'point'; player: 0 | 1; reason: string }
  | { type: 'gameover'; player: 0 | 1; reason: string };

export interface PpSwing {
  /** Paddle orientation at peak, already in the player's own frame. */
  q: Quat;
  /** Rotation rate at peak, device axes, deg/s. */
  omega: Vec3;
  /** Hand velocity at peak, player motion frame (+x right, +y up, +z behind). */
  vsw?: Vec3 | null;
}

/**
 * Toss the serve. Same place, every single time.
 *
 * A toss that follows the bat sounds helpful and is not: hand x is derived from
 * wrist TILT across a 1.35 m span, not from where the player is standing, so
 * "next to your free hand" is not a place the player can feel or aim — the ball
 * simply appears somewhere different on every serve. A serve you cannot predict
 * is not a skill, and the one thing a fixed toss costs (being out of reach) is
 * the thing `canHit` already gives back by exempting your own serve.
 */
export const SERVE_TOSS_Z = TABLE.LEN / 2 - 0.05; // just over your own end line

export const serveBall = (server: 0 | 1): PpBall =>
  makeBall([0, TABLE.TOP + 0.18, -dirOf(server) * SERVE_TOSS_Z], [0, SERVE_TOSS_V, 0]);

export const newMatch = (server: 0 | 1 = 0): PpMatchState => ({
  phase: 'serve',
  hands: [null, null],
  poses: [null, null],
  paddlePrev: [null, null],
  server,
  score: [0, 0],
  ball: serveBall(server),
  lastHit: null,
  bouncesSinceHit: 0,
  rallyHits: 0,
  lastEvent: null,
  winner: null,
});

// --- swing ------------------------------------------------------------------

/**
 * World-space paddle frame from the phone's pose.
 *
 * A paddle has TWO faces and you hit with whichever one meets the ball — that is
 * what a forehand and a backhand are. So the hitting face is just the one
 * looking at the far end, picked per swing. There is no "which side is the bat"
 * setting on the phone because there is no such thing on a paddle, and the
 * setting that used to be there was only ever a way to hold it wrong.
 *
 * Edge-on (the face square to the table, normal[2] near zero) the choice is
 * arbitrary, but so is the shot — that contact is a glance either way.
 */
export const paddleFrame = (
  player: 0 | 1,
  q: Quat,
): { worldQ: Quat; normal: Vec3; arm: Vec3 } => {
  const worldQ = player === 0 ? qmul(YAW180, q) : q;
  const face = vnorm(qrot(worldQ, [0, 0, -1]));
  return {
    worldQ,
    normal: face[2] * dirOf(player) >= 0 ? face : vmul(face, -1),
    // the pivot is the wrist, one forearm down from the phone's -y end
    arm: qrot(worldQ, [0, PADDLE.ARM, 0]),
  };
};

/**
 * Velocity of the paddle face at contact, in world space.
 *
 *   v = v_linear + omega x r
 *
 * Both terms are needed. Rotation alone (omega x r) can only ever push: for a
 * wrist pivot the swing velocity and the face normal rotate together, so they
 * stay parallel and the tangential component is identically zero — no brush, no
 * spin, whatever angle you hold the phone at. The linear term is what makes a
 * topspin loop possible, because lifting the whole arm moves the face ACROSS the
 * ball rather than into it.
 *
 * `vsw` is the hand's actual velocity through space at contact, integrated on
 * the phone across the swing window. It carries both the power and the direction
 * of the stroke: how hard, and which way.
 *
 * It arrives already in the player's MOTION frame (+x their right, +y up, +z
 * behind them), so it needs only the seat's facing — never the device
 * orientation. Rotating it by the pose would make a swing's direction depend on
 * which way the phone happened to be pointing, and a paddle turns over
 * constantly in the hand.
 */
export const swingVelocity = (
  player: 0 | 1,
  q: Quat,
  omegaDeg: Vec3,
  vswMotion: Vec3 | null = null,
): { normal: Vec3; v: Vec3; vn: number; vt: Vec3; spun: Vec3; linear: Vec3 } => {
  const { worldQ, normal, arm } = paddleFrame(player, q);
  const omega = qrot(worldQ, [omegaDeg[0] * DEG, omegaDeg[1] * DEG, omegaDeg[2] * DEG]);
  const spun = vcross(omega, arm);
  const linear: Vec3 = vswMotion
    ? player === 0
      ? qrot(YAW180, vswMotion)
      : vswMotion
    : [0, 0, 0];
  const v = vmul(vadd(spun, linear), PADDLE.SWING_GAIN);
  const vn = vdot(v, normal);
  return { normal, v, vn, vt: vsub(v, vmul(normal, vn)), spun, linear };
};

/**
 * Hysteresis band for which face of the bat is "toward the table". An edge-on
 * bat must not chatter between its two sides.
 */
export const FACE_HYST = 0.12;

/**
 * Where a player's paddle sits in the world, from the phone's pose.
 *
 * The canonical face normal is [0,0,-1] when the paddle faces the table, so in
 * the player's own frame its x and y ARE the sideways and vertical offset — no
 * integration, no drift, no lag beyond the wire. `rightOf` then puts "the
 * player's right" on the correct side of the world for the end they stand at.
 *
 * This lives here rather than in the server because it is the single line that
 * decides whether reaching right moves the paddle right, and it has been
 * inverted more than once. In here it can be asserted; in the server it could
 * only be played.
 */
export const aimFromPose = (
  player: 0 | 1,
  q: Quat,
  neutral: readonly [number, number],
  prevFace = 0,
): { x: number; y: number; face: number } => {
  // WHICHEVER face is toward the table — not a fixed one.
  //
  // A forehand uses the other side of the bat, and turning the phone over is a
  // 180 degree turn about its own long axis, which sends the back's direction to
  // exactly its negative. Reading aim off the back alone therefore mirrored left
  // and right the moment you flipped for a forehand. Picking the face that is
  // actually facing the table makes the lateral aim identical either way up.
  const raw = qrot(q, [0, 0, -1]);
  let face = prevFace;
  if (raw[2] < -FACE_HYST) face = 1;
  else if (raw[2] > FACE_HYST) face = -1;
  if (!face) face = raw[2] <= 0 ? 1 : -1;
  const fwd = face === 1 ? raw : vmul(raw, -1);

  // Height comes off the TOP EDGE, not off the face. The face's tilt genuinely
  // inverts when you turn the bat over — a back tilted up becomes a screen
  // tilted down — so using it made forehands aim high and backhands aim low off
  // the same wrist. The top edge is the one direction that 180 degrees about the
  // long axis leaves alone, so it means the same thing either way up.
  const top = qrot(q, [0, 1, 0]);
  return {
    x: fwd[0] * AIM.SPAN_X * rightOf(player) + neutral[0],
    y: top[2] * AIM.SPAN_Y + neutral[1],
    face,
  };
};

/**
 * How hard to chase the aim this frame, given how far off it is.
 *
 * Exported and pure so it can be asserted: it is a feel knob, and the only thing
 * worse than a badly tuned one is a silently broken one. See AIM.SMOOTH /
 * AIM.FAST for why it is a curve and not a constant.
 */
export const aimEase = (err: number): number =>
  AIM.SMOOTH + (AIM.FAST - AIM.SMOOTH) * Math.min(1, Math.abs(err) / AIM.FULL);

/** Latest tracked hand for a player, or null when no phone is driving one. */
export const handOf = (match: PpMatchState, player: 0 | 1): PpHand | null =>
  match.hands?.[player] ?? null;

/** Replace one player's paddle orientation. */
export const setPose = (match: PpMatchState, player: 0 | 1, q: Quat | null): PpMatchState => ({
  ...match,
  poses: (match.poses ?? [null, null]).map((p, i) => (i === player ? q : p)),
});

/** Replace one player's tracked hand position. */
export const setHand = (
  match: PpMatchState,
  player: 0 | 1,
  hand: PpHand | null,
): PpMatchState => ({
  ...match,
  hands: (match.hands ?? [null, null]).map((h, i) => (i === player ? hand : h)),
});

/**
 * Where the paddle actually is. With a tracked hand that is a real place in the
 * world; without one the paddle auto-positions onto the ball, which is the Wii
 * model and the graceful fallback for a bot or a disconnected phone.
 */
export const paddlePos = (match: PpMatchState, player: 0 | 1): Vec3 => {
  const h = handOf(match, player);
  if (h) return [h.x, h.y, homeZ(player) + (h.z ?? 0) * dirOf(player)];
  return [match.ball.p[0], Math.max(TABLE.TOP + 0.1, match.ball.p[1]), homeZ(player)];
};

/**
 * Untracked this is generous by design — nearly the whole approach is reachable.
 * Tracked, the paddle has a real position and you have to put it where the ball
 * is, which is the entire point of holding a bat.
 */
export const canHit = (match: PpMatchState, player: 0 | 1): boolean => {
  const d = dirOf(player);
  const zp = match.ball.p[2] * -d; // distance from the net on this player's side
  if (zp <= HIT_ZONE.NEAR || zp >= TABLE.LEN / 2 + HIT_ZONE.FAR) return false;
  if (match.ball.v[2] * d > 0.5) return false; // must be coming toward this player

  // Your own serve is always within reach. The toss is fixed the moment it
  // leaves, but the bat keeps moving, so a tracked player could aim away from
  // their own toss and then be unable to strike it — which is not a skill, it is
  // a bug that feels like one. Serving is timing; reaching is the rally.
  const serving = match.phase === 'serve' && match.server === player;
  const h = serving ? null : handOf(match, player);
  if (!h) return match.ball.p[1] > HIT_ZONE.MIN_Y && match.ball.p[1] < HIT_ZONE.MAX_Y;

  // Two zones, not four: which side of you the ball is on, and nothing else.
  // Height was a quadrant too and it only ever took shots away — being inside
  // the z window at all IS the timing test.
  return sameSide(match, player, paddlePos(match, player)[0]);
};

/** Which side of the player a world x is on: -1 their left, +1 right, 0 middle. */
export const sideOf = (match: PpMatchState, player: 0 | 1, worldX: number): number =>
  quadrantOf((worldX - NEUTRAL_X) * rightOf(player), QUAD.X);

/** Is this x on the same side of the player as the ball? */
export const sameSide = (match: PpMatchState, player: 0 | 1, worldX: number): boolean => {
  const ball = sideOf(match, player, match.ball.p[0]);
  const mine = sideOf(match, player, worldX);
  return ball === 0 || mine === 0 || ball === mine;
};

/**
 * Was that the right stroke for that side — a forehand to the forehand, a
 * backhand to the backhand?
 *
 * Told from the DIRECTION THE HAND CAME FROM, not from which face of the bat was
 * used, and that is what makes it work for both hands. A stroke that starts on
 * the ball's side of you travels away from it: a forehand crosses the body one
 * way, a backhand the other, and that is true for a left-hander and a
 * right-hander alike. Asking "which face" would need to know which hand you hold
 * it in; asking "which way did your hand travel" does not.
 *
 * A drive straight through belongs to neither wing and plays both sides, and so
 * does a ball down the middle. Without hand velocity we do not guess — an
 * unknown stroke counts.
 */
export const strokeMatches = (
  match: PpMatchState,
  player: 0 | 1,
  vsw: Vec3 | null | undefined,
): boolean => {
  if (!vsw) return true;
  const lateral = vsw[0]; //                        player frame, + is their right
  if (Math.abs(lateral) < STROKE_MIN) return true; // straight through
  const side = sideOf(match, player, match.ball.p[0]);
  if (side === 0) return true; //                   down the middle
  return Math.sign(lateral) === -side;
};

/** Where a ball sits relative to the player: -1 left/low, +1 right/high, 0 neither. */
export const quadrantOf = (v: number, dead: number): number =>
  Math.abs(v) < dead ? 0 : Math.sign(v);

/**
 * Why a swing did not connect, or null if it did. Reachability is generous;
 * legality is not — you must let the ball bounce on your side before returning
 * it. Without that rule there is no reason ever to stop swinging, and timing
 * stops being a skill.
 */
export const swingCheck = (
  match: PpMatchState,
  player: 0 | 1,
  swing: PpSwing | null = null,
): string | null => {
  // There is deliberately NO aim gate here, and the other sports having one is
  // not a reason to add one. There, where the paddle points and where it IS are
  // independent. Here they are the same number: aim comes straight from the face
  // normal, so reaching right tilts the face off the table's axis by exactly as
  // much. Gating on that punishes reaching — the further you stretch, the more
  // "badly aimed" you look, until a wide ball cannot be played at all.
  // `paddleFrame` already turns the hitting face toward the far end, so there is
  // nothing left for such a gate to catch anyway.
  if (match.phase === 'serve') {
    return player === match.server ? (canHit(match, player) ? null : 'reach') : 'not your serve';
  }
  if (match.phase !== 'rally') return 'not in play';
  if (match.lastHit === player) return 'already yours';
  if (match.bouncesSinceHit < 1) return 'let it bounce';
  if (!canHit(match, player)) return 'reach';
  return strokeMatches(match, player, swing?.vsw) ? null : 'wrong wing';
};

/** Timing -> placement, quantized. Noisy wrists need buckets, not a continuum. */
const placementBucket = (match: PpMatchState, player: 0 | 1): number => {
  const d = dirOf(player);
  const err = (match.ball.p[2] - -d * IDEAL_CONTACT) * d; // >0 early, <0 late
  return clamp(Math.round(err / PLACEMENT_SPREAD), -PLACEMENT_BUCKETS, PLACEMENT_BUCKETS);
};

/** Fold a raw shot into the cone the game is willing to play. */
const constrainShot = (v: Vec3, d: 1 | -1): Vec3 => {
  const speed = vlen(v);
  const el = clamp(Math.atan2(v[1], Math.hypot(v[0], v[2])), MIN_EL, MAX_EL);
  const yaw = clamp(Math.atan2(v[0], v[2] * d), -MAX_YAW, MAX_YAW);
  const h = Math.cos(el) * speed;
  return [h * Math.sin(yaw), speed * Math.sin(el), h * Math.cos(yaw) * d];
};

/** Would this shot land on the opponent's half? */
const lands = (p: Vec3, v: Vec3, spin: Vec3, side: 0 | 1): boolean => {
  const r = firstLanding({ p, v, spin });
  return r?.type === 'bounce' && r.side === side;
};

/**
 * Find a launch velocity of the given speed that puts the ball near `target`.
 *
 * Closed-form ballistics cannot do this — a 2.7 g ball is dominated by drag and
 * Magnus — so just play each candidate elevation forward through the real
 * physics and keep the closest. Exact, self-tuning, and cheap enough at one
 * solve per swing.
 */
const solveAim = (
  from: Vec3,
  spin: Vec3,
  speed: number,
  target: Vec3,
  side: 0 | 1,
): { v: Vec3; err: number } | null => {
  const flat = vnorm([target[0] - from[0], 0, target[2] - from[2]]);
  for (const mult of AIM_SPEEDS) {
    const v0 = clamp(speed * mult, PADDLE.MIN_SPEED, PADDLE.MAX_SPEED);
    let best: { v: Vec3; err: number } | null = null;
    for (const deg of AIM_ANGLES) {
      const th = deg * DEG;
      const v = vmul(vadd(vmul(flat, Math.cos(th)), [0, Math.sin(th), 0]), v0);
      const r = firstLanding({ p: from, v, spin });
      if (r?.type !== 'bounce' || r.side !== side) continue;
      const err = Math.hypot(r.at[0] - target[0], r.at[2] - target[2]);
      if (!best || err < best.err) best = { v, err };
    }
    if (best) return best;
  }
  return null;
};

export const applySwing = (match: PpMatchState, player: 0 | 1, msg: PpSwing): PpMatchState => {
  // With the swing, so the wrong-wing rule actually bites here rather than only
  // wherever a caller happens to check first. It costs the bot a few swings a
  // match — it is not exempt, and it should not be: a bot that can return a
  // backhand with a forehand is not playing the game the player is.
  if (swingCheck(match, player, msg) !== null) return match;

  const d = dirOf(player);
  const { normal, v: vSwing } = swingVelocity(player, msg.q, msg.omega, msg.vsw ?? null);

  // Real contact: the same friction model the table uses, with the paddle as a
  // moving surface. Spin is no longer derived from face angle by a fudge — a
  // closed face brushing up the back of the ball generates topspin because that
  // is what friction does. The physics is the mechanic.
  const hit = contactImpulse(
    match.ball.v,
    match.ball.spin,
    normal,
    PADDLE.REST,
    PADDLE.MU,
    vSwing,
  );

  // How much of the stroke went ACROSS the ball, in the player's own terms: +1
  // means a full sweep to their right. This is the direction control.
  const steer = clamp((vSwing[0] * rightOf(player)) / STEER_REF, -1, 1);

  let out = hit.v;
  const speed = clamp(vlen(out), PADDLE.MIN_SPEED, PADDLE.MAX_SPEED);
  out = vmul(vnorm(out), speed);
  if (out[2] * d <= 0) out = [out[0], out[1], d * speed]; // never send it backwards
  out = [out[0] + steer * rightOf(player) * STEER_GAIN, out[1], out[2]];
  out = constrainShot(out, d);
  const spin = clampLen(vmul(hit.spin, PADDLE.SPIN_GAIN), MAX_SPIN);

  // --- generosity: the game meets the player more than halfway ---------------
  // Halfway, not all the way. Find the shot the player was probably going for,
  // blend toward it, and let however much of their error survives decide whether
  // it lands. A good swing needs no help; a wild one is still a miss.
  const opp: 0 | 1 = player === 0 ? 1 : 0;
  if (!lands(match.ball.p, out, spin, opp)) {
    // Aim where the stroke was going, nudged by timing.
    const bucket = placementBucket(match, player);
    const across = steer * rightOf(player) * STEER_AIM + bucket * 0.12;
    const target: Vec3 = [
      clamp(across, -TABLE.WIDTH / 2 + 0.1, TABLE.WIDTH / 2 - 0.1),
      TABLE.TOP,
      d * TABLE.LEN * 0.28,
    ];
    const rescue = Math.max(speed, PADDLE.RESCUE_SPEED);
    const aim =
      solveAim(match.ball.p, spin, rescue, target, opp) ??
      solveAim(match.ball.p, [0, 0, 0], rescue, target, opp);
    // NB: spin is deliberately not recomputed from the blended direction — the
    // solver verified this flight with this spin.
    if (aim) out = clampLen(vlerp(out, aim.v, ASSIST), PADDLE.MAX_SPEED);
  }

  return {
    ...match,
    phase: 'rally',
    ball: { p: match.ball.p, v: out, spin },
    lastHit: player,
    bouncesSinceHit: 0,
    rallyHits: match.rallyHits + 1,
    lastEvent: { type: 'hit', player, speed: vlen(out) },
  };
};

// --- rules ------------------------------------------------------------------

export const award = (match: PpMatchState, winner: 0 | 1, reason: string): PpMatchState => {
  const score = match.score.map((s, i) => (i === winner ? s + 1 : s)) as [number, number];
  const done = score[winner] >= WIN_SCORE && score[winner] - score[1 - winner] >= 2;
  const played = score[0] + score[1];
  return {
    ...match,
    score,
    phase: done ? 'over' : 'point',
    winner: done ? winner : null,
    server: (Math.floor(played / SERVE_ROTATION) % 2) as 0 | 1,
    lastEvent: { type: done ? 'gameover' : 'point', player: winner, reason },
  };
};

/** After a hit by P the ball must bounce exactly once, on P's opponent's side. */
const applyEvent = (match: PpMatchState, e: PpEvent): PpMatchState => {
  if (match.phase !== 'rally' || match.lastHit === null) return match;
  const p = match.lastHit;
  const opp: 0 | 1 = p === 0 ? 1 : 0;

  if (e.type === 'net') return award(match, opp, 'into the net');

  if (e.type === 'bounce') {
    if (match.bouncesSinceHit === 0) {
      // The real serve must bounce on the server's side first. Skipped — a serve
      // straight to the far side is legal here. Add it when someone complains.
      if (e.side === p) return award(match, opp, 'did not cross');
      return { ...match, bouncesSinceHit: 1 };
    }
    return award(match, p, 'double bounce');
  }

  if (e.type === 'floor') {
    return match.bouncesSinceHit === 0
      ? award(match, opp, 'missed the table')
      : award(match, p, 'not returned');
  }

  return match;
};

/**
 * A ball that touches the bat bounces off it, swing or no swing.
 *
 * Without this the paddle is a trigger rather than an object: the ball passes
 * straight through unless a swing happened to be detected at the right moment,
 * which is nothing like holding a bat in front of you. Here it is a real disc
 * with a real face, and the same contact model the table and the net use — so a
 * stationary bat deflects the ball weakly and mostly downward, a bat being
 * carried forward gives it something, and neither is guaranteed to be enough to
 * come back. That is the point: touching the ball is not the same as returning
 * it.
 *
 * Swept against the ball's path across the tick, not tested where it landed. At
 * 60 Hz a 3 m/s ball moves 50 mm per tick and the blade is 2 mm thick, so a
 * point test would let almost everything worth hitting pass straight through.
 *
 * Only for tracked paddles. An untracked one auto-positions onto the ball, so it
 * would be in contact every single tick.
 */
const paddleTouch = (
  match: PpMatchState,
  player: 0 | 1,
  from: Vec3,
): PpMatchState | null => {
  const h = handOf(match, player);
  const q = match.poses?.[player];
  if (!h || !q) return null;
  if (match.lastHit === player && match.bouncesSinceHit === 0) return null; // already theirs

  const pos = paddlePos(match, player);
  const face = paddleFrame(player, q).normal;
  const gap0 = vdot(vsub(from, pos), face); //          before the step
  const gap1 = vdot(vsub(match.ball.p, pos), face); //  after it
  const skin = BALL.R;

  // Crossed the plane this tick, or ended up resting against it.
  const crossed = gap0 > 0 !== gap1 > 0;
  if (!crossed && Math.abs(gap1) > skin) return null;

  // Where it met the plane, so a fast ball contacts the blade it actually passed
  // through rather than wherever it happened to finish.
  const span = gap0 - gap1;
  const t = crossed && Math.abs(span) > 1e-9 ? clamp(gap0 / span, 0, 1) : 1;
  const at = vlerp(from, match.ball.p, t);
  const rel = vsub(at, pos);
  const radial = vsub(rel, vmul(face, vdot(rel, face)));
  if (vlen(radial) > BLADE_R * BLADE_FORGIVENESS + BALL.R) return null; // missed the blade

  // the face the ball arrived on
  const n = gap0 >= 0 ? face : vmul(face, -1);
  const prev = match.paddlePrev?.[player];
  const vPaddle: Vec3 = prev ? vmul(vsub(pos, prev), 1 / TICK) : [0, 0, 0];
  if (vdot(vsub(match.ball.v, vPaddle), n) >= 0) return null; // already leaving

  const c = contactImpulse(match.ball.v, match.ball.spin, n, PADDLE.REST, PADDLE.MU, vPaddle);
  return {
    ...match,
    phase: 'rally',
    ball: {
      // lifted clear of the blade, or it contacts again on the next tick
      p: vadd(vadd(pos, vmul(n, BALL.R * 1.02)), radial),
      v: clampLen(c.v, PADDLE.MAX_SPEED),
      spin: clampLen(c.spin, MAX_SPIN),
    },
    lastHit: player,
    bouncesSinceHit: 0,
    rallyHits: match.rallyHits + 1,
    lastEvent: { type: 'hit', player, speed: vlen(c.v), touch: true },
  };
};

/** Advance the match one tick. */
export const tick = (match: PpMatchState): { match: PpMatchState; events: PpEvent[] } => {
  if (match.phase === 'point' || match.phase === 'over') return { match, events: [] };

  const { ball, events } = step(match.ball);
  let next: PpMatchState = { ...match, ball, lastEvent: null };

  // Contact before the rules see the step: a ball the bat just touched is no
  // longer heading where the step thought it was.
  //
  // Rally only. During the serve the ball is a toss nobody has struck yet, and
  // letting a bat shove it around meant a server who waved their phone over
  // their own toss batted it off across the table — with no hit registered,
  // because a touch is not a stroke. You serve by SWINGING; until then the ball
  // is not yours to nudge.
  if (next.phase === 'rally') {
    for (const p of [0, 1] as const) next = paddleTouch(next, p, match.ball.p) ?? next;
  }
  next = {
    ...next,
    paddlePrev: ([0, 1] as const).map((p) => (handOf(next, p) ? paddlePos(next, p) : null)),
  };

  // A serve toss nobody strikes bounces on the server's own side and is
  // re-tossed once it dies down. No penalty — take as long as you like.
  if (next.phase === 'serve') {
    const dead = events.some((e) => e.type === 'floor') || next.ball.p[1] < TABLE.TOP - 0.3;
    const settled = events.some((e) => e.type === 'bounce') && next.ball.v[1] < 1.2;
    const reToss = dead || settled;
    return {
      match: reToss ? { ...next, ball: serveBall(next.server) } : next,
      events,
    };
  }

  for (const e of events) {
    next = applyEvent(next, e);
    if (next.phase !== 'rally') break;
  }
  return { match: next, events };
};

export const restartPoint = (match: PpMatchState): PpMatchState => ({
  ...match,
  phase: 'serve',
  ball: serveBall(match.server),
  lastHit: null,
  bouncesSinceHit: 0,
  rallyHits: 0,
  lastEvent: null,
});
