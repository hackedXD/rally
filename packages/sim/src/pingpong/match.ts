/**
 * The table tennis engine, as something Rally's server can run.
 *
 * `./rules.ts` is the transplanted game and knows nothing about Rally. This is
 * the adapter: it owns the clock, turns phone poses into a bat position, drives
 * the bots, and translates the rules' own little event vocabulary into the
 * `GameEvent`s the commentary director reads. Everything Rally asks of a match —
 * snapshots, telegraph, stats, a summary at the end — is produced from here.
 *
 * Why an adapter and not another `SportModule`: a sport module can only change
 * numbers, and this sport changes the simulation. Spin, a bat with a real
 * position, a blade you have to put on the ball, a serve you toss and strike —
 * none of those are values `Match` could be handed. Pickleball and badminton run
 * the original engine untouched; only table tennis comes through here.
 */

import {
  TUNING,
  eventId,
  lane,
  r,
  rv,
  vlen,
  type GameEvent,
  type MatchPhase,
  type Millis,
  type PlayerAnim,
  type PlayerState,
  type Quat,
  type ScoreState,
  type Seat,
  type Snapshot,
  type StrikeTelegraph,
  type SwingInput,
  type Vec3,
} from '@rally/protocol';
import type { BallBody } from '../physics.js';
import type { ContactPrediction } from '../predict.js';
import { resolveParams, type SimParams } from '../params.js';
import { makeRng, type Rng } from '../rng.js';
import { StallWatch } from '../stall.js';
import type { DerivedState, SportModule } from '../sport.js';
import { cloneStats, emptyStats, seatOf, timingAdvice, type MatchStats } from '../stats.js';
import type { Simulation, TickInput } from '../match.js';
import { newPpBot, stepPpBot, type PpBotState } from './bot.js';
import {
  AIM,
  PADDLE,
  REACH_Z,
  rightOf,
  TABLE,
  WIN_SCORE,
  dirOf,
  homeZ,
} from './constants.js';
import type { PpEvent } from './physics.js';
import {
  NEUTRAL,
  aimEase,
  aimFromPose,
  contactTiming,
  applySwing as applyPpSwing,
  canHit,
  newMatch,
  paddleFrame,
  paddlePos,
  restartPoint,
  setHand,
  setPose,
  tick as ppTick,
  toPpHandVel,
  toPpOmega,
  toPpPose,
  type PpMatchState,
  type PpSwing,
} from './rules.js';

const LANE = [0, 1] as const;
/**
 * How long a stroke animation runs. Matches the display's own stroke length —
 * shorter and the bat snaps back mid-swing, longer and it is still following
 * through when the next ball arrives.
 */
const SWING_ANIM_MS = 260;
/** Rounding, so a snapshot is not full of sixteen-digit floats. */
const R = 3;

export interface PingPongOptions {
  sport: SportModule;
  seed: number;
  names: [string, string];
  bots?: [boolean, boolean];
  firstServer?: 0 | 1;
}

interface BotSlot {
  on: boolean;
  skill: number;
  state: PpBotState;
}

export class PingPongMatch implements Simulation {
  /** This engine steps its own bots — they play the rules directly. */
  readonly drivesOwnBots = true;

  phase: MatchPhase = 'lobby';
  rally = 0;

  private sport: SportModule;
  private state: PpMatchState;
  private players: PlayerState[];
  private params: SimParams;
  private rng: Rng;
  private seed: number;

  private t: Millis = 0;
  private tick = 0;
  private phaseT: Millis = 0;
  private rallyStartedAt: Millis = 0;

  private bots: BotSlot[] = [
    { on: false, skill: TUNING.bot.skill, state: newPpBot() },
    { on: false, skill: TUNING.bot.skill, state: newPpBot() },
  ];

  /** Hysteretic choice of which bat face is toward the table, per seat. */
  private face: [number, number] = [0, 0];
  /** Depth lean from the phone, per seat. */
  private reach: [number, number] = [0, 0];
  /**
   * Cross-body travel already applied for the stroke in progress, per seat.
   * Held so the slide is by the DELTA each tick rather than by the total, which
   * would re-apply the whole reach on every one.
   */
  private sway: [number, number] = [0, 0];

