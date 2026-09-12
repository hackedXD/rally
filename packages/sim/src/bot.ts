/**
 * The built-in opponent.
 *
 * A bot is just a controller that happens to run in-process: it reads the same
 * telegraph the display renders and emits the same `SwingInput` a phone does.
 * That is deliberate — it means the bot exercises the exact strike path a human
 * does, so it cannot accidentally be tuned against a different code path.
 *
 * Pure, like the rest of this package: randomness is injected, time is a
 * parameter.
 */

import type { CourtSpec, MatchPhase, Millis, Seat, StrikeTelegraph, SwingInput, Vec3 } from '@rally/protocol';
import {
  TUNING,
  clamp,
  clamp01,
  lerp,
  otherSeat,
  qFromUnitZTo,
  rotateAboutAxis,
  seatSign,
  vnorm,
} from '@rally/protocol';
import type { Rng } from './rng.js';

export interface BotView {
  phase: MatchPhase;
  telegraph: StrikeTelegraph | null;
  serverSeat: Seat;
  court: CourtSpec;
  /** Contact point the bot is aiming from. */
  contact: Vec3 | null;
  /** Height of the incoming ball at contact — gates the smash. */
  contactHeight: number;
  /** 0..1 difficulty of the incoming ball, from the telegraph. */
  difficulty: number;
  /** The match's strike window, ms. Sport-specific, so it is passed in. */
  windowMs: number;
}

type Intent = 'smash' | 'drive' | 'dink' | 'lob' | 'rally';

const INTENTS: Record<Intent, { speed: number; elev: number }> = {
  smash: { speed: 9.2, elev: -0.36 },
  drive: { speed: 7.6, elev: 0.04 },
  dink: { speed: 2.3, elev: 0.3 },
  lob: { speed: 4.6, elev: 0.58 },
  rally: { speed: 5.4, elev: 0.2 },
};

export class Bot {
  /** 0 = helpless, 1 = frame-perfect. */
  skill: number;

  private plannedFor: Millis | null = null;
  private swingAt: Millis = 0;
  private planned: { intent: Intent; aimX: number; deliberateMiss: boolean } | null = null;
  private serveAt: Millis | null = null;

  constructor(
    readonly seat: Seat,
    private readonly rng: Rng,
    skill = TUNING.bot.skill,
  ) {
    this.skill = clamp01(skill);
  }

  setSkill(skill: number): void {
    this.skill = clamp01(skill);
  }

  /** Called once per tick. Returns a swing to apply, or null to keep waiting. */
  update(t: Millis, view: BotView): SwingInput | null {
    if (view.phase === 'serve') {
      this.plannedFor = null;
      if (view.serverSeat !== this.seat) {
        this.serveAt = null;
        return null;
      }
      if (this.serveAt === null) {
        this.serveAt = t + this.rng.range(700, 1500);
        return null;
      }
      if (t < this.serveAt) return null;
      this.serveAt = null;
      return this.serve(t, view);
    }
    this.serveAt = null;

    if (view.phase !== 'rally') return null;
    const tel = view.telegraph;
    if (!tel || tel.seat !== this.seat || !view.contact) return null;

    // One plan per telegraph. tIdeal never moves, so this is a stable key.
    if (this.plannedFor !== tel.tIdeal) {
      this.plannedFor = tel.tIdeal;
      this.planned = this.plan(view);
      // A hard ball is timed worse, not just met with a tighter window. Without
      // this the bot is immune to the difficulty system a human is subject to.
      const jitter =
        TUNING.bot.timingJitterMs * (1 - this.skill) * (1 + view.difficulty * 1.6);
      const bias = TUNING.bot.timingBiasMs;
      const miss = this.planned.deliberateMiss
        ? (this.rng.next() < 0.5 ? -1 : 1) * (view.windowMs + this.rng.range(40, 160))
        : 0;
      this.swingAt = tel.tIdeal + bias + this.rng.gauss(jitter) + miss;
    }

    if (t < this.swingAt) return null;
    this.plannedFor = null; // consume
    return this.swing(t, view, this.planned!);
  }

  // ── Planning ────────────────────────────────────────────────────────────────

  private plan(view: BotView): { intent: Intent; aimX: number; deliberateMiss: boolean } {
    const deliberateMiss = this.rng.next() < TUNING.bot.whiffChance * (1 - this.skill);
    const netTop = view.court.netHeight + view.court.tableHeight;
    const canSmash = view.contactHeight > netTop + 0.5;
    const aggressive = this.rng.next() < TUNING.bot.aggression * (0.4 + this.skill * 0.6);

    let intent: Intent;
    if (canSmash && aggressive) intent = 'smash';
    else if (aggressive) intent = 'drive';
    else {
      const roll = this.rng.next();
      intent = roll < 0.18 ? 'dink' : roll < 0.3 ? 'lob' : 'rally';
    }

    // Aim away from where the opponent is standing, more accurately at high skill.
    const halfWidth = view.court.width / 2;
    const spread = lerp(0.25, 0.85, this.skill);
    const aimX = clamp(this.rng.spread(halfWidth * spread), -halfWidth + 0.3, halfWidth - 0.3);
    return { intent, aimX, deliberateMiss };
  }

  private swing(
    t: Millis,
    view: BotView,
    plan: { intent: Intent; aimX: number },
  ): SwingInput {
    const base = INTENTS[plan.intent];
    const contact = view.contact!;
    const toward = -seatSign(this.seat);
    const depth = plan.intent === 'dink' ? 0.22 : plan.intent === 'lob' ? 0.9 : 0.68;
    const target: Vec3 = [plan.aimX, 0, toward * (view.court.length / 2) * depth];

    let aim = vnorm([
      target[0] - contact[0],
      Math.hypot(target[0] - contact[0], target[2] - contact[2]) * 0.22,
      target[2] - contact[2],
    ]);
    // Aim error shrinks with skill. Rotate about a random axis so the error is
    // not biased in one direction the player could learn to exploit.
    const errRad = (1 - this.skill) * 0.55 * this.rng.next() * (1 + view.difficulty);
    if (errRad > 1e-3) {
      const axis = vnorm([this.rng.spread(1), this.rng.spread(1), this.rng.spread(1)]);
      aim = vnorm(rotateAboutAxis(aim, axis, errRad));
    }

    const elev = base.elev + this.rng.spread(0.06);
    const horiz = Math.hypot(aim[0], aim[2]) || 1;
    const dir: Vec3 = [
      (aim[0] / horiz) * Math.cos(elev),
      Math.sin(elev),
      (aim[2] / horiz) * Math.cos(elev),
    ];

    return {
      speed: Math.max(0.5, base.speed * this.rng.range(0.9, 1.1) * lerp(0.78, 1.06, this.skill)),
      dir,
      q: qFromUnitZTo(aim),
      elev,
      ctPeak: t,
    };
  }

  private serve(t: Millis, view: BotView): SwingInput {
    const toward = -seatSign(this.seat);
    const aim = vnorm([this.rng.spread(0.35), 0.3, toward]);
    return {
      speed: this.rng.range(4.2, 5.8),
      dir: aim,
      q: qFromUnitZTo(aim),
      elev: 0.3,
      ctPeak: t,
    };
  }

  /** Reset between points so a stale plan cannot leak into the next rally. */
  reset(): void {
    this.plannedFor = null;
    this.planned = null;
    this.serveAt = null;
  }

  get opponent(): Seat {
    return otherSeat(this.seat);
  }
}
