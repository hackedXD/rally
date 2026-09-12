/**
 * The table tennis engine.
 *
 * Most of this file is `pickle`'s own self-checks, which shipped as
 * `console.assert` blocks at the bottom of each module and ran with
 * `node physics.js`. They are the specification of what was transplanted — if
 * the spin game, the quadrant hit model or the assist ever stop behaving the way
 * they do here, this is the sport that has quietly become a different one.
 */

import { describe, expect, it } from 'vitest';
import {
  PingPongMatch,
  emptyTickInput,
  getSport,
  pingpong as pp,
} from '@rally/sim';
import { newPpSwing, stepPpSwing, stepReach } from '@rally/motion';
import { vlen, type Quat, type Vec3 } from '@rally/protocol';
import { DT, finite, playMatch } from './helpers.js';

const { TABLE, NET, BALL, PADDLE, REST_TABLE, MU_TABLE, dirOf, homeZ, rightOf } = pp;

const runUntil = (
  ball: pp.PpBall,
  seconds: number,
  onEvent: (e: pp.PpEvent, b: pp.PpBall) => void = () => {},
  onTick: (b: pp.PpBall) => void = () => {},
): pp.PpBall => {
  let cur = ball;
  for (let i = 0; i < seconds / pp.TICK; i++) {
    const r = pp.step(cur);
    cur = r.ball;
    r.events.forEach((e) => onEvent(e, cur));
    onTick(cur);
  }
  return cur;
};

// ── Physics ───────────────────────────────────────────────────────────────────

describe('table tennis physics', () => {
  it('bounces off the table at exactly the restitution coefficient', () => {
    // Measured at the CONTACT rather than as a drop-height ratio. Drop height
    // depends on gravity and on how long drag had to act, so a ratio test fails
    // the moment gravity is tuned — it looks like the bounce has broken when only
    // the world has changed.
    const impact = 3.0;
    const reb = pp.contactImpulse([0, -impact, 0], [0, 0, 0], [0, 1, 0], REST_TABLE, MU_TABLE);
    expect(reb.v[1] / impact).toBeCloseTo(REST_TABLE, 9);
  });

  it('a ball dropped on the table still bounces visibly in this gravity', () => {
    const dropFrom = TABLE.TOP + 0.305;
    let bounced = false;
    let apex = 0;
    runUntil(
      pp.makeBall([0, dropFrom, -0.5], [0, 0, 0]),
      0.5,
      (e) => {
        if (e.type === 'bounce') bounced = true;
      },
      (b) => {
        if (bounced) apex = Math.max(apex, b.p[1] - TABLE.TOP - BALL.R);
      },
    );
    expect(bounced).toBe(true);
    const ratio = apex / 0.305;
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(0.95);
  });

  it('Magnus is the whole game: topspin dips, backspin floats', () => {
    const launch = (spin: Vec3): number =>
      runUntil(pp.makeBall([0, 1.0, -1.2], [0, 1.2, 6], spin), 0.3).p[1];
    const flat = launch([0, 0, 0]);
    const top = launch([90, 0, 0]); // +x spin on a +z ball is topspin
    const back = launch([-90, 0, 0]);
    expect(top).toBeLessThan(flat);
    expect(back).toBeGreaterThan(flat);
  });

  it('a ball driven into the net comes back rather than through', () => {
    let netted = false;
    const stopped = runUntil(
      pp.makeBall([0, TABLE.TOP + 0.04, -0.6], [0, 0, 7]),
      0.4,
      (e) => {
        if (e.type === 'net') netted = true;
      },
    );
    expect(netted).toBe(true);
    expect(stopped.p[2]).toBeLessThan(0);
  });

  it('a clean drive lands on the far side', () => {
    let farSide = false;
    // 3.5 m/s, not 5: a drive is relative to the world it is hit in, and at this
    // gravity a 5 m/s ball sails off the far end instead of landing on it.
    runUntil(pp.makeBall([0, TABLE.TOP + 0.35, -1.0], [0, 0.3, 3.5]), 1.5, (e) => {
      if (e.type === 'bounce' && e.side === 1) farSide = true;
    });
    expect(farSide).toBe(true);
  });

  it('a ball grazing the tape dribbles over instead of bouncing back', () => {
    let letcord = false;
    runUntil(pp.makeBall([0, TABLE.TOP + NET.HEIGHT + 0.004, -0.3], [0, 0.3, 5]), 0.6, (e) => {
      if (e.type === 'letcord') letcord = true;
    });
    expect(letcord).toBe(true);
  });

  it('drag is real: a 2.7 g ball sheds speed in flight', () => {
    const fast = runUntil(pp.makeBall([0, 1.2, -1.3], [0, 0, 12]), 0.25);
    expect(vlen(fast.v)).toBeLessThan(12);
  });
});

