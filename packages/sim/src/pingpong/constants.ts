/**
 * Table tennis constants, transplanted from the `pickle` project.
 *
 * These are NOT the numbers the rest of Rally plays by, and that is the point.
 * Every other sport here is the same simulation with different values in its
 * `SportModule`: players auto-position, a strike is a timing window, and the
 * ball is a point with drag. Table tennis is now a different simulation
 * underneath — real table, real spin, a bat with a position you have to put on
 * the ball — so its constants live with that simulation rather than in a sport
 * module that could not express half of them.
 *
 * World is right-handed, metres, and matches Rally's:
 *   x = across the table   y = up (0 is the floor)   z = along the table
 * Net at z = 0. Seat 0 stands at -z, seat 1 at +z.
 */

/** Regulation. Not scaled up — see GRAVITY for how the room is bought instead. */
export const TABLE = { LEN: 2.74, WIDTH: 1.525, TOP: 0.76 } as const;
export const NET = { HEIGHT: 0.1525, OVERHANG: 0.1525 } as const;
export const BALL = { R: 0.02, MASS: 0.0027 } as const;

/**
 * Deliberately not 9.81. This is the knob that buys hang time.
 *
 * Rally's other sports play at 0.35-1.13 court lengths per second; on a real
 * 2.74 m table under real gravity we cannot get near that, because a shot
 * slower than ~5 m/s simply cannot clear the net — floor and ceiling converge
 * until there is no power range left and the ball stops being hittable.
 *
 * The old table tennis bought the room by scaling its court up 2.6x. That does
 * NOT work here: it could only do it because its players auto-position. This
 * one tracks a real bat position, so a bigger table just means you cannot
 * reach. Lower gravity is our version of the same trade — it lowers the speed a
 * shot needs to cross, which is what actually sets the floor.
 *
 * REST_TABLE is unaffected: restitution is measured at the contact rather than
 * as a drop height, precisely so this stays tunable.
 */
export const GRAVITY: readonly [number, number, number] = [0, -3.5, 0];
export const TICK = 1 / 60;

// --- tuning knobs -----------------------------------------------------------
// Every value below is tuned by eye, not derived. A real ball is not an ideal
// sphere and a phone is not a paddle. Twist these until it reads right.

export const DRAG = 0.09; //         quadratic. a 2.7 g ball decelerates visibly
export const MAGNUS = 0.0021; //     spin curve. this is the game, do not zero it
export const SPIN_DECAY = 0.4; //    per second
export const REST_TABLE = 0.89; //   ITTF: 30.5 cm drop -> 24-26 cm bounce
export const REST_NET = 0.3;
/**
 * Coulomb friction at each surface. These are the whole spin game: topspin
 * kicking forward, backspin skidding and sitting up, sidespin bending the
 * bounce are all one friction model, not three special cases.
 */
export const MU_TABLE = 0.25;
export const MU_NET = 0.4;

export const PADDLE = {
  REST: 0.85,
  MU: 0.95, //           rubber is grippy — this is where spin comes from
  /**
   * How much spin a brush across the ball is worth, on top of the friction
   * model. The flight already bends hard for a given spin — 200 rad/s of
   * sidespin moves the bounce 30 cm across — but a stroke was only generating
   * about 100, so the spin game existed and could not be reached. This is the
   * dial that puts it in the player's hands, and it multiplies ONLY paddle
   * contact: the table and the net keep their real friction.
   */
  SPIN_GAIN: 4.5,
  ARM: 0.4, //           metres wrist->phone. a constant, not a measurement
  /**
   * A rally you can actually see. Real smashes are 25+ m/s and cross the table
   * in 0.11 s, which on a phone is not a game. These are deliberately slow.
   */
  MAX_SPEED: 5.6,
  /**
   * Low on purpose: this is the floor that decides whether a gentle push STAYS
   * gentle. At 5.0 every shot came off the bat at the same speed and the swing
   * stopped mattering. A soft shot that cannot cross the net is a soft shot
   * that should not have crossed the net.
   */
  MIN_SPEED: 1.4,
  SWING_GAIN: 0.36,
  /**
   * The slowest shot the RESCUE is allowed to consider. Not the same thing as
   * MIN_SPEED: that is the floor on what the player actually hit, and it is low
   * so a gentle push stays gentle. This is the floor on what the assist may aim
   * WITH, and it has to be a speed that can physically reach the far side — a
   * shot too soft to make the net cannot be aimed out of trouble, only hit
   * harder. Tying the two together made every weak swing unrescuable.
   */
  RESCUE_SPEED: 3.0,
} as const;

// --- how far the paddle covers ----------------------------------------------
// A real blade is ~0.15 m wide; this is the game's version of that, forgiving
// on purpose. QUAD and STROKE_MIN are what actually decide a hit.
export const REACH = { X: 0.34, Y: 0.34, Z: 1.3 } as const;

/**
 * Where a player's own right points in world x.
 *
 * Seat 0 stands at -z facing +z, so right = forward x up = z_hat x y_hat =
 * -x_hat. Seat 1 faces the other way and is the mirror of that.
 *
 * Every lateral input goes through this. Get it wrong and the paddle moves the
 * opposite way to your hand.
 */
export const rightOf = (player: number): 1 | -1 => (player === 0 ? -1 : 1);

/**
 * The hit model: QUADRANT, not position.
 *
 * You do not have to put a 15 cm disc on the ball — you have to play the right
 * shot on the right side. A ball coming to your backhand is returned by a
 * backhand: the paddle has to be on that side of you, and past that the game
 * does not care how close you got.
 *
 * This is what makes forehand and backhand real rather than accidental, and it
 * is handedness-agnostic by construction: it asks which side of YOU the ball is
 * on, which is the same question for a left-hander and a right-hander. A box
 * asking "how many centimetres away" fails in opposite directions for the two.
 *
 * The deadband is the important half. A ball down the middle belongs to no
 * quadrant, so either side plays it — without that, the centre line is a coin
 * flip and the fairest ball in the game becomes the least playable.
 */
