/**
 * The tutorial overlay.
 *
 * Reads the same snapshot buffer the scoreboard does and the same event stream
 * the commentator does, and ticks a checklist against them. It sends nothing and
 * changes nothing about the match — a player who ignores it entirely is playing
 * exactly the game a player who follows it is.
 *
 * See `./tutorial.ts` for the steps and why it coaches over a real match.
 */

import { useEffect, useRef, useState } from 'react';
import type { GameEvent, Quat, Seat, SportId } from '@rally/protocol';
import { lane } from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import { useGame } from '../store/useGame.js';
import { MIN_DWELL_S, isMine, tutorialSteps, type StepContext } from './tutorial.js';

interface Props {
  client: RallyClient;
  ownSeat: Seat;
  sport: SportId;
  onDone: () => void;
}

/** How often the checklist is re-evaluated. It is a coach, not a physics loop. */
const TICK_MS = 120;

export function Tutorial({ client, ownSeat, sport, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [, force] = useState(0);
  const events = useGame((s) => s.recent);

  const steps = useRef(tutorialSteps(sport));
  const stepStart = useRef(performance.now());
  const seenAt = useRef(0);
  /**
   * What this seat has done since the tutorial began. A set of event types, not
   * a list of events: the checklist only ever asks whether a thing has happened,
   * so keeping the events themselves would be an unbounded log nobody reads.
   */
  const mine = useRef(new Set<GameEvent['type']>());
  const whiffs = useRef(0);
  const bestRally = useRef(0);
  const anchor = useRef<Quat | null>(null);
  const aimed = useRef(0);
  const finished = useRef(false);
  /*
   * Held in a ref so the interval below does not depend on it.
   *
   * Belt and braces with the stable callback the parent now passes: a timer that
   * restarts whenever a prop identity changes is a timer that can starve, and
   * the failure is silent — the checklist simply stops advancing.
   */
  const done = useRef(onDone);
  done.current = onDone;

  /*
   * Drain the store's rolling event window into the cumulative set.
   *
   * Driven by the store rather than by the interval below, because `recent`
   * keeps only the last dozen events: a poll slower than the game can produce
   * them would miss the one it was waiting for. This runs on every change, so it
   * cannot.
   */
  useEffect(() => {
    for (const e of events) {
      if (e.t <= seenAt.current) continue;
      seenAt.current = e.t;
      if (!isMine(e, ownSeat)) continue;
      mine.current.add(e.type);
      if (e.type === 'whiff') whiffs.current++;
    }
  }, [events, ownSeat]);

  useEffect(() => {
    const timer = setInterval(() => {
      const snap = client.snapshots.latest;
      const me = snap?.players.find((p) => lane(p.seat) === lane(ownSeat));
      if (me) {
        // The one signal no event carries: "you moved your hand" is not
        // something the simulation reports, because from its side nothing
        // happened. Orientation rather than position — see `StepContext.aimed`.
        if (!anchor.current) anchor.current = [...me.paddleQ] as Quat;
        else {
          const a = anchor.current;
          const q = me.paddleQ;
          // Angle between two unit quaternions. `abs` because q and -q are the
          // same rotation, and without it a sign flip reads as a half turn.
          const dot = Math.abs(a[0] * q[0] + a[1] * q[1] + a[2] * q[2] + a[3] * q[3]);
          aimed.current = Math.max(aimed.current, 2 * Math.acos(Math.min(1, dot)));
        }
      }

      bestRally.current = Math.max(bestRally.current, snap?.rally ?? 0);

      const cur = steps.current[step];
      if (!cur || finished.current) return;
      const elapsed = (performance.now() - stepStart.current) / 1000;
      const ctx: StepContext = {
        mine: mine.current,
        phase: snap?.phase ?? 'lobby',
        bestRally: bestRally.current,
        aimed: aimed.current,
        whiffs: whiffs.current,
        elapsed,
      };
      // The dwell floor, so a cumulative checklist cannot tick three boxes in one
      // frame and show none of them long enough to read.
      if (elapsed < MIN_DWELL_S || !cur.done(ctx)) {
        force((n) => (n + 1) % 1000);
        return;
      }
      stepStart.current = performance.now();
      if (step + 1 >= steps.current.length) {
        finished.current = true;
        done.current();
      } else {
        setStep(step + 1);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [client, ownSeat, step]);

  const cur = steps.current[step];
  if (!cur) return null;
  const detail =
    typeof cur.detail === 'function'
      ? cur.detail({
          mine: mine.current,
          phase: 'rally',
          bestRally: bestRally.current,
          aimed: aimed.current,
          whiffs: whiffs.current,
          elapsed: (performance.now() - stepStart.current) / 1000,
        })
      : cur.detail;

  return (
    <div className="tutorial">
      <div className="tut-card">
        <div className="tut-head">
          <span className="tut-label">Tutorial</span>
          <span className="tut-count">
            {step + 1} / {steps.current.length}
          </span>
        </div>
        <div className="tut-title">{cur.title}</div>
        {detail && <div className="tut-detail">{detail}</div>}
        <div className="tut-dots">
          {steps.current.map((s, i) => (
            <i key={s.id} className={i < step ? 'done' : i === step ? 'now' : ''} />
          ))}
        </div>
        <button className="tut-skip" onClick={() => done.current()}>
          Skip
        </button>
      </div>
    </div>
  );
}
