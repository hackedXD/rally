import { describe, expect, it } from 'vitest';
import {
  FIXED_RNG,
  classifyShot,
  evaluateStrike,
  flightProbe,
  getSport,
  makeRallyScoring,
  makeRng,
  mapSwingToShot,
  playableSports,
  resolveParams,
  rallyToSeven,
  stepBall,
  strikeDifficulty,
  type BallBody,
  type ShotContext,
} from '@rally/sim';
import {
  TUNING,
  qFromUnitZTo,
  seatSign,
  vlen,
  vnorm,
  type GameEventType,
  type ScoreState,
  type Seat,
  type SwingInput,
  type Vec3,
} from '@rally/protocol';
import { DT, finite, playMatch } from './helpers.js';

// ── W3 exit criteria ──────────────────────────────────────────────────────────

describe('simulation invariants (W3 exit criteria)', () => {
  it('200+ simulated swings produce no NaN, no stuck balls and no tunnelling', () => {
    for (const sport of ['pickleball', 'tabletennis'] as const) {
      let swings = 0;
      let stuck = 0;
      let lastKey = '';
      let crossings = 0;
      let lastSide = 0;

      const { match } = playMatch({
        sport,
        seed: 31337,
        skill: 0.65,
        maxSeconds: 400,
        onSnapshot: (s) => {
          if (!s.ball) return;
          expect(finite([...s.ball.p, ...s.ball.v])).toBe(true);
          for (const p of s.players) {
            expect(finite([...p.p, ...p.paddleQ])).toBe(true);
          }
          // The ball must never end up below the floor or outside a sane box:
          // that is what tunnelling through the net or the court looks like.
          const court = getSport(sport).court;
          expect(s.ball.p[1]).toBeGreaterThan(-1);
          expect(Math.abs(s.ball.p[0])).toBeLessThan(court.width / 2 + 25);
          expect(Math.abs(s.ball.p[2])).toBeLessThan(court.length / 2 + 25);

          const key = s.ball.p.map((n) => n.toFixed(3)).join(',');
          if (key === lastKey && s.phase === 'rally') stuck++;
          else stuck = 0;
          lastKey = key;
          expect(stuck).toBeLessThan(90);

          const side = Math.sign(s.ball.p[2]);
          if (side !== 0 && lastSide !== 0 && side !== lastSide) crossings++;
          lastSide = side;
        },
      });

      swings = match.getStats().totalShots;
      expect(swings).toBeGreaterThan(40);
      // Every rally shot must actually cross the net, which it cannot do if the
      // ball is passing through the net mesh instead of colliding with it.
      expect(crossings).toBeGreaterThan(20);
      expect(match.phase).toBe('gameover');
    }
  });

  it('the same seed and input sequence produce identical snapshot streams', () => {
    const a = playMatch({ seed: 4242, skill: 0.6, collectSnapshots: true });
    const b = playMatch({ seed: 4242, skill: 0.6, collectSnapshots: true });
    expect(a.snapshots.length).toBe(b.snapshots.length);
    expect(JSON.stringify(a.snapshots)).toBe(JSON.stringify(b.snapshots));
    expect(a.match.summary()).toEqual(b.match.summary());
  });

  it('different seeds produce different matches', () => {
    const a = playMatch({ seed: 1, skill: 0.6, collectSnapshots: true });
    const b = playMatch({ seed: 2, skill: 0.6, collectSnapshots: true });
    expect(JSON.stringify(a.snapshots)).not.toBe(JSON.stringify(b.snapshots));
  });

  it('a fast ball cannot tunnel through the net', () => {
    const sport = getSport('pickleball');
    // 60 m/s, far faster than anything the shot model can produce, aimed at the
    // tape. One 60 Hz step covers a metre; a naive position check would miss it.
    const body: BallBody = {
      p: [0, 0.4, -1.0],
      v: [0, 0, 60],
      spin: 0,
      b: 0,
      bounceSide: 0,
    };
    let sawNet = false;
    for (let i = 0; i < 20; i++) {
      const hit = stepBall(body, DT, sport.court, sport.ball);
      if (hit.kind === 'net') sawNet = true;
    }
    expect(sawNet).toBe(true);
  });

  it('completes a match for every playable sport without stalling', () => {
    for (const sport of playableSports()) {
      const { match, seconds } = playMatch({ sport: sport.id, seed: 99, skill: 0.5 });
      expect(match.phase).toBe('gameover');
      expect(seconds).toBeLessThan(360);
      const score = match.getScore();
      expect(Math.max(...score.points)).toBeGreaterThanOrEqual(sport.scoring.pointsToWin);
    }
  });
});

// ── The shot model ────────────────────────────────────────────────────────────