export const QUAD = {
  X: 0.2, //  metres either side of centre that count as "down the middle"
} as const;

/**
 * Lateral hand speed, m/s, below which a stroke is "straight through" and
 * belongs to neither wing. A drive down the line is a forehand OR a backhand.
 */
export const STROKE_MIN = 0.55;

// --- aim: where the paddle sits ---------------------------------------------
// Position comes from ORIENTATION, not from integrating acceleration. Double
// integration is mushy by construction (you accelerate, then velocity builds,
// then position moves) and needs a leak to stop drifting, which eats the real
// movement too. Orientation is instant, drift-free against gravity, and it is
// what a real player's forearm actually does when they reach.
export const AIM = {
  SPAN_X: 1.35, //  metres of paddle travel per unit of sideways aim
  SPAN_Y: 1.05,
  /**
   * Heavily damped on purpose. Position is the SLOW part of the orientation —
   * where you have settled your wrist — and rotation is the fast part, which is
   * the stroke. At 0.55 the fast part leaked straight into position and the
   * paddle wandered whenever the wrist turned.
   */
  SMOOTH: 0.18,
  /**
   * ...but only for SMALL corrections, which is all that reasoning covers.
   *
   * Flat 0.18 takes ~195 ms to close 90% of a gap however big the gap is, and
   * changing wings is the biggest gap there is: the hand crosses the body, up
   * to the whole 1.35 m span. That wait is the lag between switching from
   * forehand to backhand and the bat arriving.
   *
   * So ease on the SIZE of the move. Wrist wobble leaking out of a rotation is
   * small and stays damped; a deliberate move across the table is large,
   * obviously intended, and tracks at FAST. Same knob, now a curve: at 0 error
   * it is exactly SMOOTH, so nothing about the quiet case has changed.
   */
  FAST: 0.6,
  FULL: 0.45, //  metres of error at which FAST is reached
} as const;

// --- depth: reaching forward and back ---------------------------------------
// The one axis orientation cannot supply. Tilting your wrist says nothing about
// how far forward your hand is, so this is the exception to "never integrate
// acceleration" — and it is only survivable because it is a LEAN, not a
// position: it is sprung back to the ready position constantly, hard once the
// hand stops, so error cannot outlive a rally.
export const REACH_Z = 0.4; //        metres of forward travel at full stretch
export const BLADE_R = 0.077; //      ITTF blades are ~15 cm across
/**
 * The ball meets a slightly bigger disc than the one you can see. Enough that a
 * contact which LOOKS like it clipped the edge does connect, not so much that
 * the ball visibly bounces off thin air. Kept as a multiple of the drawn blade
 * so the two cannot drift apart.
 */
export const BLADE_FORGIVENESS = 1.35;

// --- Wii-style generosity ---------------------------------------------------
// The game meets the player more than halfway. Widen first, tighten only if
// hitting feels trivial.

/**
 * The difficulty dial. Every swing is blended this far toward a shot that would
 * land: 0 = pure simulation and nobody can rally, 1 = every swing lands and
 * nobody can ever win a point. The player's error survives in proportion, so
 * this is a smooth skill gradient rather than a pass/fail gate.
 *
 * 0.88, not 0.93. At 0.93 the assist rewrote the shot almost entirely — a full
 * cross-court sweep came off the bat at -1.94 m/s sideways and was flattened to
 * -0.77 on the way out, so the contact you could see was not the contact you
 * got. This leaves more of the real surface in the result while keeping long
 * rallies reachable.
 */
export const ASSIST = 0.88;

/**
 * Generous, but not absurd: you cannot reach a ball 3 m behind the table at
 * ankle height, and pretending you can just hands the solver an impossible shot.
 */
export const HIT_ZONE = { NEAR: 0.3, FAR: 1.1, MIN_Y: 0.45, MAX_Y: 1.9 } as const;

export const PLACEMENT_BUCKETS = 2; //   +/- this many, quantized. noisy wrists
export const PLACEMENT_SPREAD = 0.22; // metres of contact-point error per bucket

/**
 * Sweeping across the ball is physically mostly sidespin, not sideways speed, so
 * pure contact mechanics makes lateral aim almost unusable. These steer the shot
 * with the stroke, which is what a player expects from moving their hand that
 * way — and what the real game gets from face angle we cannot see.
 *
 * 1.5, not 3.0: a full sweep is measured against the hand speeds this game
 * actually produces, and those halved when the ball slowed down.
 */
export const STEER_REF = 1.5; //   m/s of cross-swing counted as "full"
export const STEER_GAIN = 4.2; //  m/s of sideways ball speed at full sweep
export const STEER_AIM = 0.9; //   how far across the far half full sweep aims

export const SERVE_TOSS_V = 1.8;
export const WIN_SCORE = 11;
export const SERVE_ROTATION = 2; //  serve changes every N points

/** +1 if this player hits toward +z. Seat 0 stands at -z. */
export const dirOf = (player: number): 1 | -1 => (player === 0 ? 1 : -1);

/** Where a player's paddle lives, for rendering and serve tosses. */
export const homeZ = (player: number): number =>
  dirOf(player) * -(TABLE.LEN / 2 + 0.25);

export const onTableFootprint = (p: readonly number[]): boolean =>
  Math.abs(p[0]) <= TABLE.WIDTH / 2 && Math.abs(p[2]) <= TABLE.LEN / 2;