  private events: GameEvent[] = [];
  private stats: MatchStats;
  private prevDerived: DerivedState | null = null;
  private history: { t: Millis; p: Vec3; v: Vec3 }[] = [];
  private matchWinner: Seat | null = null;
  private telegraph: StrikeTelegraph | null = null;
  private prediction: ContactPrediction | null = null;
  private difficulty = 0;
  /** Speed of the shot that ended the rally, for the point event. */
  private lastShotSpeed = 0;
  /** Speed the ball was travelling at when it was struck, and what it became. */
  private arrivalSpeed = 0;
  private lastShot = 'rally';
  /**
   * When each seat's current animation ends.
   *
   * The display drives its own procedural stroke off `anim === 'swing'` — a bat
   * that teleports to the ball never looks like it hit anything — so a contact
   * that never sets this is a contact the player watches happen with a
   * completely still bat.
   */
  private animUntil: [Millis, Millis] = [0, 0];
  /** Notices when a serve is not coming. See `StallWatch`. */
  private stall = new StallWatch();

  constructor(opts: PingPongOptions) {
    this.sport = opts.sport;
    this.seed = opts.seed;
    this.rng = makeRng(opts.seed);
    this.params = resolveParams(opts.sport);
    this.state = newMatch(opts.firstServer ?? 0);
    this.stats = emptyStats(0);
    this.players = LANE.map((seat) => ({
      seat: seat as Seat,
      name: opts.names[seat],
      p: [0, TABLE.TOP + 0.22, homeZ(seat)] as Vec3,
      paddleQ: [0, 0, 0, 1] as Quat,
      anim: 'idle' as const,
      connected: true,
      bot: opts.bots?.[seat] ?? false,
    }));
    for (const seat of LANE) this.bots[seat].on = opts.bots?.[seat] ?? false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  refreshParams(): void {
    this.params = resolveParams(this.sport);
  }

  reset(sport: SportModule): void {
    this.sport = sport;
    this.params = resolveParams(sport);
    this.rng = makeRng(this.seed);
    this.state = newMatch(this.state.server);
    this.stats = emptyStats(this.t);
    this.history = [];
    this.events = [];
    this.prevDerived = null;
    this.matchWinner = null;
    this.telegraph = null;
    this.prediction = null;
    this.rally = 0;
    this.phase = 'lobby';
    this.stall.reset();
    this.face = [0, 0];
    this.reach = [0, 0];
    this.sway = [0, 0];
    for (const seat of LANE) this.bots[seat].state = newPpBot();
  }

  setNames(names: [string, string]): void {
    for (const seat of LANE) this.players[seat].name = names[seat];
  }

  setBot(seat: Seat, bot: boolean, skill = TUNING.bot.skill): void {
    const i = lane(seat);
    this.players[i].bot = bot;
    this.bots[i].on = bot;
    this.bots[i].skill = skill;
    if (!bot) this.bots[i].state = newPpBot();
    // A bot has no phone, so it has no tracked bat: without clearing the hand it
    // would keep the last human's bat position and auto-positioning would never
    // kick in, which reads as a bot that refuses to move.
    if (bot) {
      this.state = setHand(this.state, i, null);
      this.state = setPose(this.state, i, null);
    }
  }

  start(t: Millis): void {
    this.t = t;
    this.phaseT = t;
    this.rallyStartedAt = t;
    this.stats = emptyStats(t);
    this.state = restartPoint(newMatch(this.state.server));
    this.phase = 'serve';
    this.emit({
      type: 'match_start',
      data: {
        sport: this.sport.id,
        sportName: this.sport.displayName,
        blurb: this.sport.persona.blurb,
        players: this.players.map((p) => p.name).join(' vs '),
        pointsToWin: WIN_SCORE,
      },
      salience: 0.9,
      priority: 2,
    });
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  step(dt: number, input: TickInput): Snapshot {
    this.t = input.t;
    this.tick++;

    if (this.phase === 'lobby' || this.phase === 'gameover') return this.snapshot();
    if (input.paused) {
      this.phase = 'paused';
      return this.snapshot();
    }
    if (this.phase === 'paused') this.phase = this.state.phase === 'rally' ? 'rally' : 'serve';

    this.readPoses(input);

    // Between points. Both the dead time and whatever the commentator still has
    // to say — the hold is a deadline handed in, never a thing this file knows
    // the meaning of.
    if (this.state.phase === 'point') {
      const since = this.t - this.phaseT;
      // A hold is a request to wait, not a veto. The director caps what it asks
      // for, but a deadline that kept sliding would stop the match between
      // points and leave nothing on screen moving — so the wait is bounded here
      // as well, at the level that owns "the game must keep going".
      const held =
        this.t < (input.holdUntil ?? 0) &&
        since < TUNING.match.pointPauseMs + TUNING.commentary.holdPlayMaxMs;
      if (since >= TUNING.match.pointPauseMs && !held) {
        this.state = restartPoint(this.state);
        this.beginServe();
      }
      return this.snapshot();
    }

    if (this.state.phase === 'over') {
      this.phase = 'gameover';
      return this.snapshot();
    }

    this.expireAnims();
    this.checkStall();
    // Nobody serves until both bats are ready, the bot included: it has no
    // gyroscope to re-centre, but a bot that served into a player still squaring
    // up would defeat the entire point of the gate. Its stroke state is reset
    // while it waits so it does not resume a swing it began before the gate
    // closed. `advance` still runs, so the bats keep tracking the phones.
    const gateOpen =
      !input.serveGate || this.t - this.phaseT > TUNING.serve.autoServeAfterMs;
    if (!gateOpen && this.state.phase === 'serve') {
      for (const seat of LANE) this.bots[seat].state = newPpBot();
    } else {
      this.stepBots();
      this.autoServe();
    }
    this.advance();
    this.retelegraph();
    this.recordHistory();
    this.classify();

    return this.snapshot();
  }

  /**
   * Phone pose -> where the bat is.
   *
   * Rotation and position come from the same sensor, and a stroke is mostly
   * rotation — so through a swing the bat would slide across the table on its
   * own. Worse, the wrist turns the opposite way on a forehand and a backhand,
   * so it slides opposite ways: one wing works and the other does not. Freeze
   * the position for the length of the stroke; the pose stays live, so the shot
   * is unaffected.
   */
  private readPoses(input: TickInput): void {
    for (const seat of LANE) {
      this.players[seat].connected = this.bots[seat].on || input.connected[seat] !== false;
      const raw = input.pose[seat];
      const q = raw ? toPpPose(raw) : undefined;
      if (this.bots[seat].on || !q) {
        // No phone on this seat: the bat auto-positions onto the ball, which is
        // what the rules assume when there is no tracked hand.
        if (this.state.hands[seat]) this.state = setHand(this.state, seat, null);
        if (this.state.poses[seat]) this.state = setPose(this.state, seat, null);
        continue;
      }
      this.state = setPose(this.state, seat, q);

      const z = input.reach?.[seat];
      if (Number.isFinite(z)) {
        this.reach[seat] = Math.max(-REACH_Z, Math.min(REACH_Z, z as number));
      }
      const prev = this.state.hands[seat];
      if (input.holdPose?.[seat] && prev) {
        // The freeze is right about rotation and wrong about translation.
        //
        // Changing wings is the hand CROSSING THE BODY, and crossing the body
        // turns the wrist fast enough to arm the swing detector on the way over
        // — so freezing everything pinned the bat on the wing being left, and
        // the shot that followed came back 'reach' or 'wrong wing'. Not a
        // timing skill anyone can learn: the bat stops moving at the exact
        // moment the player is moving it most.
        //
        // So slide by how far the hand actually TRAVELLED. A wrist pivot
        // translates almost nothing and so still moves the bat almost nothing,
        // which is the whole reason the freeze exists and it survives intact.
        //
        // `rightOf`, because `dx` arrives in the PLAYER's frame and hands live
        // in the world's. Same conversion `aimFromPose` does, same one that has
        // been inverted more than once — asserted for both seats.
        const dx = input.sway?.[seat];
        if (Number.isFinite(dx)) {
          const travel = (dx as number) - this.sway[seat];
          this.sway[seat] = dx as number;
          const x = prev.x + travel * rightOf(seat);
          this.state = setHand(this.state, seat, {
            ...prev,
            x: Math.max(-AIM.SPAN_X, Math.min(AIM.SPAN_X, x)),
          });
        }
        continue;
      }
      // Between strokes there is no window to be part-way through.
      this.sway[seat] = 0;

      // Thread the last face back in: the choice is hysteretic, so a bat held
      // edge-on cannot flicker between its two sides — which would read as the
      // bat twitching left and right for no reason at all.
      const want = aimFromPose(seat, q, NEUTRAL, this.face[seat]);
      this.face[seat] = want.face;
      // How far the hand is asking to move decides how hard we chase it: a wrist
      // wobble stays damped, a hand crossing the body to the other wing does
      // not. One rate for both axes, from the combined error, so the bat moves
      // as one thing rather than sliding sideways and then upward.
      const k = prev ? aimEase(Math.hypot(want.x - prev.x, want.y - prev.y)) : 1;
      this.state = setHand(this.state, seat, {
        x: prev ? prev.x + (want.x - prev.x) * k : want.x,
        y: prev ? prev.y + (want.y - prev.y) * k : want.y,
        z: prev ? (prev.z ?? 0) + (this.reach[seat] - (prev.z ?? 0)) * AIM.SMOOTH : this.reach[seat],
      });
    }
  }

  /**
   * Say something when the serve is not coming.
   *
   * Before `autoServe` in the tick, deliberately: the commentator should be the
   * one who notices the wait, not the one explaining a serve the game just
   * played on the player's behalf.
   */
  private checkStall(): void {
    const server = this.state.server;
    // A bot always serves. Remarking on a wait it is about to end reads as the
    // commentator not watching the same match as everyone else.
    if (this.bots[server].on) return;
    const e = this.stall.check({
      t: this.t,
      phaseT: this.phaseT,
      phase: this.phase,
      seat: server as Seat,
      name: this.players[server].name,
    });
    if (e) this.events.push(e);
  }

  /**
   * Serve for a player who has not.
   *
   * The transplanted rules re-toss forever and charge nothing for it — "take as
   * long as you like", which is right for a game running on one laptop in one
   * room. It is not right here: rooms are hosted, and a seat whose player put
   * their phone down wedges a match until the idle reaper gets to it ten minutes
   * later. Every other sport already has this deadline; this one inherits it.
   *
   * Deliberately outranks the commentary hold. A hold is a request to wait; this
   * is the thing that guarantees the match ends either way.
   */
  private autoServe(): void {
    if (this.state.phase !== 'serve') return;
    if (this.t - this.phaseT < TUNING.serve.autoServeAfterMs) return;
    const server = this.state.server;
    if (this.bots[server].on) return; // its own bot will get there
    // Through the same path a player's swing takes, so it cannot produce a serve
    // a player could not have hit. Modest: this is a courtesy, not a free ace.
    this.swing(server, {
      q: [Math.sin(-0.1), 0, 0, Math.cos(-0.1)],
      omega: [(server === 0 ? -1 : 1) * 500, 0, 0],
      vsw: [0, 1.6, -2.2],
    });
  }

  private stepBots(): void {
    for (const seat of LANE) {
      const slot = this.bots[seat];
      if (!slot.on) continue;
      const [next, swing] = stepPpBot(slot.state, this.state, seat, this.rng, slot.skill);
      slot.state = next;
      if (swing) this.swing(seat, swing);
    }
  }

  /** One physics tick, and the rules that fall out of it. */
  private advance(): void {
    const before = this.state;
    const { match, events } = ppTick(this.state);
    this.state = match;
    this.phase = match.phase === 'over' ? 'gameover' : match.phase;

    for (const e of events) this.emitPhysics(e, before);

    // A touch — the ball glancing off a bat nobody swung — is a hit to the rules
    // and produces no swing event, so it is noticed here instead.
    const ev = match.lastEvent;
    if (ev?.type === 'hit' && ev.touch) this.afterHit(ev.player, ev.speed, true);
    if (ev?.type === 'point' || ev?.type === 'gameover') {
      this.awardPoint(ev.player, ev.reason, ev.type === 'gameover');
    }
  }

  private emitPhysics(e: PpEvent, before: PpMatchState): void {
    const owner = before.lastHit;
    if (e.type === 'bounce') {
      this.emit({
        type: 'bounce',
        data: {
          side: e.side ?? 0,
          inBounds: true,
          speed: r(e.speed ?? 0, 1),
          x: r(e.at?.[0] ?? 0, 2),
          z: r(e.at?.[2] ?? 0, 2),
        },
        salience: 0.02,
        priority: 0,
      });
      return;
    }
    if (e.type === 'letcord') {
      // The funniest thing that happens in a match, and the rules do not care —
      // so if the commentator is not told, nobody ever mentions it.
      this.emit({
        type: 'bounce',
        seat: (owner ?? 0) as Seat,
        data: { letcord: true, speed: r(e.speed ?? 0, 1), lucky: true },
        salience: 0.55,
        priority: 2,
      });
      return;
    }
    if (e.type === 'net' && owner !== null) {
      this.emit({
        type: 'net',
        seat: owner as Seat,
        data: {
          seat: owner,
          player: this.players[owner].name,
          speed: r(e.speed ?? 0, 1),
          rallyLength: this.rally,
        },
        salience: 0.45,
        priority: 1,
      });
      seatOf(this.stats, owner as Seat).netErrors++;
    }
    if (e.type === 'floor' && owner !== null && before.bouncesSinceHit === 0) {
      const at = e.at ?? this.state.ball.p;
      this.emit({
        type: 'out',
        seat: owner as Seat,
        data: {
          seat: owner,
          player: this.players[owner].name,
          reason: 'missed the table',
          longByM: r(Math.max(0, Math.abs(at[2]) - TABLE.LEN / 2), 2),
          wideByM: r(Math.max(0, Math.abs(at[0]) - TABLE.WIDTH / 2), 2),
          shot: 'drive',
        },
        salience: 0.45,
        priority: 1,
      });
      seatOf(this.stats, owner as Seat).outErrors++;
    }
  }

  // ── Swings ──────────────────────────────────────────────────────────────────

  /**
   * A swing from a phone.
   *
   * `tServer` is ignored on purpose. Rewinding is how the other sports pay for
   * network delay, because there a strike is a judgement about one instant and
   * being 80 ms late means missing a window. Here a swing is a contact with a
   * bat whose position the server already tracks continuously, and rewinding the
   * whole world to re-run a friction impulse would buy a few centimetres of
   * accuracy for a great deal of machinery. The ball is slow by construction —
   * see GRAVITY — which is what makes that trade affordable.
   */
  applySwing(seat: Seat, swing: SwingInput, _tServer: Millis): void {
    if (this.phase !== 'serve' && this.phase !== 'rally') return;
    const i = lane(seat);
    if (this.bots[i].on) return;
    this.swing(i, toPpSwing(swing));
  }

  private swing(seat: 0 | 1, swing: PpSwing): void {
    const before = this.state;
    const wasServe = before.phase === 'serve';
    this.arrivalSpeed = vlen(before.ball.v);
    const next = applyPpSwing(before, seat, swing);
    if (next === before) return; // the rules refused it; nothing happened

    this.state = next;
    const ev = next.lastEvent;
    const speed = ev?.type === 'hit' ? ev.speed : vlen(next.ball.v);
    // Measured from `before`, which is the only state that can say where the
    // ball was when it met the bat. A serve has no incoming ball to be early on.
    if (!wasServe) {
      const early = contactTiming(before, seat);
      if (early !== null) {
        const st = seatOf(this.stats, seat as Seat);
        st.timingSumMs += early;
        st.timingCount++;
      }
    }
    if (wasServe) this.afterServe(seat, speed);
    else this.afterHit(seat, speed, false);
  }

  private afterServe(seat: 0 | 1, speed: number): void {
    this.setAnim(seat, 'swing', SWING_ANIM_MS);
    this.lastShot = 'serve';
    this.phase = 'rally';
    this.rally = 1;
    this.rallyStartedAt = this.t;
    this.lastShotSpeed = speed;
    const st = seatOf(this.stats, seat as Seat);
    st.serves++;
    st.shots.serve++;
    st.swingCount++;
    st.swingSpeedSum += speed;
    this.stats.rallies++;
    this.stats.totalShots++;
    this.emit({
      type: 'serve',
      seat: seat as Seat,
      data: {
        seat,
        player: this.players[seat].name,
        speed: r(speed, 1),
        score: this.score().points.join('-'),
        serveNumber: st.serves,
      },
      salience: 0.3,
      priority: 1,
    });
  }

  private afterHit(seat: 0 | 1, speed: number, touch: boolean): void {
    // A graze is not a stroke. The ball glanced off a bat nobody swung, so
    // animating a swing would be showing the player a shot they did not play.
    if (!touch) this.setAnim(seat, 'swing', SWING_ANIM_MS);
    this.phase = 'rally';
    this.rally = this.state.rallyHits;
    this.lastShotSpeed = speed;
    const shot = classifyShot(speed, this.state.ball, touch);
    this.lastShot = shot;
    const st = seatOf(this.stats, seat as Seat);
    st.hits++;
    st.shots[shot]++;
    st.swingCount++;
    st.swingSpeedSum += speed;
    this.stats.totalShots++;
    this.emit({
      type: 'hit',
      seat: seat as Seat,
      data: {
        seat,
        player: this.players[seat].name,
        shot,
        speed: r(speed, 1),
        touch,
        spin: r(vlen(this.state.ball.spin), 0),
        topspin: r(this.state.ball.spin[0] * dirOf(seat), 0),
        arrivalSpeed: r(this.arrivalSpeed, 1),
        rallyLength: this.rally,
        contactHeight: r(this.state.ball.p[1], 2),
        difficulty: r(this.difficulty, 2),
      },
      salience: salienceForHit(shot, speed, this.rally, touch),
      priority: shot === 'smash' ? 2 : 1,
    });
  }

  private awardPoint(winner: 0 | 1, reason: string, done: boolean): void {
    const loser: 0 | 1 = winner === 0 ? 1 : 0;
    const before = this.score().points;
    const rallyMs = this.t - this.rallyStartedAt;
    const longest = this.rally > this.stats.longestRally;

    const w = seatOf(this.stats, winner as Seat);
    w.pointsWon++;
    w.pointsInARow++;
    w.bestRun = Math.max(w.bestRun, w.pointsInARow);
    w.longestRally = Math.max(w.longestRally, this.rally);
    seatOf(this.stats, loser as Seat).pointsInARow = 0;
    this.stats.longestRally = Math.max(this.stats.longestRally, this.rally);
    this.stats.longestRallyMs = Math.max(this.stats.longestRallyMs, rallyMs);
    this.stats.biggestLead = Math.max(
      this.stats.biggestLead,
      Math.abs(this.state.score[0] - this.state.score[1]),
    );
    if (this.state.lastHit === winner) w.winners++;

    this.phaseT = this.t;
    this.phase = done ? 'gameover' : 'point';
    if (done) this.matchWinner = winner as Seat;
    this.setAnim(winner, 'celebrate', TUNING.match.pointPauseMs);
    this.setAnim(loser, 'idle', 0);

    this.emit({
      type: 'point',
      seat: winner as Seat,
      data: {
        winner,
        loser,
        winnerName: this.players[winner].name,
        loserName: this.players[loser].name,
        reason,
        rallyLength: this.rally,
        rallyDurationMs: Math.round(rallyMs),
        decidingShot: this.lastShot,
        decidingSpeed: r(this.lastShotSpeed, 1),
        scoreBefore: before.join('-'),
        scoreAfter: this.score().points.join('-'),
        longestRallyOfMatch: longest,
        margin: Math.abs(this.state.score[0] - this.state.score[1]),
        streak: seatOf(this.stats, winner as Seat).pointsInARow,
      },
      salience: saliencForPoint(this.rally, this.score(), longest),
      priority: 3,
    });

    if (done) {
      this.emit({
        type: 'match_end',
        seat: winner as Seat,
        data: {
          winner,
          winnerName: this.players[winner].name,
          final: this.score().points.join('-'),
          longestRally: this.stats.longestRally,
          totalShots: this.stats.totalShots,
        },
        salience: 1,
        priority: 3,
      });
    }
  }

  /** Hold an animation for this seat. `ms` is how long the display has to play it. */
  private setAnim(seat: 0 | 1, anim: PlayerAnim, ms: number): void {
    this.players[seat].anim = anim;
    this.animUntil[seat] = this.t + ms;
  }

  private expireAnims(): void {
    for (const seat of LANE) {
      if (this.players[seat].anim !== 'idle' && this.t >= this.animUntil[seat]) {
        this.players[seat].anim = 'idle';
      }
    }
  }

  private beginServe(): void {
    this.phase = 'serve';
    this.phaseT = this.t;
    this.rally = 0;
    this.rallyStartedAt = this.t;
    for (const seat of LANE) {
      this.bots[seat].state = newPpBot();
      this.players[seat].anim = 'idle';
    }
  }

  // ── Telegraph ───────────────────────────────────────────────────────────────

  /**
   * The timing ring, and the only thing the bots in the OTHER engine read.
   *
   * Derived rather than simulated: the ball has a position and a velocity, and
   * when it will arrive at the receiver's end is arithmetic. Difficulty is pace
   * alone here — there is no "how far did they have to run", because the player
   * moves the bat themselves and being out of position is already its own
   * punishment.
   */
  private retelegraph(): void {
    const ball = this.state.ball;
    const receiver = this.receiverSeat();
    if (receiver === null) {
      this.telegraph = null;
      this.prediction = null;
      return;
    }
    const d = dirOf(receiver);
    const vz = ball.v[2];
    const toward = vz * d < -0.15;
    const dt = toward ? (homeZ(receiver) - ball.p[2]) / vz : -1;
    if (dt < 0 || dt > 2.5) {
      this.telegraph = null;
      this.prediction = null;
      return;
    }
    const at: Vec3 = [
      ball.p[0] + ball.v[0] * dt,
      Math.max(TABLE.TOP, ball.p[1] + ball.v[1] * dt),
      homeZ(receiver),
    ];
    const pace = vlen(ball.v);
    this.difficulty = Math.max(
      0,
      Math.min(1, (pace - PADDLE.MIN_SPEED) / (PADDLE.MAX_SPEED - PADDLE.MIN_SPEED)),
    );
    this.prediction = {
      tIdeal: this.t + dt * 1000,
      p: at,
      v: [...ball.v] as Vec3,
      kind: 'groundstroke',
    };
    this.telegraph = {
      seat: receiver as Seat,
      tIdeal: this.t + dt * 1000,
      p: at,
      open: canHit(this.state, receiver),
      difficulty: this.difficulty,
    };
  }

  /** Whoever the ball is travelling toward, or null when it is going nowhere. */
  private receiverSeat(): 0 | 1 | null {
    if (this.state.phase === 'serve') return this.state.server;
    const vz = this.state.ball.v[2];
    if (Math.abs(vz) < 0.05) return null;
    return vz > 0 ? 1 : 0;
  }

  private recordHistory(): void {
    this.history.push({ t: this.t, p: [...this.state.ball.p] as Vec3, v: [...this.state.ball.v] as Vec3 });
    const cutoff = this.t - 4000;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
  }

  /** State-derived events: milestones, streaks, comebacks, game point. */
  private classify(): void {
    const next: DerivedState = {
      t: this.t,
      phase: this.phase,
      score: this.score(),
      rally: this.rally,
      rallyStartedAt: this.rallyStartedAt,
      stats: this.stats,
    };
    if (this.prevDerived) this.events.push(...this.sport.classifyEvents(this.prevDerived, next));
    this.prevDerived = {
      ...next,
      score: { ...next.score, points: [...next.score.points] as [number, number] },
      stats: cloneStats(this.stats),
    };
  }

  private emit(e: Omit<GameEvent, 'id' | 't'> & { t?: Millis }): void {
    this.events.push({ id: eventId(e.type), t: e.t ?? this.t, ...e } as GameEvent);
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  snapshot(): Snapshot {
    const s = this.state;
    const snap: Snapshot = {
      tick: this.tick,
      t: Math.round(this.t),
      phase: this.phase,
      ball: {
        p: rv(s.ball.p, R),
        v: rv(s.ball.v, 2),
        // Scalar, because that is what the wire carries: topspin positive from
        // the hitter's point of view, normalised into the -1..1 the display
        // already understands. The vector stays on the server, where the only
        // thing that needs it is the physics.
        spin: r(spinScalar(s), 2),
        b: s.bouncesSinceHit,
        owner: s.lastHit as Seat | null,
      },
      players: this.players.map((p) => {
        const seat = lane(p.seat);
        const q = s.poses[seat];
        return {
          seat: p.seat,
          name: p.name,
          // The bat, not a body. This sport draws no player: you are standing at
          // the table holding the thing at `p`, which is the whole framing.
          p: rv(paddlePos(s, seat), R),
          paddleQ: q ? paddleFrame(seat, q).worldQ : uprightQ(seat),
          anim: p.anim,
          connected: p.connected,
          bot: p.bot,
        };
      }),
      score: this.score(),
      rally: this.rally,
      phaseT: Math.round(this.phaseT),
    };
    if (this.telegraph && (this.phase === 'rally' || this.phase === 'serve')) {
      snap.strike = { ...this.telegraph, tIdeal: Math.round(this.telegraph.tIdeal) };
    }
    return snap;
  }

  currentSnapshot(): Snapshot {
    return this.snapshot();
  }

  // ── Introspection ───────────────────────────────────────────────────────────

  private score(): ScoreState {
    const pts = this.state.score;
    const lead = Math.max(pts[0], pts[1]);
    const gamePoint = lead >= WIN_SCORE - 1 && lead - Math.min(pts[0], pts[1]) >= 1;
    return {
      points: [pts[0], pts[1]],
      server: this.state.server as Seat,
      gamePoint,
      gamePointSeat: gamePoint ? ((pts[0] > pts[1] ? 0 : 1) as Seat) : null,
    };
  }

  getStats(): MatchStats {
    return this.stats;
  }

  getScore(): ScoreState {
    return this.score();
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
    const s = this.state;
    return {
      p: [...s.ball.p] as Vec3,
      v: [...s.ball.v] as Vec3,
      spin: spinScalar(s),
      b: s.bouncesSinceHit,
      bounceSide: 0,
    };
  }

  getPlayers(): PlayerState[] {
    return this.players;
  }

  getWinner(): Seat | null {
    return this.matchWinner;
  }

  getHistory(): readonly { t: Millis; p: Vec3; v: Vec3 }[] {
    return this.history;
  }

  summary(): string[] {
    const out: string[] = [];
    for (const p of this.players) {
      const st = seatOf(this.stats, p.seat);
      out.push(
        `${p.name}: ${st.pointsWon} pts, ${st.hits} returns, ` +
          `${st.netErrors} into the net, ${st.outErrors} off the table`,
      );
    }
    out.push(
      `Longest rally ${this.stats.longestRally} shots ` +
        `(${(this.stats.longestRallyMs / 1000).toFixed(1)}s), ` +
        `${this.stats.totalShots} shots total`,
    );
    // The one thing about their own stroke a player cannot feel. Only said when
    // it is big enough to act on — "3 ms early" is noise dressed as coaching.
    for (const p of this.players) {
      const advice = timingAdvice(seatOf(this.stats, p.seat));
      if (advice) out.push(`${p.name}: ${advice}`);
    }
    return out;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A Rally swing, as this engine's rules want it.
 *
 * `vsw` is the hand's own velocity and is what carries both power and direction;
 * Rally's detector reports it split into a unit direction and a peak speed, so
 * it is simply put back together. `omega` is the wrist rotation at peak, which
 * the other sports never needed — a controller that does not send it still
 * plays, on the linear term alone.
 */
export function toPpSwing(s: SwingInput): PpSwing {
  const vsw: Vec3 = s.vsw ?? [s.dir[0] * s.speed, s.dir[1] * s.speed, s.dir[2] * s.speed];
  return {
    q: toPpPose(s.q),
    omega: toPpOmega(s.omega ?? [0, 0, 0]),
    vsw: toPpHandVel(vsw),
  };
}

/**
 * Topspin, from the hitter's point of view, as the single number the wire
 * carries. +1 is heavy topspin, -1 heavy backspin.
 */
function spinScalar(s: PpMatchState): number {
  const hitter = s.lastHit ?? 0;
  return Math.max(-1, Math.min(1, (s.ball.spin[0] * dirOf(hitter)) / 300));
}

/**
 * Bat orientation for a seat with no phone: held upright, facing down the table.
 *
 * The bat model's local +z is the blade normal and local -y is the handle, so
 * "upright, ready" is no rotation at all for seat 0 and a half turn about world
 * up for seat 1, which stands at the other end. Not the flat between-games pose:
 * a bot is playing, and a bat lying face down on the table while it returns your
 * serve reads as the renderer having lost track of it. The display puts it flat
 * when play is not live, which is where that pose belongs.
 */
function uprightQ(seat: 0 | 1): Quat {
  return seat === 0 ? [0, 0, 0, 1] : [0, 1, 0, 0];
}

/**
 * What that shot was.
 *
 * Speed relative to the cap rather than an absolute number, so retuning
 * `PADDLE.MAX_SPEED` cannot silently make the smash bank unreachable — which is
 * exactly what a literal threshold did in the project this came from.
 */
function classifyShot(
  speed: number,
  ball: { v: Vec3; p: Vec3 },
  touch: boolean,
): 'smash' | 'drive' | 'dink' | 'lob' | 'rally' {
  if (touch) return 'rally';
  const frac = speed / PADDLE.MAX_SPEED;
  const rising = ball.v[1] > 1.4;
  if (frac >= 0.86 && !rising) return 'smash';
  if (rising && ball.p[1] > TABLE.TOP + 0.1) return 'lob';
  if (frac <= 0.4) return 'dink';
  if (frac >= 0.6) return 'drive';
  return 'rally';
}

function salienceForHit(shot: string, speed: number, rally: number, touch: boolean): number {
  if (touch) return 0.04;
  let s = 0.05;
  if (shot === 'smash') s = 0.6;
  else if (shot === 'lob') s = 0.3;
  else if (shot === 'dink') s = 0.22;
  else if (shot === 'drive') s = 0.18;
  if (speed > PADDLE.MAX_SPEED * 0.95) s += 0.1;
  if (rally >= 8) s += 0.08;
  return Math.min(1, s);
}

function saliencForPoint(rally: number, score: ScoreState, longest: boolean): number {
  let s = 0.7;
  if (rally >= 8) s += 0.1;
  if (longest && rally >= 6) s += 0.1;
  if (score.gamePoint) s += 0.15;
  return Math.min(1, s);
}