// ── Strokes ───────────────────────────────────────────────────────────────────

describe('table tennis strokes', () => {
  const pitchQ = (rad: number): Quat => [Math.sin(rad / 2), 0, 0, Math.cos(rad / 2)];
  /** Seat 0 swinging forward rotates about their phone's -x. */
  const FORWARD = (dps: number): Vec3 => [-dps, 0, 0];
  const atSeat0 = (): pp.PpMatchState => ({
    ...pp.newMatch(0),
    ball: pp.makeBall([0, TABLE.TOP + 0.25, -1.5], [0, 0, 0]),
  });
  const swing = (m: pp.PpMatchState, o: Partial<pp.PpSwing>): pp.PpMatchState =>
    pp.applySwing(m, 0, { q: [0, 0, 0, 1], omega: FORWARD(600), ...o });

  it('is reachable at your own end and not at the other', () => {
    const m = atSeat0();
    expect(pp.canHit(m, 0)).toBe(true);
    expect(pp.canHit(m, 1)).toBe(false);
  });

  it('a square forward swing drives the ball to the far side, speed clamped', () => {
    const hit = swing(atSeat0(), {});
    expect(hit.lastHit).toBe(0);
    expect(hit.ball.v[2]).toBeGreaterThan(0);
    expect(vlen(hit.ball.v)).toBeLessThanOrEqual(PADDLE.MAX_SPEED + 1e-6);
  });

  it('swinging harder hits harder, from the wrist and from the hand', () => {
    // A ratio, not a fixed margin in m/s: "one metre per second harder" meant
    // something when the ceiling was 14 m/s and means almost the whole range now.
    const soft = swing(atSeat0(), { omega: FORWARD(200) });
    const hard = swing(atSeat0(), { omega: FORWARD(900) });
    expect(vlen(hard.ball.v)).toBeGreaterThan(vlen(soft.ball.v) * 1.2);

    const push = swing(atSeat0(), { omega: FORWARD(300), vsw: [0, 0, -1.2] });
    const drive = swing(atSeat0(), { omega: FORWARD(300), vsw: [0, 0, -5.5] });
    expect(vlen(drive.ball.v)).toBeGreaterThan(vlen(push.ball.v) + 1);
  });

  it('sweeping across sends the ball across, and changes where it lands', () => {
    const across = (x: number): pp.PpMatchState =>
      swing(atSeat0(), { omega: FORWARD(300), vsw: [x, 0, -3.0] });
    const right = across(3.0);
    const left = across(-3.0);
    expect(Math.sign(right.ball.v[0])).toBe(-Math.sign(left.ball.v[0]));
    // and the player's right must be the world direction their own end calls right
    expect(Math.sign(right.ball.v[0])).toBe(rightOf(0));
    // ...by enough to place a shot, not a token nudge. 0.18 is about 10 degrees
    // off straight, which is the width of the far court from the baseline.
    expect(Math.abs(right.ball.v[0]) / vlen(right.ball.v)).toBeGreaterThan(0.18);

    const landOf = (m: pp.PpMatchState): number | null => {
      const r = pp.firstLanding(m.ball);
      return r?.type === 'bounce' ? r.at[0] : null;
    };
    const lr = landOf(right);
    const ll = landOf(left);
    expect(lr).not.toBeNull();
    expect(ll).not.toBeNull();
    expect(Math.abs(lr! - ll!)).toBeGreaterThan(0.3);
  });

  it('a pure wrist pivot cannot brush, so it generates no spin', () => {
    // Physics, not a bug: with a wrist pivot the face normal and the swing
    // velocity rotate together, so there is no tangential component at any face
    // angle. It is why the linear term exists.
    const pivot = swing(atSeat0(), { q: pitchQ(-0.4), omega: FORWARD(700) });
    expect(vlen(pivot.ball.spin)).toBeLessThan(1);
  });

  it('a loop loads topspin, a chop loads backspin, and the flight bends', () => {
    // Motion frame: +x the player's right, +y up, +z behind them.
    const LOOP: Vec3 = [0, 3.2, -2.4]; //  lift and drive: brushes UP the back
    const CHOP: Vec3 = [0, -3.2, -2.4]; // cut down the back of it
    const closed = swing(atSeat0(), { q: pitchQ(-0.4), omega: FORWARD(500), vsw: LOOP });
    const open = swing(atSeat0(), { q: pitchQ(0.25), omega: FORWARD(500), vsw: CHOP });
    expect(closed.ball.spin[0]).toBeGreaterThan(20);
    expect(open.ball.spin[0]).toBeLessThan(-20);

    // Launch both from the same velocity so this measures Magnus, not the assist
    // having picked two different trajectories.
    const bend = (spin: Vec3): number => {
      let b = pp.makeBall([0, 1.0, -1.2], [0, 1.2, 6], spin);
      for (let i = 0; i < 18; i++) b = pp.step(b).ball;
      return b.p[1];
    };
    expect(bend(closed.ball.spin)).toBeLessThan(bend(open.ball.spin));
  });

  it('you cannot loop a ball that is rising faster than your bat', () => {
    // Real table tennis, and it reads as a bug until you work it through: the
    // friction model acts on the CONTACT POINT's velocity, so if the ball is
    // climbing away faster than the face is rising, the contact drags up the
    // face rather than down it — and that is backspin, off a stroke that looks
    // like a loop. The bat's rise is the hand's times PADDLE.SWING_GAIN.
    const tossAt = (ballUp: number, handUp: number): number => {
      const m = {
        ...pp.newMatch(0),
        phase: 'serve' as const,
        ball: pp.makeBall([0, TABLE.TOP + 0.3, -pp.SERVE_TOSS_Z], [0, ballUp, 0]),
      };
      return pp.applySwing(m, 0, {
        q: [0, 0, 0, 1],
        omega: FORWARD(600),
        vsw: [0, handUp, -2.4],
      }).ball.spin[0];
    };
    // Toss climbing at 1.8; a hand at 2.4 moves the bat at 0.86 and loses.
    expect(tossAt(1.8, 2.4)).toBeLessThan(0);
    // Swing hard enough to outrun it and the same stroke is a loop again.
    expect(tossAt(1.8, 6.0)).toBeGreaterThan(0);
    // Once the toss is falling, even the soft one brushes up the back of it.
    expect(tossAt(-1.2, 2.4)).toBeGreaterThan(0);
  });

  it('a sideways brush generates sidespin', () => {
    const swept = swing(atSeat0(), { omega: FORWARD(500), vsw: [3.0, 0, -2.4] });
    expect(Math.abs(swept.ball.spin[1])).toBeGreaterThan(5);
  });

  it('both faces of the bat hit, and hit the same way', () => {
    // Turning the phone over is a half turn about its own long axis, which is
    // what turning it round in your hand IS. The same stroke must still go
    // forward, not backward.
    const flipped: Quat = [0, 1, 0, 0];
    for (const p of [0, 1] as const) {
      expect(Math.sign(pp.paddleFrame(p, [0, 0, 0, 1]).normal[2])).toBe(dirOf(p));
      expect(Math.sign(pp.paddleFrame(p, flipped).normal[2])).toBe(dirOf(p));
    }
    const front = swing(atSeat0(), {});
    const back = swing(atSeat0(), { q: flipped });
    expect(front.ball.v[2]).toBeGreaterThan(0);
    expect(back.ball.v[2]).toBeGreaterThan(0);
  });

  it('you cannot return your own shot, or one that has not bounced', () => {
    let m: pp.PpMatchState = { ...atSeat0(), phase: 'rally', bouncesSinceHit: 1 };
    m = pp.applySwing(m, 0, { q: [0, 0, 0, 1], omega: FORWARD(600) });
    expect(pp.swingCheck(m, 0)).toBe('already yours');
    expect(pp.swingCheck({ ...m, lastHit: 1, bouncesSinceHit: 0 }, 0)).toBe('let it bounce');
  });

  it('a ball down your backhand is not returned with a forehand', () => {
    // The quadrant model, which is what makes the two wings real. A stroke that
    // travels toward the ball's side of you is the wrong wing for it.
    const wide: pp.PpMatchState = {
      ...pp.newMatch(0),
      phase: 'rally',
      lastHit: 1,
      bouncesSinceHit: 1,
      ball: pp.makeBall([0.8 * rightOf(0), TABLE.TOP + 0.25, -1.5], [0, 0, -3]),
    };
    // Hand travelling to the player's right, toward a ball already on their right.
    expect(pp.strokeMatches(wide, 0, [2.0, 0, -2])).toBe(false);
    // Away from it: the correct wing.
    expect(pp.strokeMatches(wide, 0, [-2.0, 0, -2])).toBe(true);
    // Straight through belongs to neither wing and plays both sides.
    expect(pp.strokeMatches(wide, 0, [0, 0, -3])).toBe(true);
  });

  it('a bat waved over your own toss does not launch it — you serve by swinging', () => {
    // Regression: `paddleTouch` used to run in every phase, so a bat that
    // happened to be on the toss sent it down the table at 4 m/s with no hit
    // registered and no fault called. Reproducing it needs all three things a
    // real phone supplies and a default match does not: the blade ON the ball, a
    // face that is not square to a vertical toss, and a paddle that is MOVING.
    for (const p of [0, 1] as const) {
      const d = dirOf(p);
      const toss = pp.serveBall(p);
      const reach = (toss.p[2] - homeZ(p)) * d;
      let m = pp.setHand({ ...pp.newMatch(p), phase: 'serve', ball: toss }, p, {
        x: 0,
        y: toss.p[1],
        z: reach,
      });
      const tilt = 0.5;
      m = pp.setPose(m, p, [Math.sin(tilt / 2), 0, 0, Math.cos(tilt / 2)]);
      const at = pp.paddlePos(m, p);
      m = {
        ...m,
        paddlePrev: [0, 1].map((q) =>
          q === p ? ([at[0], at[1] - 0.05, at[2] - d * 0.05] as Vec3) : null,
        ),
      };
      expect(Math.abs(pp.tick(m).match.ball.v[2])).toBeLessThan(1e-6);
    }
  });
});

