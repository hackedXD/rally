/**
 * The authoritative rally loop.
 *
 * Pure: no I/O, no clock, no randomness beyond the injected seed (coding
 * standard 1). Time arrives as a parameter on every `step`, which is what makes
 * a match replayable from a log and a test deterministic.
 *
 * Phase machine:
 *
 *   lobby ──start()──> serve ──swing──> rally ──rule──> point ──┬──> serve
 *                        ^                                      │
 *                        └──────────── fault ───────────────────┘
 *                                                               └──> gameover
 */

import type {
  GameEvent,
  MatchPhase,
  Millis,
  PlayerAnim,
  PlayerState,
  Quat,
  Reconcile,
  ScoreState,
  Seat,
  Snapshot,
  StrikeTelegraph,
  SwingInput,
  Vec3,
} from '@rally/protocol';
import {
  QUAT_IDENTITY,
  TUNING,
  clamp,
  clamp01,
  damp,
  eventId,
  lerp,
  otherSeat,
  qFromUnitZTo,
  qnorm,
  r,
  rv,
  seatSign,
  vlen,
  vnorm,
} from '@rally/protocol';
import { resolveParams, type SimParams } from './params.js';
import { bodyFinite, stepBall, surfaceAt, type BallBody } from './physics.js';
import { predictContact, predictLanding, type ContactPrediction } from './predict.js';
import { makeRng, type Rng } from './rng.js';
import { mapServeToShot, mapSwingToShot, type Shot, type ShotContext } from './shot.js';
import type { DerivedState, SportModule } from './sport.js';
import { evaluateStrike, strikeDifficulty, type StrikeEval } from './strike.js';
import {
  avgSwingSpeed,
  cloneStats,
  emptyStats,
  errorSummary,
  signatureShot,
  type MatchStats,
} from './stats.js';

export interface TickInput {
  /** Server time for this tick. The only clock the simulation ever sees. */
  t: Millis;
  /** Latest paddle orientation per seat, from the controllers. */
  pose: Record<number, Quat | undefined>;
  connected: Record<number, boolean>;
  /** Seats that pressed SERVE since the last tick. */
  serveRequests: Seat[];
  paused: boolean;
}

export function emptyTickInput(t: Millis): TickInput {
  return { t, pose: {}, connected: { 0: true, 1: true }, serveRequests: [], paused: false };
}

export interface Simulation {
  step(dt: number, inputs: TickInput): Snapshot;
  applySwing(seat: Seat, swing: SwingInput, tServer: Millis): void;
  drainEvents(): GameEvent[];
  reset(sport: SportModule): void;
}

interface ArmedStrike {
  seat: Seat;
  swing: SwingInput;
  ev: StrikeEval;
  resolveAt: Millis;
}

export interface MatchOptions {
  sport: SportModule;
  seed: number;
  names: [string, string];
  bots?: [boolean, boolean];
  firstServer?: Seat;
}

const LANE = [0, 1] as const;

export class Match implements Simulation {
  sport: SportModule;
  tick = 0;
  t: Millis = 0;
  phase: MatchPhase = 'lobby';
  phaseT: Millis = 0;

  private body: BallBody | null = null;
  private owner: Seat | null = null;
  private players: PlayerState[];
  private score: ScoreState;
  private rng: Rng;
  private seed: number;

  /** Shots in the current rally. Read by the commentary director and the UI. */
  rally = 0;
  private rallyStartedAt: Millis = 0;
  private serveFaults = 0;
  private serveIsLive = false;

  private prediction: ContactPrediction | null = null;
  private telegraph: StrikeTelegraph | null = null;
  private armed: ArmedStrike | null = null;
  private reconcile: Reconcile | null = null;
  private reconcileUntil: Millis = 0;
  /** Difficulty of the strike the current telegraph describes. */
  private difficulty = 0;
  /** One recovery swing per ball flight, no more. */
  private secondChanceUsed = false;

  private anim: Record<number, { a: PlayerAnim; until: Millis }> = {
    0: { a: 'idle', until: 0 },
    1: { a: 'idle', until: 0 },
  };

  private events: GameEvent[] = [];
  private stats: MatchStats;
  private lastShot: { seat: Seat; shot: Shot; quality: number } | null = null;
  private prevDerived: DerivedState | null = null;
  private derivedDirty = false;
  private history: { t: Millis; p: Vec3; v: Vec3 }[] = [];
  private matchWinner: Seat | null = null;
  /** Resolved sport constants for this match. */
  private params: SimParams;

