import { rallyToSeven } from '../scoring.js';
import { BALL, NET, PADDLE, TABLE } from '../pingpong/constants.js';
import type { SportModule } from '../sport.js';
import { rallyEvents } from './rally-events.js';

/**
 * Table tennis. The one sport here that is not the shared simulation with
 * different numbers in it.
 *
 * The others — pickleball, badminton — are the same code path: players
 * auto-position onto the ball, a strike is a timing window against a predicted
 * contact, and the ball is a point with quadratic drag. That abstraction is
 * real and it holds for those two. It does not hold for this one, so this one
 * has its own engine in `../pingpong/`, and this module is mostly a description
 * of a sport that is simulated elsewhere.
 *
 * ── What is different, in one paragraph each ─────────────────────────────────
 *
 * The table is the real thing. 2.74 x 1.525 m, net at 15.25 cm, and no 2.6x
 * scale-up. The old table tennis here was scaled up by exactly that, for a
 * defensible reason: a real table on a 115 ms strike window is a coin flip. But
 * scaling only works while the player is auto-positioned onto the ball — the
 * moment you track a real bat position, a bigger table means you cannot reach,
 * and the trade stops paying. So the room is bought with gravity instead
 * (3.5 m/s^2, see `pingpong/constants.ts`), which lowers the speed a shot needs
 * to clear the net rather than moving the net further away.
 *
 * The ball has angular velocity and it matters. Magnus curve in flight, Coulomb
 * friction at every surface, and one contact model shared by the table, the net
 * and the bat — so a loop dips, a chop floats and sits up, a sidespin brush
 * bends the bounce, and none of those are special cases. `ball.spin` on the wire
 * is the scalar shadow of that; the vector never leaves the server.
 *
 * The bat is where you put it. Position comes from the phone's ORIENTATION,
 * across a 1.35 m span — not from integrating acceleration, which drifts — and
 * the ball meets a real disc with a real face. A ball down your backhand side
 * has to be played with a backhand. Touching it with a stationary bat deflects
 * it weakly and probably into the net, because touching the ball is not the same
 * as returning it.
 *
 * ── What this module still owns ──────────────────────────────────────────────
 *
 * The court and ball specs below are read by the display, `/api/sports`, and the
 * commentary persona. They are kept in step with the engine's own constants by
 * importing them rather than restating them — two copies of a table's width is
 * exactly the kind of drift that produces a ball landing visibly outside a line
 * the server thinks it is inside.
 *
 * `strike` is the awkward one. It is the shape of the ORIGINAL engine's tuning
 * and this sport's engine reads almost none of it, so most of these numbers are
 * descriptive rather than load-bearing: they keep `resolveParams` honest and
 * give the bot and the HUD sensible values to read. The two that do carry
 * weight are `paceMin`/`paceMax`, which the telegraph normalises difficulty
 * against.
 */
export const tabletennis: SportModule = {
  id: 'tabletennis',
  displayName: 'Table Tennis',
  rallyBased: true,
  playable: true,
  tagline: 'Real table, real spin. Put the bat on the ball.',

  court: {
    length: TABLE.LEN,
    width: TABLE.WIDTH,
    netHeight: NET.HEIGHT,
    nonVolleyZone: 0,
    surround: 2.4,
    tableHeight: TABLE.TOP,
    // You stand behind the table and reach over it. The engine's own `homeZ`
    // uses 0.25 m; this is what the display frames the camera against.
    standBehind: 0.25,
  },

  ball: {
    radius: BALL.R,
    restitution: 0.89,
    // Quadratic, and here it is a real 2.7 g ball on a real table rather than a
    // coefficient divided by a court scale.
    dragK: 0.09,
    // Not 1.0, and this is the whole trade: 3.5 / 9.81. See the note above.
    gravityScale: 3.5 / 9.81,
    friction: 0.75,
    bounces: true,
  },

  strike: {
    // Descriptive. This engine has no strike window — a swing is a contact with
    // a bat that has a position, and the timing test is whether the ball is in
    // the z band at all.
    windowMs: 115,
    aimToleranceDeg: 90,
    minReturn: PADDLE.MIN_SPEED,
    maxReturn: PADDLE.MAX_SPEED,
    // Where the ball is comfortable to meet, above the table.
    contactHeight: 0.25,
    // Load-bearing: the telegraph normalises difficulty against these.
    paceMin: PADDLE.MIN_SPEED,
    paceMax: PADDLE.MAX_SPEED,
    reachDepth: 1.1,
    reachHeight: 1.9,
    flightScale: 1,
  },

  serve: { underhandOnly: true, faults: 1, doubleBounceRule: false, mustClearKitchen: false },

  /**
   * Rally-to-7 is Rally's locked scoring decision, and this is the one sport
   * that does not use it: its engine scores the real game, 11 and win by 2, in
   * `award`. Left here because `SportModule` requires it and `/api/sports`
   * reports it — see `pingpong/constants.ts` WIN_SCORE for what actually runs.
   */
  scoring: rallyToSeven,

  persona: {
    energy: 0.95,
    snark: 0.6,
    jargon: ['the chop', 'a loop', 'the pips', 'service', 'counter-hit', 'the block', 'a let cord'],
    blurb:
      'Table tennis: the fastest ball game on earth, on a regulation table, ' +
      'with spin that actually bends the flight.',
  },

  classifyEvents: rallyEvents,
};