// ── The frame boundary ────────────────────────────────────────────────────────

describe('the player-frame conversion', () => {
  /**
   * This project's controller and the engine disagree about one axis, and the
   * symptom of getting it wrong is not "nothing works" — it is reaching right
   * moving the bat left while up and down stay perfectly correct, which reads as
   * bad tracking rather than as a sign. So it is asserted rather than played.
   */
  it('reaching right moves the bat to the player\'s right, at both ends', () => {
    for (const seat of [0, 1] as const) {
      // A pose in THIS project's frame: face normal tilted 30 degrees toward the
      // player's own right (+X), which is what reaching that way looks like.
      const half = (15 * Math.PI) / 180;
      const tilt: Quat = [0, Math.sin(half), 0, Math.cos(half)];
      const aim = pp.aimFromPose(seat, pp.toPpPose(tilt), pp.NEUTRAL, 0);
      expect(Math.sign(aim.x - pp.NEUTRAL[0])).toBe(rightOf(seat));
      // ...and the other way for the other wing.
      const back: Quat = [0, -Math.sin(half), 0, Math.cos(half)];
      const other = pp.aimFromPose(seat, pp.toPpPose(back), pp.NEUTRAL, 0);
      expect(Math.sign(other.x - pp.NEUTRAL[0])).toBe(-rightOf(seat));
    }
  });

  it('a forward swing sends the ball forward, from both ends', () => {
    // Angular velocity is a pseudovector — it picks up an extra sign under the
    // reflection that x and y do not. Swapping the two rules turns every drive
    // into a pull-back, which is what this catches.
    for (const seat of [0, 1] as const) {
      const m: pp.PpMatchState = {
        ...pp.newMatch(seat),
        phase: 'rally',
        lastHit: seat === 0 ? 1 : 0,
        bouncesSinceHit: 1,
        ball: pp.makeBall([0, TABLE.TOP + 0.25, dirOf(seat) * -1.5], [0, 0, 0]),
      };
      // In this project's frame the bat head swings toward the net when the
      // wrist turns about +X.
      const hit = pp.applySwing(m, seat, {
        q: pp.toPpPose([0, 0, 0, 1]),
        omega: pp.toPpOmega([600, 0, 0]),
        vsw: pp.toPpHandVel([0, 0.5, 3.0]),
      });
      expect(hit.lastHit).toBe(seat);
      expect(Math.sign(hit.ball.v[2])).toBe(dirOf(seat));
    }
  });

  it('a lifting stroke loads topspin and a cutting one backspin, in this frame', () => {
    const m = { ...pp.newMatch(0), ball: pp.makeBall([0, TABLE.TOP + 0.25, -1.5], [0, 0, 0]) };
    const closed: Quat = [Math.sin(-0.2), 0, 0, Math.cos(-0.2)];
    const open: Quat = [Math.sin(0.125), 0, 0, Math.cos(0.125)];
    // +Z is toward the net in this project's frame, so a stroke that goes
    // forward and UP is a loop.
    const loop = pp.applySwing(m, 0, {
      q: pp.toPpPose(closed),
      omega: pp.toPpOmega([500, 0, 0]),
      vsw: pp.toPpHandVel([0, 3.2, 2.4]),
    });
    const chop = pp.applySwing(m, 0, {
      q: pp.toPpPose(open),
      omega: pp.toPpOmega([500, 0, 0]),
      vsw: pp.toPpHandVel([0, -3.2, 2.4]),
    });
    expect(loop.ball.spin[0]).toBeGreaterThan(20);
    expect(chop.ball.spin[0]).toBeLessThan(-20);
  });
});

