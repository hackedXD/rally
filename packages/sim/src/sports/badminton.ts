import { rallyToSeven } from '../scoring.js';
import type { SportModule } from '../sport.js';
import { rallyEvents } from './rally-events.js';

/**
 * The third sport, and the first one that is not just pickleball with different
 * numbers. Two things here are genuinely new, and both are visible in a rally.
 *
 * ── The shuttle does not bounce ──────────────────────────────────────────────
 *
 * `ball.bounces: false`. Everywhere else, the ball may land once and be returned
 * — the whole groundstroke half of the contact model exists for that. Here the
 * first thing the shuttle touches ends the rally, in or out. It makes badminton
 * the most unforgiving sport in the game: there is no second chance on a deep
 * clear, and a drop that beats you is simply over.
 *
 * ── The shuttle is met above the head ────────────────────────────────────────
 *
 * `contactHeight` 2.45 m against pickleball's 0.78, and `reachHeight` 3.0 so a
 * stretched overhead is still legal rather than sailing past a player who was
 * never allowed to reach for it. About three quarters of contacts end up above
 * the net, which is what makes the smash the default attacking shot rather than
 * a rare one: `classifyShot` calls a smash when the ball is high, fast and
 * struck flat or downward, and here it usually is.
 *
 * Getting there took more than the one number. `idealNormal` used to ask for a
 * fixed upward slope on every shot — correct for the two sports whose contact is
 * below their net, and wrong for a smash, which scored a perfectly struck
 * overhead as badly aimed and handed it to the assistance to rescue. And a flat
 * trajectory never rises to overhead height on the far side at all, so
 * `flightScale` had to go up to put something up there worth hitting.
 *
 * ── Drag is the whole personality ────────────────────────────────────────────
 *
 * A shuttlecock's terminal velocity is about 6.7 m/s, which is `dragK = g/6.7²
 * = 0.22`. That is the real number and it is unplayable here — see the note on
 * the field. What ships is 0.14, still three and a half times a pickleball's,
 * which keeps the shape everyone recognises: a smash that leaves at 40 m/s and
 * arrives at something returnable, and a clear that climbs, stalls and drops.
 * It is also why `maxReturn` can be 40 without the shuttle leaving the building.
 *
 * The court is the real thing: 13.4 x 5.18 m singles, net at 1.524 m — nearly
 * twice pickleball's over a court of the same length. In a rally that net sits
 * below the contact point and is easy; off a serve struck from below the waist
 * it is the hardest constraint in the sport, which is exactly right.
 *
 * ── What ends a rally ────────────────────────────────────────────────────────
 *
 * About sixty percent `grounded` — the shuttle landing in, because the receiver
 * could not get to it — and most of the rest in the net, which is a high one to
 * clear from a contact point that is often below it by the time you reach the
 * shuttle. `grounded` is this sport's version of pickleball's double bounce.
 *
 * Measured at bot skill 0.55: 9.7 shots a rally over a 107-second match, against
 * pickleball's 8.5 / 215 s and table tennis's 5.6 / 99 s. The longest rallies of
 * the three and the shortest matches, which is a fair description of badminton.
 * Deliberately on the generous side — the strike window and aim tolerance are
 * both wider than they were, because a shuttle met anywhere between the ankles
 * and full stretch overhead needs more latitude than a ball on a table, and a
 * tight window there reads as overheads that simply do not register.
 */
export const badminton: SportModule = {
  id: 'badminton',
  displayName: 'Badminton',
  rallyBased: true,
  playable: true,
  tagline: 'Overhead, no bounce. The shuttle decides everything.',

  court: {
    // Regulation singles. Doubles is 6.1 m wide; singles is the fairer 1v1.
    length: 13.4,
    width: 5.18,
    // 1.524 m at the centre. Roughly twice a pickleball net, over a court of the
    // same length.
    netHeight: 1.524,
    // Not a kitchen — the short service line. Reused for `mustClearKitchen`,
    // which is exactly the rule it needs to express: a serve landing short of
    // this line is a fault. Nothing forbids playing inside it during a rally.
    nonVolleyZone: 1.98,
    surround: 3.0,
    tableHeight: 0,
    standBehind: 0,
  },

  ball: {
    // A shuttle is not a sphere, but it is drawn as one and 32 mm across the cork
    // is about right to see from the broadcast camera.
    radius: 0.034,
    // It does not bounce, so this only decides how dead it looks on landing.
    restitution: 0.06,
    // Real shuttle drag is g / (6.7 m/s)² = 0.22, and it is unplayable here: at
    // 0.22 a serve struck from below the waist is down to walking pace long
    // before it reaches a 1.5 m net, and every rally in a 300-second match ends
    // in the tape. 0.14 is the highest value that still clears — three and a half
    // times a pickleball's, so the flight keeps the stall-and-drop shape that
    // makes a clear read as a clear, without making the court impassable. Table
    // tennis had to make the same trade in the opposite direction.
    dragK: 0.14,
    gravityScale: 1.0,
    friction: 0.4,
    bounces: false,
  },

  strike: {
    // Not the tightest of the three, despite this being the fastest racket sport.
    // A shuttle is met over a much wider band of heights than a ball on a table
    // is, often at full stretch, and a narrow window on top of that reads as
    // overheads simply not registering. Leniency belongs here.
    windowMs: 125,
    // Likewise generous. The face angle on an overhead is nothing like the one on
    // a drive, and a phone held above the head reports a pose that is honestly a
    // bit approximate.
    aimToleranceDeg: 75,
    // The widest range in the game, and the reason a racket sport reads
    // differently from a paddle one: a net shot barely leaves the strings, a
    // smash is the fastest shot in this or any other sport here.
    minReturn: 4,
    maxReturn: 40,
    // Overhead — above the head, not merely above the net, and this is the single
    // number that decides whether the sport plays like badminton.
    //
    // `contactHeight` is the height the receiver TRIES to meet the shuttle at, so
    // it is what the contact search aims for. At 1.95 (just over the tape) the
    // search produced zero contacts above shoulder height across a whole match:
    // every shuttle was met at chest height or scraped off the floor, and an
    // overhead swing had nothing to connect with. At 2.45 a little over half of
    // all contacts are genuine overheads.
    contactHeight: 2.45,
    // Arrival speeds, measured rather than guessed: shuttles reach the receiver
    // at a median of about 9 m/s here, so the band is set around that. Calibrate
    // against arrival, never launch — a smash leaves at four times the speed it
    // lands at, and normalising on the launch pins difficulty near zero.
    paceMin: 3.5,
    paceMax: 11.0,
    reachDepth: 1.8,
    // Headroom above the contact height, so a stretched overhead is still legal.
    reachHeight: 3.0,
    // Floatier than the other two, and load-bearing rather than decorative: a
    // flat trajectory never rises to overhead height on the receiver's side, so
    // without the extra arc there is nothing up there to hit. Clears that climb,
    // stall and drop are also simply what the sport looks like.
    flightScale: 1.35,
  },

  // Underhand and below the waist, and it must carry past the short service
  // line. No double-bounce rule, because there are no bounces to have.
  serve: { underhandOnly: true, faults: 1, doubleBounceRule: false, mustClearKitchen: true },

  scoring: rallyToSeven,

  persona: {
    energy: 0.9,
    snark: 0.55,
    jargon: ['the clear', 'a drop', 'the smash', 'net kill', 'the tramlines', 'flick serve'],
    blurb:
      'Badminton: the fastest racket sport there is, played with the least ' +
      'aerodynamic object anyone has ever agreed to hit.',
  },

  classifyEvents: rallyEvents,
};