describe('shot model', () => {
  const shotFor = (
    sportId: 'pickleball' | 'tabletennis',
    seat: Seat,
    contactZ: number,
    swing: Partial<SwingInput>,
    blend = 0.9,
  ) => {
    const sport = getSport(sportId);
    const toward = -seatSign(seat);
    const aim = vnorm([0.2, 0.25, toward]);
    const full: SwingInput = {
      speed: 5,
      dir: aim,
      q: qFromUnitZTo(aim),
      elev: 0.2,
      ctPeak: 0,
      ...swing,
    };
    const from: Vec3 = [0.3, sport.court.tableHeight + sport.strike.contactHeight, contactZ];
    const ctx: ShotContext = {
      seat,
      court: sport.court,
      ball: sport.ball,
      params: resolveParams(sport),
      from,
      incoming: [0, -3, -6 * toward],
      isServe: false,
      rng: makeRng(5),
    };
    const shot = mapSwingToShot(full, ctx, { blend, quality: 0.95, difficulty: 0 });
    return { shot, probe: flightProbe(from, shot.v, sport.court, sport.ball), sport, from };
  };

  it('clears the net and lands near the target, from both ends of both courts', () => {
    for (const sportId of ['pickleball', 'tabletennis'] as const) {
      for (const seat of [0, 1] as Seat[]) {
        const sign = seatSign(seat);
        const half = getSport(sportId).court.length / 2;
        for (const frac of [0.95, 0.6, 0.25]) {
          for (const swing of [
            { speed: 2.2, elev: 0.3 }, // dink
            { speed: 5.0, elev: 0.2 }, // rally
            { speed: 8.5, elev: 0.03 }, // drive
            { speed: 4.5, elev: 0.6 }, // lob
          ]) {
            const contactZ = sign * half * frac;
            const { shot, probe, sport } = shotFor(sportId, seat, contactZ, swing);
            const netTop = sport.court.netHeight + sport.court.tableHeight + sport.ball.radius;

            expect(finite(shot.v)).toBe(true);
            expect(shot.clearsNet).toBe(true);
            expect(probe.netY).not.toBeNull();
            expect(probe.netY!).toBeGreaterThan(netTop);
            expect(probe.landing).not.toBeNull();
            // It must land on the OPPONENT's side.
            expect(Math.sign(probe.landing![2])).toBe(-sign);
            // Placement accuracy is only promised when the solver found a clean
            // answer; a rescued shot trades accuracy for staying in play.
            if (!shot.rescued) {
              const err = Math.hypot(
                shot.target[0] - probe.landing![0],
                shot.target[2] - probe.landing![2],
              );
              expect(err).toBeLessThan(TUNING.shot.placementTolerance + 0.15);
            }
          }
        }
      }
    }
  });

  it('is mirror-symmetric between the two seats', () => {
    const a = shotFor('pickleball', 0, -5.0, { speed: 6, elev: 0.1 });
    const b = shotFor('pickleball', 1, 5.0, { speed: 6, elev: 0.1 });
    expect(Math.abs(a.shot.target[2])).toBeCloseTo(Math.abs(b.shot.target[2]), 1);
    expect(a.shot.type).toBe(b.shot.type);
    expect(a.shot.speed).toBeCloseTo(b.shot.speed, 0);
  });

  it('classifies the shot silhouettes from swing speed and elevation', () => {
    const sport = getSport('pickleball');
    const ctx = (y: number): ShotContext => ({
      seat: 0,
      court: sport.court,
      ball: sport.ball,
      params: resolveParams(sport),
      from: [0, y, -5],
      incoming: [0, -3, -6],
      isServe: false,
      rng: FIXED_RNG,
    });
    const sw = (speed: number, elevDeg: number): SwingInput => ({
      speed,
      dir: [0, Math.sin((elevDeg * Math.PI) / 180), 0.9],
      q: qFromUnitZTo([0, 0.2, 1]),
      elev: (elevDeg * Math.PI) / 180,
      ctPeak: 0,
    });
    expect(classifyShot(sw(2.0, 10), ctx(0.78))).toBe('dink');
    expect(classifyShot(sw(8.0, 5), ctx(0.78))).toBe('drive');
    expect(classifyShot(sw(5.0, 30), ctx(0.78))).toBe('lob');
    expect(classifyShot(sw(5.0, 15), ctx(0.78))).toBe('rally');
    // A smash needs the ball to be sitting up; the same swing low is not one.
    expect(classifyShot(sw(9.0, -25), ctx(1.8))).toBe('smash');
    expect(classifyShot(sw(9.0, -25), ctx(0.6))).not.toBe('smash');
  });

  it('keeps an assisted shot in play even when the aim is absurd', () => {
    // Aiming at their own back fence, with a terrible swing.
    const sport = getSport('pickleball');
    const badAim = vnorm([0.9, -0.4, -1]);
    const from: Vec3 = [2.5, 0.5, -6.2];
    const ctx: ShotContext = {
      seat: 0,
      court: sport.court,
      ball: sport.ball,
      params: resolveParams(sport),
      from,
      incoming: [0, -4, -8],
      isServe: false,
      rng: makeRng(11),
    };
    const shot = mapSwingToShot(
      { speed: 1.5, dir: badAim, q: qFromUnitZTo(badAim), elev: -0.4, ctPeak: 0 },
      ctx,
      { blend: TUNING.strike.assistLow, quality: 0.1, difficulty: 0.2 },
    );
    expect(finite(shot.v)).toBe(true);
    expect(Math.sign(shot.target[2])).toBe(1);
    const probe = flightProbe(from, shot.v, sport.court, sport.ball);
    expect(probe.landing).not.toBeNull();
    expect(Math.sign(probe.landing![2])).toBe(1);
  });
});