// ── The engine, as Rally runs it ──────────────────────────────────────────────

describe('the table tennis engine', () => {
  const play = (seed: number, seconds = 300): PingPongMatch => {
    const m = new PingPongMatch({
      sport: getSport('tabletennis'),
      seed,
      names: ['A', 'B'],
      bots: [true, true],
    });
    m.setBot(0, true, 0.55);
    m.setBot(1, true, 0.55);
    m.start(0);
    let t = 0;
    for (let i = 0; i < seconds * 60 && m.phase !== 'gameover'; i++) {
      t += 1000 / 60;
      m.step(DT, emptyTickInput(t));
      m.drainEvents();
    }
    return m;
  };

  it('plays a full match to 11, win by 2', () => {
    const m = play(7);
    expect(m.phase).toBe('gameover');
    const [a, b] = m.getScore().points;
    const hi = Math.max(a, b);
    expect(hi).toBeGreaterThanOrEqual(pp.WIN_SCORE);
    expect(hi - Math.min(a, b)).toBeGreaterThanOrEqual(2);
    expect(m.getWinner()).toBe(a > b ? 0 : 1);
  });

  it('never produces a NaN, a stuck ball, or one through the floor', () => {
    const { match, snapshots } = playMatch({
      sport: 'tabletennis',
      seed: 4242,
      skill: 0.6,
      maxSeconds: 400,
      collectSnapshots: true,
    });
    expect(match.phase).toBe('gameover');
    expect(snapshots.length).toBeGreaterThan(600);
    for (const s of snapshots) {
      expect(s.ball).not.toBeNull();
      expect(finite([...s.ball!.p, ...s.ball!.v])).toBe(true);
      // The floor bounce keeps a dead ball above zero; anything below is a
      // tunnel through it.
      expect(s.ball!.p[1]).toBeGreaterThan(-0.5);
      expect(Math.abs(s.ball!.p[2])).toBeLessThan(TABLE.LEN / 2 + 8);
      for (const p of s.players) expect(finite([...p.p, ...p.paddleQ])).toBe(true);
    }
  });

  it('emits the events the commentator is built on', () => {
    const { events } = playMatch({ sport: 'tabletennis', seed: 99, maxSeconds: 400 });
    const kinds = new Set(events.map((e) => e.type));
    for (const t of ['match_start', 'serve', 'hit', 'point', 'match_end'] as const) {
      expect(kinds).toContain(t);
    }
    // Every point must say why it ended — a commentator with no reason has
    // nothing to say about it.
    for (const e of events.filter((e) => e.type === 'point')) {
      expect(String(e.data.reason).length).toBeGreaterThan(0);
    }
  });

  it('draws the bat where the sim says it is, and holds it still mid-stroke', () => {
    const m = new PingPongMatch({
      sport: getSport('tabletennis'),
      seed: 3,
      names: ['A', 'B'],
    });
    m.start(0);
    // A pose tilted off-axis, so the aim resolves somewhere other than neutral.
    const q: Quat = [0.2, 0.1, 0, Math.sqrt(1 - 0.05)];
    let t = 0;
    const step = (hold: boolean): void => {
      t += 1000 / 60;
      m.step(DT, { ...emptyTickInput(t), pose: { 0: q }, holdPose: { 0: hold } });
    };
    for (let i = 0; i < 90; i++) step(false);
    const settled = m.currentSnapshot().players[0].p;
    expect(settled[0]).not.toBeCloseTo(0, 2);

    // Mid-stroke the position freezes; the pose stays live so the shot is
    // unaffected. Without this a swing drags the bat across the table, in
    // opposite directions on a forehand and a backhand.
    for (let i = 0; i < 30; i++) {
      t += 1000 / 60;
      m.step(DT, {
        ...emptyTickInput(t),
        pose: { 0: [0, 0, 0, 1] as Quat },
        holdPose: { 0: true },
      });
    }
    expect(m.currentSnapshot().players[0].p).toEqual(settled);
  });

  it('serves for a player who never does, so a match cannot wedge', () => {
    // The transplanted rules re-toss forever and charge nothing for it, which is
    // right for one laptop in one room and wrong for a hosted one: a seat whose
    // player put their phone down would hold a match open until the idle reaper
    // got to it. Two human seats, neither ever swinging.
    const m = new PingPongMatch({
      sport: getSport('tabletennis'),
      seed: 8,
      names: ['A', 'B'],
    });
    m.start(0);
    let t = 0;
    // Deliberately the worst case, and it is a long one: every point costs the
    // full auto-serve wait AND a commentary hold that never stops asking for
    // more, so a match of them runs about eight simulated minutes. What is
    // asserted is not that it is quick — it is that it ENDS.
    for (let i = 0; i < 60 * 900 && m.phase !== 'gameover'; i++) {
      t += 1000 / 60;
      // A pose, so the seats are tracked — the wedge only exists for a seat the
      // sim is NOT auto-positioning.
      m.step(DT, {
        ...emptyTickInput(t),
        pose: { 0: [0, 0, 0, 1] as Quat, 1: [0, 0, 0, 1] as Quat },
        // ...and the commentator talking must not defer it indefinitely. A hold
        // is a request to wait; this is what guarantees the match ends anyway.
        holdUntil: t + 5000,
      });
      m.drainEvents();
    }
    expect(m.phase).toBe('gameover');
    expect(Math.max(...m.getScore().points)).toBeGreaterThanOrEqual(pp.WIN_SCORE);
  });

  it('animates a stroke, so a contact is something you can see', () => {
    // The display drives its procedural swing off this. A contact that never
    // sets it is one the player watches happen with a completely still bat —
    // which reads as the hit not having registered.
    const { snapshots } = playMatch({
      sport: 'tabletennis',
      seed: 11,
      maxSeconds: 400,
      collectSnapshots: true,
    });
    const anims = new Set(snapshots.flatMap((s) => s.players.map((p) => p.anim)));
    expect(anims).toContain('swing');
    expect(anims).toContain('celebrate');
    expect(anims).toContain('idle');
    // ...and it must end. An animation that never expires is a bat stuck
    // mid-follow-through for the rest of the match.
    const last = snapshots.at(-1)!;
    expect(last.players.every((p) => p.anim !== 'swing')).toBe(true);
  });

  it('leaves the other sports on the original engine', () => {
    // The whole reason the seam exists. If this ever flips, pickleball has
    // silently acquired spin and a bat position.
    const pb = playMatch({ sport: 'pickleball', seed: 5, maxSeconds: 400 });
    expect(pb.match.drivesOwnBots).toBe(false);
    const tt = playMatch({ sport: 'tabletennis', seed: 5, maxSeconds: 400 });
    expect(tt.match.drivesOwnBots).toBe(true);
  });
});