  constructor(opts: MatchOptions) {
    this.sport = opts.sport;
    this.seed = opts.seed;
    this.rng = makeRng(opts.seed);
    this.score = opts.sport.scoring.initial(opts.firstServer ?? 0);
    this.stats = emptyStats(0);
    this.players = LANE.map((seat) => ({
      seat: seat as Seat,
      name: opts.names[seat] ?? `Player ${seat + 1}`,
      p: this.readyPosition(seat as Seat),
      paddleQ: QUAT_IDENTITY,
      anim: 'idle' as PlayerAnim,
      connected: true,
      bot: opts.bots?.[seat] ?? false,
    }));
    this.params = resolveParams(opts.sport);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Sport constants are resolved into an immutable per-match object rather than
   * written into global TUNING: the server runs many rooms in one process, and a
   * table tennis match starting next door must not rewrite this match's strike
   * window mid-rally. Call this again after the live tuning panel patches TUNING.
   */
  refreshParams(): void {
    this.params = resolveParams(this.sport);
  }

  reset(sport: SportModule): void {
    this.sport = sport;
    this.params = resolveParams(sport);
    this.tick = 0;
    this.phase = 'lobby';
    this.phaseT = this.t;
    this.body = null;
    this.owner = null;
    this.rally = 0;
    this.serveFaults = 0;
    this.serveIsLive = false;
    this.prediction = null;
    this.telegraph = null;
    this.armed = null;
    this.reconcile = null;
    this.matchWinner = null;
    this.lastShot = null;
    this.score = sport.scoring.initial(0);
    this.stats = emptyStats(this.t);
    this.rng = makeRng(this.seed);
    this.events = [];
    this.history = [];
    this.prevDerived = null;
    for (const p of this.players) {
      p.p = this.readyPosition(p.seat);
      p.anim = 'idle';
    }
  }

  setNames(names: [string, string]): void {
    this.players[0].name = names[0];
    this.players[1].name = names[1];
  }

  setBot(seat: Seat, bot: boolean): void {
    const p = this.players[seat];
    if (p) p.bot = bot;
  }

  /** Kick off from the lobby. */
  start(t: Millis): void {
    this.t = t;
    this.stats = emptyStats(t);
    this.emit({
      type: 'match_start',
      data: {
        sport: this.sport.id,
        p0: this.players[0].name,
        p1: this.players[1].name,
        pointsToWin: this.sport.scoring.pointsToWin,
      },
      salience: 1,
      priority: 3,
    });
    this.beginServe(true);
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  step(dt: number, input: TickInput): Snapshot {
    this.t = input.t;
    this.tick++;

    for (const seat of LANE) {
      const connected = input.connected[seat];
      if (connected !== undefined) this.players[seat].connected = connected;
      const q = input.pose[seat];
      if (q) this.players[seat].paddleQ = qnorm(q);
    }

    if (input.paused) {
      if (this.phase !== 'lobby' && this.phase !== 'gameover') this.setPhase('paused');
      return this.snapshot();
    }
    if (this.phase === 'paused') this.setPhase(this.body && this.serveIsLive ? 'rally' : 'serve');

    switch (this.phase) {
      case 'serve':
        this.stepServe(dt, input);
        break;
      case 'rally':
        this.stepRally(dt);
        break;
      case 'point':
        if (this.t - this.phaseT >= TUNING.match.pointPauseMs) {
          if (this.matchWinner !== null) this.enterGameOver();
          else this.beginServe(true);
        }
        break;
      default:
        break;
    }

    this.updatePositions(dt);
    this.updateBotPaddles();
    this.updateAnims();
    this.recordHistory();
    this.runDerivedClassifier();

    return this.snapshot();
  }

  private stepServe(dt: number, input: TickInput): void {
    // The ball hovers in the server's hand until they swing. Either a swing or
    // the SERVE button launches it, and after a long wait the sim serves for
    // them — a demo must never stall on someone who didn't understand the UI.
    const server = this.score.server;
    const hand = this.handPosition(server);
    this.body = {
      p: hand,
      v: [0, 0, 0],
      spin: 0,
      b: 0,
      bounceSide: 0,
    };
    this.owner = null;

    const requested = input.serveRequests.includes(server);
    const timedOut = this.t - this.phaseT > TUNING.serve.autoServeAfterMs;
    if (requested || timedOut) this.autoServe(server);
  }

  private stepRally(dt: number): void {
    const body = this.body;
    if (!body || this.owner === null) return;

    // Resolve a swing that was thrown early: the player's paddle is already
    // moving, and the ball arrives to meet it. This is exactly how Wii Sports
    // handled it, and it feels correct rather than laggy.
    if (this.armed && this.t >= this.armed.resolveAt) {
      const armed = this.armed;
      this.armed = null;
      this.resolveStrike(armed.seat, armed.swing, armed.ev, [...body.p] as Vec3);
      return;
    }

    const hit = stepBall(body, dt, this.sport.court, this.sport.ball);

    if (!bodyFinite(body) || body.p[1] < -3) {
      this.endRally(otherSeat(this.owner), 'lost_ball');
      return;
    }

    const ownerSide = seatSign(this.owner);

    switch (hit.kind) {
      case 'net': {
        this.emit({
          type: 'net',
          seat: this.owner,
          data: {
            seat: this.owner,
            speed: r(hit.speed, 1),
            x: r(hit.at[0], 2),
            height: r(hit.at[1], 2),
            shot: this.lastShot?.shot.type ?? 'rally',
            serving: this.serveIsLive && this.rally <= 1,
          },
          salience: 0.55,
          priority: 2,
        });
        this.stats.perSeat[this.owner].netErrors++;
        if (this.isServeInFlight()) this.serveFault('net');
        else this.endRally(otherSeat(this.owner), 'net');
        return;
      }

      case 'floor': {
        this.emitOut(hit.at, 'off_table');
        this.stats.perSeat[this.owner].outErrors++;
        if (this.isServeInFlight()) this.serveFault('out');
        else this.endRally(otherSeat(this.owner), 'out');
        return;
      }

      case 'bounce': {
        this.emit({
          type: 'bounce',
          data: {
            x: r(hit.at[0], 2),
            z: r(hit.at[2], 2),
            inBounds: hit.inBounds,
            speed: r(hit.speed, 1),
            side: hit.side,
          },
          salience: 0.03,
          priority: 0,
        });

        // Bounced on the hitter's own side: it never made it over.
        if (hit.side === ownerSide) {
          if (this.isServeInFlight()) this.serveFault('short');
          else this.endRally(otherSeat(this.owner), 'short');
          return;
        }

        // On the receiver's side. Only the FIRST bounce after crossing the net
        // decides in-or-out; a second bounce anywhere means the receiver simply
        // failed to return it, and calling that "out" would hand the point to
        // whoever missed the ball.
        if (body.b >= 2) {
          const failed = otherSeat(this.owner);
          this.stats.perSeat[failed].doubleBounces++;
          this.emit({
            type: 'double_bounce',
            seat: failed,
            data: {
              seat: failed,
              player: this.players[failed].name,
              rallyLength: this.rally,
              shotIncoming: this.lastShot?.shot.type ?? 'rally',
            },
            salience: 0.3,
            priority: 1,
          });
          this.endRally(this.owner, 'double_bounce');
          return;
        }

        if (!hit.inBounds) {
          this.emitOut(hit.at, 'out');
          this.stats.perSeat[this.owner].outErrors++;
          if (this.isServeInFlight()) this.serveFault('out');
          else this.endRally(otherSeat(this.owner), 'out');
          return;
        }

        // Serve-specific legality: must clear the non-volley zone.
        if (
          this.isServeInFlight() &&
          this.sport.serve.mustClearKitchen &&
          Math.abs(hit.at[2]) < this.sport.court.nonVolleyZone
        ) {
          this.serveFault('kitchen');
          return;
        }

        if (this.isServeInFlight()) this.serveIsLive = false; // the serve is good
        return;
      }

      default:
        return;
    }
  }

  // ── Serving ─────────────────────────────────────────────────────────────────

  private beginServe(newPoint: boolean): void {
    if (newPoint) this.serveFaults = 0;
    this.setPhase('serve');
    this.rally = 0;
    this.rallyStartedAt = this.t;
    this.prediction = null;
    this.telegraph = null;
    this.armed = null;
    this.owner = null;
    this.serveIsLive = false;
    this.secondChanceUsed = false;
    this.lastShot = null;
    this.body = { p: this.handPosition(this.score.server), v: [0, 0, 0], spin: 0, b: 0, bounceSide: 0 };
    this.derivedDirty = true;
  }

  /** A neutral, heavily assisted serve. Used by the bot and by the timeout. */
  private autoServe(seat: Seat): void {
    const toward = -seatSign(seat);
    const dir = vnorm([this.rng.spread(0.18), 0.3, toward]);
    this.doServe(seat, {
      speed: this.rng.range(4.0, 5.5),
      dir,
      q: qFromUnitZTo(dir),
      elev: 0.3,
      ctPeak: this.t,
    });
  }

  private doServe(seat: Seat, swing: SwingInput): void {
    const from = this.handPosition(seat);
    const ctx: ShotContext = {
      seat,
      court: this.sport.court,
      ball: this.sport.ball,
      params: this.params,
      from,
      incoming: [0, 0, 0],
      isServe: true,
      rng: this.rng,
    };
    // Power scales the *swing*, never the solved velocity: scaling the output
    // would flatten the trajectory the solver just fitted and drop the ball
    // straight into the tape.
    const shot = mapServeToShot(
      { ...swing, speed: swing.speed * TUNING.serve.powerScale },
      ctx,
    );

    this.body = { p: from, v: shot.v, spin: 0, b: 0, bounceSide: 0 };
    this.owner = seat;
    this.serveIsLive = true;
    this.rally = 1;
    this.rallyStartedAt = this.t;
    this.setPhase('rally');
    this.lastShot = { seat, shot, quality: 1 };

    const st = this.stats.perSeat[seat];
    st.serves++;
    st.shots.serve++;
    st.swingCount++;
    st.swingSpeedSum += swing.speed;
    this.stats.rallies++;
    this.stats.totalShots++;

    this.setAnim(seat, 'swing', 260);
    this.setReconcile({ seat, t: this.t, p: from, q: swing.q, kind: 'hit' });

    const landing = predictLanding(this.body, this.sport.court, this.sport.ball, this.t);
    this.emit({
      type: 'serve',
      seat,
      data: {
        seat,
        server: this.players[seat].name,
        receiver: this.players[otherSeat(seat)].name,
        speed: r(shot.speed, 1),
        faultsSoFar: this.serveFaults,
        score: this.score.points.join('-'),
        gamePoint: this.score.gamePoint,
        targetZ: r(shot.target[2], 2),
        willLandIn: landing?.inBounds ?? false,
      },
      salience: this.score.gamePoint ? 0.6 : 0.22,
      priority: 1,
    });

    this.secondChanceUsed = false;
    this.retarget(otherSeat(seat), { mustBounce: true });
    this.derivedDirty = true;
  }

  private serveFault(reason: string): void {
    const server = this.score.server;
    this.serveFaults++;
    this.stats.perSeat[server].serveFaults++;
    this.serveIsLive = false;
    this.emit({
      type: 'fault',
      seat: server,
      data: {
        seat: server,
        player: this.players[server].name,
        reason,
        faultNumber: this.serveFaults,
        willLosePoint: this.serveFaults > this.sport.serve.faults,
      },
      salience: this.serveFaults > this.sport.serve.faults ? 0.6 : 0.35,
      priority: 1,
    });
    if (this.serveFaults > this.sport.serve.faults) {
      this.endRally(otherSeat(server), 'double_fault');
    } else {
      this.beginServe(false);
    }
  }

  private isServeInFlight(): boolean {
    return this.serveIsLive && this.rally <= 1;
  }

  // ── Swings ──────────────────────────────────────────────────────────────────

  applySwing(seat: Seat, swing: SwingInput, tServer: Millis): void {
    if (this.phase === 'serve') {
      if (seat === this.score.server) this.doServe(seat, swing);
      return;
    }
    if (this.phase !== 'rally' || !this.body) return;
    if (this.armed) return; // one swing at a time
    if (this.telegraph === null || this.telegraph.seat !== seat) {
      // Nothing to hit. Still animate: a swing that produces no reaction at all
      // reads as "the controls are broken" rather than "there was no ball there".
      this.setAnim(seat, 'swing', 240);
      return;
    }

    // Lag compensation: the swing describes something the player perceived
    // roughly one network trip ago. Rewind, but never further than MAX_REWIND.
    const tEval = clamp(tServer, this.t - TUNING.net.maxRewindMs, this.t);
    const ev = evaluateStrike(
      swing,
      tEval,
      this.prediction,
      seat,
      this.sport.court,
      this.params,
      this.difficulty,
    );

    const st = this.stats.perSeat[seat];
    st.swingCount++;
    st.swingSpeedSum += swing.speed;

    if (!ev.hit) {
      this.whiff(seat, swing, ev);
      return;
    }

    if (tEval < (this.prediction?.tIdeal ?? tEval)) {
      this.armed = { seat, swing, ev, resolveAt: this.prediction!.tIdeal };
      this.setAnim(seat, 'swing', 320);
      return;
    }
    this.resolveStrike(seat, swing, ev, [...this.body.p] as Vec3);
  }

  private resolveStrike(seat: Seat, swing: SwingInput, ev: StrikeEval, contact: Vec3): void {
    const body = this.body;
    if (!body) return;

    const ctx: ShotContext = {
      seat,
      court: this.sport.court,
      ball: this.sport.ball,
      params: this.params,
      from: contact,
      incoming: [...body.v] as Vec3,
      isServe: false,
      rng: this.rng,
    };
    const shot = mapSwingToShot(swing, ctx, {
      blend: ev.blend,
      quality: ev.quality,
      difficulty: this.difficulty,
    });

    body.p = contact;
    body.v = shot.v;
    body.b = 0;
    body.bounceSide = 0;
    this.owner = seat;
    this.serveIsLive = false;
    this.rally++;
    this.lastShot = { seat, shot, quality: ev.quality };

    const st = this.stats.perSeat[seat];
    st.hits++;
    st.consecutiveWhiffs = 0;
    st.shots[shot.type]++;
    this.stats.totalShots++;

    this.setAnim(seat, 'swing', 280);
    // Step 4 — reconcile the visuals. Drive the paddle through the real contact
    // point; the player's hand was probably 20 cm off and the screen must never
    // show a paddle passing through empty air while the ball rockets away.
    this.setReconcile({ seat, t: this.t, p: contact, q: swing.q, kind: 'hit' });

    const landing = predictLanding(body, this.sport.court, this.sport.ball, this.t);
    this.emit({
      type: 'hit',
      seat,
      data: {
        seat,
        player: this.players[seat].name,
        shot: shot.type,
        speed: r(shot.speed, 1),
        quality: r(ev.quality, 2),
        timingMs: Math.round(ev.dtTimingMs),
        aimErrDeg: Math.round(ev.aimErrDeg),
        rallyLength: this.rally,
        contactHeight: r(contact[1], 2),
        arrivalSpeed: r(vlen(ctx.incoming), 1),
        assisted: ev.blend < 0.4,
        difficulty: r(this.difficulty, 2),
        willLandIn: landing?.inBounds ?? false,
        crosscourt: Math.abs(shot.target[0] - contact[0]) > this.sport.court.width * 0.35,
        contactZ: r(contact[2], 2),
        targetZ: r(shot.target[2], 2),
        flightT: r(shot.flightT, 2),
        clearsNet: shot.clearsNet,
      },
      salience: salienceForHit(shot, ev.quality, this.rally),
      priority: shot.type === 'smash' ? 2 : 1,
    });

    this.secondChanceUsed = false;
    this.retarget(otherSeat(seat), {});
    this.derivedDirty = true;
  }

  private whiff(seat: Seat, swing: SwingInput, ev: StrikeEval): void {
    const st = this.stats.perSeat[seat];
    st.whiffs++;
    st.consecutiveWhiffs++;
    this.setAnim(seat, 'whiff', 380);
    if (this.prediction) {
      this.setReconcile({
        seat,
        t: this.t,
        p: this.prediction.p,
        q: swing.q,
        kind: 'whiff',
      });
    }

    this.emit({
      type: 'whiff',
      seat,
      data: {
        seat,
        player: this.players[seat].name,
        missDistanceM: r(ev.missDistanceM, 2),
        timingMs: Math.round(ev.dtTimingMs),
        early: ev.dtTimingMs < 0,
        ballSpeed: r(this.body ? vlen(this.body.v) : 0, 1),
        consecutiveWhiffs: st.consecutiveWhiffs,
        shotIncoming: this.lastShot?.shot.type ?? 'rally',
        rallyLength: this.rally,
        windowMs: Math.round(ev.windowMs),
        difficulty: r(this.difficulty, 2),
      },
      salience: Math.min(0.9, 0.45 + st.consecutiveWhiffs * 0.15),
      priority: 2,
    });

    // Generous, but not free: after whiffing at a volley the receiver gets one
    // more crack at the ball once it bounces. It is a scramble, so it carries a
    // difficulty floor, and a second whiff on the same flight ends it — without
    // that, whiffing costs nothing and no rally ever ends.
    if (this.secondChanceUsed) {
      this.telegraph = null;
      this.prediction = null;
      this.difficulty = 0;
      return;
    }
    this.secondChanceUsed = true;
    this.retarget(seat, { afterWhiff: true });
  }

  /** Recompute the strike telegraph for one seat. Called once per shot. */
  private retarget(seat: Seat, opts: { mustBounce?: boolean; afterWhiff?: boolean }): void {
    if (!this.body) {
      this.prediction = null;
      this.telegraph = null;
      this.difficulty = 0;
      return;
    }
    const side = seatSign(seat);
    const bouncesAlready = this.body.bounceSide === side ? this.body.b : 0;
    const wasAt = [...this.players[seat].p] as Vec3;
    this.prediction = predictContact(
      this.body,
      this.sport.court,
      this.sport.ball,
      seat,
      this.t,
      this.params,
      { mustBounce: opts.mustBounce, bouncesAlready },
    );
    if (!this.prediction) {
      this.telegraph = null;
      this.difficulty = 0;
      return;
    }
    // Difficulty is measured from where the receiver was standing when the shot
    // was launched, not from where they end up — covering ground is the cost.
    this.difficulty = strikeDifficulty(this.prediction, wasAt, this.sport.court, this.params);
    if (opts.afterWhiff) {
      this.difficulty = Math.max(this.difficulty, TUNING.strike.scrambleDifficulty);
    }
    this.telegraph = {
      seat,
      tIdeal: this.prediction.tIdeal,
      p: rv(this.prediction.p, 2),
      open: false,
      difficulty: r(this.difficulty, 2),
    };
  }

  // ── Point resolution ────────────────────────────────────────────────────────

  private endRally(winner: Seat, reason: string): void {
    const loser = otherSeat(winner);
    const rallyMs = this.t - this.rallyStartedAt;
    const before = this.score.points.slice() as [number, number];
    const wasBreak = this.score.server !== winner;
    const longest = this.rally > this.stats.longestRally;

    this.score = this.sport.scoring.award(this.score, winner);

    const w = this.stats.perSeat[winner];
    const l = this.stats.perSeat[loser];
    w.pointsWon++;
    w.pointsInARow++;
    w.bestRun = Math.max(w.bestRun, w.pointsInARow);
    l.pointsInARow = 0;
    w.longestRally = Math.max(w.longestRally, this.rally);
    this.stats.longestRally = Math.max(this.stats.longestRally, this.rally);
    this.stats.longestRallyMs = Math.max(this.stats.longestRallyMs, rallyMs);
    this.stats.biggestLead = Math.max(
      this.stats.biggestLead,
      Math.abs(this.score.points[0] - this.score.points[1]),
    );
    if (this.lastShot && this.lastShot.seat === winner && reason !== 'double_fault') {
      w.winners++;
    }

    this.emit({
      type: 'point',
      seat: winner,
      data: {
        winner,
        loser,
        winnerName: this.players[winner].name,
        loserName: this.players[loser].name,
        reason,
        rallyLength: this.rally,
        rallyDurationMs: Math.round(rallyMs),
        decidingShot: this.lastShot?.shot.type ?? 'none',
        decidingSpeed: r(this.lastShot?.shot.speed ?? 0, 1),
        scoreBefore: before.join('-'),
        scoreAfter: this.score.points.join('-'),
        wasBreakPoint: wasBreak,
        longestRallyOfMatch: longest,
        margin: Math.abs(this.score.points[0] - this.score.points[1]),
        streak: w.pointsInARow,
      },
      salience: saliencForPoint(this.rally, this.score, longest),
      priority: 3,
    });

    this.setAnim(winner, 'celebrate', TUNING.match.pointPauseMs);
    this.setAnim(loser, 'idle', 0);
    this.telegraph = null;
    this.prediction = null;
    this.armed = null;
    this.matchWinner = this.sport.scoring.winner(this.score);
    this.setPhase('point');
    this.derivedDirty = true;
  }

  private enterGameOver(): void {
    const winner = this.matchWinner ?? 0;
    this.setPhase('gameover');
    this.emit({
      type: 'match_end',
      seat: winner,
      data: {
        winner,
        winnerName: this.players[winner].name,
        loserName: this.players[otherSeat(winner)].name,
        final: this.score.points.join('-'),
        margin: Math.abs(this.score.points[0] - this.score.points[1]),
        longestRally: this.stats.longestRally,
        totalShots: this.stats.totalShots,
        durationMs: Math.round(this.t - this.stats.startedAt),
      },
      salience: 1,
      priority: 3,
    });
  }

  // ── Presentation state ──────────────────────────────────────────────────────

  private updatePositions(dt: number): void {
    const k = damp(11, dt);
    for (const p of this.players) {
      const want = this.wantedPosition(p.seat);
      p.p = [
        lerp(p.p[0], want[0], k),
        lerp(p.p[1], want[1], k),
        lerp(p.p[2], want[2], k),
      ];
    }
  }

  /**
   * Auto-positioning. The receiver stands exactly where the contact will happen,
   * which is what lets the only input be the swing.
   */
  private wantedPosition(seat: Seat): Vec3 {
    const court = this.sport.court;
    const side = seatSign(seat);
    const half = court.length / 2;

    if (this.telegraph?.seat === seat) {
      const target = this.telegraph.p;
      return [
        clamp(target[0], -court.width / 2 - 1.1, court.width / 2 + 1.1),
        0,
        clamp(
          target[2],
          side < 0 ? -half - this.params.reachDepth : 0.9,
          side < 0 ? -0.9 : half + this.params.reachDepth,
        ),
      ];
    }
    if (this.phase === 'serve' && this.score.server === seat) {
      return [clamp(this.rng.spread(0.0), -1, 1) * 0 + 0, 0, side * (half - 0.45)];
    }
    return this.readyPosition(seat);
  }

  private readyPosition(seat: Seat): Vec3 {
    const court = this.sport.court;
    const side = seatSign(seat);
    const ballX = this.body ? clamp(this.body.p[0] * 0.35, -court.width / 2, court.width / 2) : 0;
    return [ballX, 0, side * (court.length / 2 - 0.9)];
  }

  private handPosition(seat: Seat): Vec3 {
    const court = this.sport.court;
    const side = seatSign(seat);
    const base = this.players[seat]?.p ?? this.readyPosition(seat);
    return [
      base[0] + side * 0.18,
      surfaceAt(court, base[0], base[2]) + TUNING.serve.holdHeight + court.tableHeight * 0,
      side * (court.length / 2 - 0.35),
    ];
  }

  /**
   * Bots have no controller, so nothing feeds them a pose. Point their paddle at
   * the ball (or at the opponent between rallies) so the far side of the court
   * does not look like somebody holding a paddle backwards.
   */
  private updateBotPaddles(): void {
    for (const p of this.players) {
      if (!p.bot) continue;
      const toward = -seatSign(p.seat);
      const target: Vec3 = this.body
        ? [this.body.p[0], this.body.p[1], this.body.p[2]]
        : [0, 1, toward * this.sport.court.length * 0.3];
      const dir = vnorm([
        target[0] - p.p[0],
        Math.max(0.12, target[1] - (p.p[1] + 1.1)) + 0.25,
        target[2] - p.p[2],
      ]);
      // Never aim back over their own baseline.
      if (Math.sign(dir[2]) !== toward) dir[2] = toward * 0.5;
      p.paddleQ = qFromUnitZTo(vnorm(dir));
    }
  }

  private updateAnims(): void {
    for (const p of this.players) {
      const a = this.anim[p.seat];
      if (a.until > this.t) {
        p.anim = a.a;
        continue;
      }
      // Wind up as the strike window approaches. Reads as anticipation.
      if (
        this.telegraph?.seat === p.seat &&
        this.telegraph.tIdeal - this.t < 420 &&
        this.telegraph.tIdeal - this.t > -this.params.windowMs
      ) {
        p.anim = 'wind';
      } else {
        p.anim = 'idle';
      }
    }
    if (this.telegraph) {
      this.telegraph.open =
        Math.abs(this.t - this.telegraph.tIdeal) <= this.params.windowMs;
    }
  }

  private setAnim(seat: Seat, a: PlayerAnim, ms: number): void {
    this.anim[seat] = { a, until: this.t + ms };
  }

  private setReconcile(rec: Reconcile): void {
    this.reconcile = { ...rec, p: rv(rec.p, 3) };
    this.reconcileUntil = this.t + 120;
  }

  private setPhase(phase: MatchPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseT = this.t;
    this.derivedDirty = true;
  }

  private recordHistory(): void {
    if (!this.body) return;
    this.history.push({ t: this.t, p: [...this.body.p] as Vec3, v: [...this.body.v] as Vec3 });
    while (this.history.length > TUNING.net.historyTicks) this.history.shift();
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  private emit(e: Omit<GameEvent, 'id' | 't'> & { t?: Millis }): void {
    this.events.push({ id: eventId(e.type), t: e.t ?? this.t, ...e } as GameEvent);
  }

  private emitOut(at: Vec3, reason: string): void {
    const seat = this.owner ?? 0;
    const court = this.sport.court;
    const longBy = Math.max(0, Math.abs(at[2]) - court.length / 2);
    const wideBy = Math.max(0, Math.abs(at[0]) - court.width / 2);
    this.emit({
      type: 'out',
      seat,
      data: {
        seat,
        player: this.players[seat].name,
        reason,
        longByM: r(longBy, 2),
        wideByM: r(wideBy, 2),
        shot: this.lastShot?.shot.type ?? 'rally',
        rallyLength: this.rally,
      },
      salience: 0.45,
      priority: 1,
    });
  }

  private runDerivedClassifier(): void {
    if (!this.derivedDirty) return;
    this.derivedDirty = false;
    const next = this.derived();
    if (this.prevDerived) {
      for (const e of this.sport.classifyEvents(this.prevDerived, next)) this.events.push(e);
    }
    this.prevDerived = next;
  }

  private derived(): DerivedState {
    return {
      t: this.t,
      phase: this.phase,
      score: { ...this.score, points: [...this.score.points] as [number, number] },
      rally: this.rally,
      rallyStartedAt: this.rallyStartedAt,
      stats: cloneStats(this.stats),
    };
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  snapshot(): Snapshot {
    const snap: Snapshot = {
      tick: this.tick,
      t: Math.round(this.t),
      phase: this.phase,
      ball: this.body
        ? {
            p: rv(this.body.p, 3),
            v: rv(this.body.v, 2),
            spin: 0,
            b: this.body.b,
            owner: this.owner,
          }
        : null,
      players: this.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        p: rv(p.p, 2),
        paddleQ: p.paddleQ,
        anim: p.anim,
        connected: p.connected,
        bot: p.bot,
      })),
      score: { ...this.score, points: [...this.score.points] as [number, number] },
      rally: this.rally,
      phaseT: Math.round(this.phaseT),
    };
    if (this.telegraph && (this.phase === 'rally' || this.phase === 'serve')) {
      snap.strike = { ...this.telegraph, tIdeal: Math.round(this.telegraph.tIdeal) };
    }
    if (this.reconcile && this.t <= this.reconcileUntil) snap.reconcile = this.reconcile;
    return snap;
  }

  currentSnapshot(): Snapshot {
    return this.snapshot();
  }

  // ── Introspection, for the bot and the commentary director ──────────────────

  getStats(): MatchStats {
    return this.stats;
  }

  getScore(): ScoreState {
    return this.score;
  }

  getTelegraph(): StrikeTelegraph | null {
    return this.telegraph;
  }

  getPrediction(): ContactPrediction | null {
    return this.prediction;
  }

  getDifficulty(): number {
    return this.difficulty;
  }

  getParams(): SimParams {
    return this.params;
  }

  getBall(): BallBody | null {
    return this.body;
  }

  getPlayers(): PlayerState[] {
    return this.players;
  }

  getWinner(): Seat | null {
    return this.matchWinner;
  }

  /** Ball history, newest last. Used for the point-winning replay. */
  getHistory(): readonly { t: Millis; p: Vec3; v: Vec3 }[] {
    return this.history;
  }

  /** End-of-match talking points. Feeds both the UI and the closing line. */
  summary(): string[] {
    const out: string[] = [];
    const [a, b] = this.players;
    for (const p of [a, b]) {
      const s = this.stats.perSeat[p.seat];
      const sig = signatureShot(s);
      out.push(
        `${p.name}: ${s.pointsWon} pts, ${s.hits} returns, ${errorSummary(s)}, ` +
          `avg swing ${avgSwingSpeed(s).toFixed(1)} m/s${sig ? `, favours the ${sig}` : ''}`,
      );
    }
    out.push(
      `Longest rally ${this.stats.longestRally} shots ` +
        `(${(this.stats.longestRallyMs / 1000).toFixed(1)}s), ` +
        `${this.stats.totalShots} shots total`,
    );
    return out;
  }
}

// ── Salience. Set it honestly: a routine rally hit must never trigger speech. ──

function salienceForHit(shot: Shot, quality: number, rally: number): number {
  let s = 0.05;
  if (shot.type === 'smash') s = 0.6;
  else if (shot.type === 'lob') s = 0.3;
  else if (shot.type === 'dink') s = 0.22;
  else if (shot.type === 'drive') s = 0.18;
  if (quality > 0.9) s += 0.12;
  if (rally >= 8) s += 0.08;
  return clamp01(s);
}

function saliencForPoint(rally: number, score: ScoreState, longest: boolean): number {
  let s = 0.7;
  if (rally >= 8) s += 0.1;
  if (longest && rally >= 6) s += 0.1;
  if (score.gamePoint) s += 0.15;
  return clamp01(s);
}