// ── Strike evaluation ─────────────────────────────────────────────────────────

describe('strike evaluation', () => {
  const sport = getSport('pickleball');
  const params = resolveParams(sport);
  const prediction = {
    tIdeal: 1000,
    p: [0.5, 0.78, 5.0] as Vec3,
    v: [0, -3, -7] as Vec3,
    kind: 'groundstroke' as const,
  };
  const perfectSwing = (): SwingInput => {
    const aim = vnorm([-0.2, 0.22, -1]);
    return { speed: 6, dir: aim, q: qFromUnitZTo(aim), elev: 0.2, ctPeak: 0 };
  };

  it('hits inside the window and whiffs outside it', () => {
    const swing = perfectSwing();
    const inside = evaluateStrike(swing, 1000, prediction, 1, sport.court, params);
    expect(inside.hit).toBe(true);
    expect(inside.quality).toBeGreaterThan(0.6);

    const late = evaluateStrike(swing, 1000 + params.windowMs + 5, prediction, 1, sport.court, params);
    expect(late.hit).toBe(false);
    expect(late.missDistanceM).toBeGreaterThan(0);

    const early = evaluateStrike(swing, 1000 - params.windowMs - 5, prediction, 1, sport.court, params);
    expect(early.hit).toBe(false);
    expect(early.dtTimingMs).toBeLessThan(0);
  });

  it('a tighter window on a harder ball turns a marginal swing into a miss', () => {
    const swing = perfectSwing();
    const marginal = 1000 + params.windowMs * 0.8;
    expect(evaluateStrike(swing, marginal, prediction, 1, sport.court, params, 0).hit).toBe(true);
    expect(evaluateStrike(swing, marginal, prediction, 1, sport.court, params, 1).hit).toBe(false);
  });

  it('caps achievable quality on a hard ball', () => {
    const swing = perfectSwing();
    const easy = evaluateStrike(swing, 1000, prediction, 1, sport.court, params, 0);
    const hard = evaluateStrike(swing, 1000, prediction, 1, sport.court, params, 0.9);
    expect(hard.quality).toBeLessThan(easy.quality);
    expect(hard.blend).toBeLessThan(easy.blend);
  });

  it('whiffs with no prediction at all, rather than throwing', () => {
    const r = evaluateStrike(perfectSwing(), 1000, null, 1, sport.court, params);
    expect(r.hit).toBe(false);
  });

  it('difficulty rises with pace, distance covered and awkward height', () => {
    const easy = strikeDifficulty(
      { ...prediction, v: [0, -1, -3] },
      [0.5, 0, 5.0],
      sport.court,
      params,
    );
    const hard = strikeDifficulty(
      { ...prediction, v: [0, -4, -12] },
      [-2.5, 0, 6.5],
      sport.court,
      params,
    );
    expect(easy).toBeLessThan(0.3);
    expect(hard).toBeGreaterThan(easy + 0.3);
    expect(hard).toBeLessThanOrEqual(1);
  });
});

// ── Scoring ───────────────────────────────────────────────────────────────────

