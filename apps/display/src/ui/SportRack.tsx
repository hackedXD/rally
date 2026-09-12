/**
 * The rack: choosing what to play.
 *
 * Nothing here covers the court. The sport's name is stencilled across the
 * playing surface at the scale a sponsor's name is painted on a real one, and
 * moving along the rack re-stripes the actual 3D court behind it — lines redraw,
 * the paint fields change, the net moves. That is the whole idea of the screen:
 * you are not picking from a menu of pictures, you are standing in front of the
 * court you are about to play on and sliding to the next one.
 *
 * The sport is set locally the moment you move and pushed to the server on a
 * short debounce. Without the optimistic half, every step of the carousel would
 * wait a round trip before the court repainted, which is exactly long enough to
 * feel broken; without the debounce, scrubbing the rack would send a message per
 * frame.
 */

import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import type { SportId } from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import { LOOKS } from '../scene/court.js';
import { COURTS, targetScore } from '../scene/courts.js';
import { useGame } from '../store/useGame.js';
import { ChevronLeft, ChevronRight } from './icons.jsx';

interface Props {
  client: RallyClient;
  onTakeCourt: () => void;
}

/** How long the rack sits still before the choice is sent to the room. */
const COMMIT_MS = 180;
/** A drag shorter than this is a tap on the court, not a move along the rack. */
const SWIPE_PX = 56;

export function SportRack({ client, onTakeCourt }: Props) {
  const sports = useGame((s) => s.sports);
  const sport = useGame((s) => s.sport);
  const room = useGame((s) => s.room);
  const conn = useGame((s) => s.conn);
  const setSport = useGame((s) => s.setSport);

  const host = Boolean(room?.host);
  const index = Math.max(0, sports.findIndex((s) => s.id === sport));
  const current = sports[index] ?? null;
  const commit = useRef(0);

  /**
   * Move to a sport. Repaints the court immediately and tells the room shortly
   * afterwards; the server's answer arrives as an ordinary room update and
   * agrees with what is already on screen.
   */
  const choose = useCallback(
    (id: SportId) => {
      if (!host || id === sport) return;
      const meta = sports.find((s) => s.id === id);
      if (!meta?.playable) return;
      setSport(id);
      window.clearTimeout(commit.current);
      commit.current = window.setTimeout(() => client.selectSport(id), COMMIT_MS);
    },
    [client, host, setSport, sport, sports],
  );

  /** Step along the rack, skipping anything that is only an interface stub. */
  const step = useCallback(
    (dir: -1 | 1) => {
      if (!sports.length) return;
      for (let i = 1; i <= sports.length; i++) {
        const next = sports[(index + dir * i + sports.length * i) % sports.length];
        if (next?.playable) {
          choose(next.id);
          return;
        }
      }
    },
    [choose, index, sports],
  );

  useEffect(() => () => window.clearTimeout(commit.current), []);

  // Arrow keys move the rack. Never while a name is being typed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  // Dragging across the court moves the rack, because on a touchscreen display
  // that is the only gesture anybody tries.
  const dragFrom = useRef<number | null>(null);
  const onPointerDown = (e: React.PointerEvent): void => {
    dragFrom.current = e.clientX;
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null) return;
    const dx = e.clientX - from;
    if (Math.abs(dx) >= SWIPE_PX) step(dx > 0 ? -1 : 1);
  };

  const court = current ? COURTS[current.id] : null;
  const look = LOOKS[(current?.id ?? 'pickleball') as SportId];
  const neighbours = {
    prev: sports.length > 1 ? sports[(index - 1 + sports.length) % sports.length] : null,
    next: sports.length > 1 ? sports[(index + 1) % sports.length] : null,
  };
  const stub = Boolean(current && !current.playable);

  return (
    <div
      className="rack"
      style={
        {
          '--on-ground': look.groundInk,
          '--on-surface': look.surfaceInk,
          '--ground': look.surround,
        } as CSSProperties
      }
    >
      <div className="rack-head">
        <div className="wordmark">Rally</div>

        {/* Where you are in the rack. In the head rather than over the court:
            the court runs to the bottom of the frame, so down there these bars
            sit on the green at 1.67:1, and up here on the apron they read at
            7.30:1 without laying a panel over the playing surface. */}
        <div className="rack-markers" role="tablist" aria-label="Sports">
          {sports.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === sport}
              aria-label={s.playable ? s.displayName : `${s.displayName} — interface stub`}
              className={`${s.id === sport ? 'on' : ''}${s.playable ? '' : ' stub'}`}
              disabled={!host || !s.playable}
              onClick={() => choose(s.id)}
            />
          ))}
        </div>
        <div className="chip">{conn === 'open' ? `Room ${room?.code ?? '····'}` : conn}</div>
      </div>

      {/* The courts either side, cropping in at both edges so the rack reads as
          a row you are standing in front of. Positioned against the frame, not
          the headline — the headline is transformed, which would make it their
          containing block and push them off screen. Decorative; the markers
          above carry the same names accessibly. */}
      {(['prev', 'next'] as const).map((side) => {
        const n = neighbours[side];
        if (!n) return null;
        const l = LOOKS[n.id as SportId];
        return (
          <div
            key={side}
            className={`rack-neighbour ${side}`}
            aria-hidden="true"
            style={{ background: l.surface, color: l.surfaceInk } as CSSProperties}
          >
            {n.displayName}
          </div>
        );
      })}

      <div className="rack-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <button
          className="rack-arrow"
          onClick={() => step(-1)}
          disabled={!host || sports.length < 2}
          aria-label="Previous sport"
        >
          <ChevronLeft />
        </button>

        <div className="rack-title">
          {/* The courts either side, running off both edges of the frame. Purely
              decorative: the markers below carry the same names accessibly. */}
          {/* Keyed on the sport so the stencil is re-laid rather than re-flowed:
              the name arriving is the same moment the court finishes re-striping. */}
          <h1 className={`rack-name${stub ? ' stub' : ''}`} key={current?.id ?? 'none'}>
            {current?.displayName ?? 'Connecting'}
          </h1>
          <p className="rack-sub">
            {stub
              ? 'A compiling interface stub, not a playable sport — it is listed here because pretending otherwise would be worse.'
              : (current?.tagline ??
                'Finding the server. The court appears as soon as there is a room to put it in.')}
          </p>
        </div>

        <button
          className="rack-arrow"
          onClick={() => step(1)}
          disabled={!host || sports.length < 2}
          aria-label="Next sport"
        >
          <ChevronRight />
        </button>
      </div>

      <div className="rack-foot">
        {court && current ? (
          <dl className="ticket">
            <div>
              <dt>Court</dt>
              <dd>
                {court.length} × {court.width} m
              </dd>
            </div>
            <div>
              <dt>Net</dt>
              <dd>{court.netHeight > 0 ? `${court.netHeight} m` : 'None'}</dd>
            </div>
            {court.nonVolleyZone > 0 && (
              <div>
                <dt>{current.id === 'badminton' ? 'Service' : 'Kitchen'}</dt>
                <dd>{court.nonVolleyZone} m</dd>
              </div>
            )}
            <div>
              <dt>First to</dt>
              <dd>{targetScore(current.id)}, win by 2</dd>
            </div>
          </dl>
        ) : (
          <div />
        )}

        <button className="primary" onClick={onTakeCourt} disabled={stub || !room}>
          {host ? 'Take the court' : 'To the court'}
        </button>
      </div>
    </div>
  );
}