// ── The phone ─────────────────────────────────────────────────────────────────

describe('table tennis swing detection', () => {
  const feed = (
    samples: { t: number; dps: number; handSpeed?: number; sample?: string }[],
  ): string[] => {
    let s = newPpSwing<string>();
    const out: string[] = [];
    for (const x of samples) {
      const [next, fired] = stepPpSwing(s, x);
      s = next;
      if (fired) out.push(fired);
    }
    return out;
  };
  const ramp = (
    t0: number,
    vals: number[],
    handSpeed = 0,
  ): { t: number; dps: number; handSpeed: number; sample: string }[] =>
    vals.map((dps, i) => ({ t: t0 + i * 16, dps, handSpeed, sample: `t${t0 + i * 16}` }));

  it('fires once per stroke, reporting the sample from PEAK rate', () => {
    // Firing on the last sample instead would hand the server a pose from the
    // end of the follow-through.
    const fired = feed(ramp(0, [0, 300, 700, 900, 600, 200, 60, 40, 30, 20, 10]));
    expect(fired).toEqual(['t48']);
  });

  it('a twitch past the arm threshold is still not a swing', () => {
    expect(feed(ramp(0, [0, 260, 285, 270, 90, 40, 20, 10, 5]))).toHaveLength(0);
    // ...unless the hand actually travelled, which is a real push stroke.
    expect(feed(ramp(0, [0, 260, 285, 270, 90, 40, 20, 10, 5], 1.4))).toHaveLength(1);
  });

  it('a dip mid-stroke does not end it early', () => {
    const fired = feed(ramp(0, [0, 600, 900, 100, 800, 1200, 700, 200, 60, 30, 20, 10, 8, 6, 4]));
    expect(fired).toEqual(['t80']);
  });

  it('a swing that never settles times out rather than arming forever', () => {
    const fired = feed(ramp(0, [0, ...Array.from({ length: 80 }, () => 900)]));
    // Continuous shaking SHOULD keep producing strokes. What must not happen is
    // arming once and never firing again.
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired.length).toBeLessThan(12);
  });

  it('the follow-through is not a second shot', () => {
    const fired = feed(
      ramp(0, [0, 900, 1100, 200, 40, 30, 20, 10, 5, 800, 900, 200, 40, 30, 20, 10, 5]),
    );
    expect(fired).toHaveLength(1);
  });

  it('the forward lean springs back to neutral and cannot drift across a rally', () => {
    // The one axis this project integrates acceleration on, and the spring is
    // the entire reason that is survivable.
    let lean = { reach: 0, vel: 0 };
    for (let i = 0; i < 20; i++) lean = stepReach(lean, 3.0, 3.0, 400, 1 / 60);
    expect(lean.reach).toBeGreaterThan(0.02);
    expect(lean.reach).toBeLessThanOrEqual(0.4);
    // Hand parks: a hard spring pulls it back within a second.
    for (let i = 0; i < 120; i++) lean = stepReach(lean, 0, 0, 0, 1 / 60);
    expect(Math.abs(lean.reach)).toBeLessThan(0.01);
  });
});