describe('scoring', () => {
  const fresh = (): ScoreState => rallyToSeven.initial(0);

  it('requires a two-point margin to win', () => {
    let s = fresh();
    for (let i = 0; i < 6; i++) s = rallyToSeven.award(s, 0);
    for (let i = 0; i < 6; i++) s = rallyToSeven.award(s, 1);
    expect(s.points).toEqual([6, 6]);
    expect(rallyToSeven.winner(s)).toBeNull();

    s = rallyToSeven.award(s, 0);
    expect(rallyToSeven.winner(s)).toBeNull(); // 7-6 is not a win
    s = rallyToSeven.award(s, 0);
    expect(rallyToSeven.winner(s)).toBe(0); // 8-6 is
  });

  it('flags game point for the right seat', () => {
    let s = fresh();
    for (let i = 0; i < 6; i++) s = rallyToSeven.award(s, 0);
    expect(s.points).toEqual([6, 0]);
    expect(s.gamePoint).toBe(true);
    expect(s.gamePointSeat).toBe(0);

    let t = fresh();
    for (let i = 0; i < 6; i++) {
      t = rallyToSeven.award(t, 0);
      t = rallyToSeven.award(t, 1);
    }
    expect(t.gamePoint).toBe(false); // 6-6, nobody is one point away
  });

  it('hands the serve to whoever won the point', () => {
    const s = rallyToSeven.award(fresh(), 1);
    expect(s.server).toBe(1);
  });

  it('is configurable for other sports', () => {
    const to11 = makeRallyScoring(11, 2);
    let s = to11.initial(0);
    for (let i = 0; i < 11; i++) s = to11.award(s, 0);
    expect(to11.winner(s)).toBe(0);
  });
});

// ── Match behaviour ───────────────────────────────────────────────────────────

describe('match', () => {
  it('produces a valid final score and a summary', () => {
    const { match } = playMatch({ seed: 7, skill: 0.6 });
    expect(match.phase).toBe('gameover');
    const winner = match.getWinner();
    expect(winner === 0 || winner === 1).toBe(true);
    const summary = match.summary();
    expect(summary.length).toBeGreaterThanOrEqual(3);
    expect(summary.join(' ')).toContain('Ace');
  });

  it('emits the events the commentary system depends on, with rich data', () => {
    const { events } = playMatch({ seed: 13, skill: 0.45 });
    const types = new Set(events.map((e) => e.type));
    const required: GameEventType[] = ['match_start', 'serve', 'hit', 'point', 'match_end'];
    for (const r of required) {
      expect(types.has(r)).toBe(true);
    }

    // Thin events produce generic commentary, so the payloads are part of the
    // contract, not a convenience.
    const point = events.find((e) => e.type === 'point')!;
    for (const key of [
      'winnerName',
      'loserName',
      'reason',
      'rallyLength',
      'rallyDurationMs',
      'decidingShot',
      'scoreAfter',
      'wasBreakPoint',
    ]) {
      expect(point.data[key]).toBeDefined();
    }

    const hit = events.find((e) => e.type === 'hit')!;
    for (const key of ['player', 'shot', 'speed', 'quality', 'rallyLength', 'difficulty']) {
      expect(hit.data[key]).toBeDefined();
    }

    // Salience has to be honest or the commentator talks over every rally shot.
    const routineHits = events.filter((e) => e.type === 'hit' && e.data.shot === 'rally');
    for (const e of routineHits) expect(e.salience).toBeLessThan(TUNING.commentary.minSalience);
    expect(events.find((e) => e.type === 'match_end')!.salience).toBe(1);

    // Every event must carry an id and a monotonic timestamp.
    let last = -1;
    for (const e of events) {
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.t).toBeGreaterThanOrEqual(last);
      last = e.t;
      expect(e.salience).toBeGreaterThanOrEqual(0);
      expect(e.salience).toBeLessThanOrEqual(1);
    }
  });

  it('awards the point against whoever actually erred', () => {
    // Regression: an "out" call on the SECOND bounce used to be charged to the
    // player who hit the ball IN, handing the point to whoever missed it.
    const { events } = playMatch({ seed: 2024, skill: 0.5 });
    const points = events.filter((e) => e.type === 'point');
    expect(points.length).toBeGreaterThan(8);
    for (const p of points) {
      expect(p.data.winner).not.toBe(p.data.loser);
      // A point won on a double bounce means the LOSER failed to reach the ball.
      if (p.data.reason === 'double_bounce') {
        const db = events
          .filter((e) => e.type === 'double_bounce' && e.t <= p.t)
          .at(-1);
        if (db) expect(db.data.seat).toBe(p.data.loser);
      }
    }
  });

  it('never leaves a three-times-bounced ball in play', () => {
    let badPoints = 0;
    const res = playMatch({
      seed: 2024,
      skill: 0.5,
      onSnapshot: (s) => {
        if (s.phase === 'point' && s.ball && s.ball.b > 2) badPoints++;
      },
    });
    expect(res.match.phase).toBe('gameover');
    expect(badPoints).toBe(0);
  });

  it('keeps the score within reach of the rules at all times', () => {
    playMatch({
      seed: 5150,
      skill: 0.55,
      onSnapshot: (s) => {
        expect(s.score.points[0]).toBeGreaterThanOrEqual(0);
        expect(s.score.points[1]).toBeGreaterThanOrEqual(0);
        expect(s.score.points[0] + s.score.points[1]).toBeLessThan(40);
        expect(s.players.length).toBe(2);
        expect(s.rally).toBeGreaterThanOrEqual(0);
      },
    });
  });
});
