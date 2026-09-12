/**
 * The heads-up display.
 *
 * Court-side signage: a painted plate hanging off the top edge, two halves in
 * the colours of the two sides of the net, with the score stencilled at a size
 * that reads from the back of a room. A spectator who has never seen the game
 * must be able to tell who is winning within five seconds, so the plate marks
 * the server and match point without needing a legend.
 */

import { useEffect, useRef, useState } from 'react';
import { lane, type Seat } from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import { useGame } from '../store/useGame.js';

interface Props {
  client: RallyClient;
  ownSeat: Seat;
}

export function Hud({ client, ownSeat }: Props) {
  const names = useGame((s) => s.names);
  const subtitle = useGame((s) => s.subtitle);
  const banner = useGame((s) => s.banner);
  const muted = useGame((s) => s.muted);
  const rtt = useGame((s) => s.rtt);
  const conn = useGame((s) => s.conn);
  const [, force] = useState(0);
  const frame = useRef(0);

  // The scoreboard reads the snapshot buffer, which lives outside React. Poll it
  // at a low rate rather than re-rendering the tree on every network frame.
  useEffect(() => {
    const tick = () => {
      force((n) => (n + 1) % 1000);
      frame.current = window.setTimeout(tick, 90);
    };
    tick();
    return () => window.clearTimeout(frame.current);
  }, []);

  const snap = client.snapshots.latest;
  const score = snap?.score;
  const phase = snap?.phase ?? 'lobby';
  const rally = snap?.rally ?? 0;
  const gamePoint = score?.gamePoint ?? false;
  // Between points, and at the start of one: the beat where both bats have to
  // come up. Missing `ready` is an older replay, where nothing was ever waiting.
  const waiting = (phase === 'serve' || phase === 'point') && snap?.ready !== undefined;
  const now = performance.now();
  const showBanner = banner && now - banner.at < banner.ttl;
  const showSub = subtitle && now - subtitle.at < 6000;

  const side = (i: 0 | 1) => {
    const isYou = lane(ownSeat) === i;
    const serving = score?.server !== undefined && lane(score.server) === i;
    const player = snap?.players.find((p) => lane(p.seat) === i);
    const dropped = player && !player.connected;
    return (
      <div
        key={i}
        className={`side${i === 1 ? ' two' : ''}${isYou ? ' you' : ''}${serving ? ' serving' : ''}`}
      >
        <span className={`kit${isYou ? '' : ' them'}`} aria-hidden="true" />
        <div className="nm">{names[i] ?? `Player ${i + 1}`}</div>
        {/* A dropped phone, marked on the plate rather than in a legend. */}
        {dropped && <span className="off" title="Phone dropped" />}
        {/* Who the serve is waiting on. Unlit is the seat that has not put its
            bat up yet, which is the only thing stopping the next point. */}
        {waiting && (
          <span
            className={`lamp${snap!.ready![i] ? ' on' : ''}`}
            title={snap!.ready![i] ? 'Ready' : 'Waiting for them to ready up'}
          />
        )}
        <div className="pts">{score?.points[i] ?? 0}</div>
      </div>
    );
  };

  return (
    <div className="hud">
      <div className="scorebug">
        {side(0)}
        <div className={`mid${gamePoint ? ' hot' : ''}`}>
          <div className="v">{gamePoint ? 'Match' : rally > 0 ? rally : '—'}</div>
          <div className="k">{gamePoint ? 'point' : phaseLabel(phase, rally)}</div>
        </div>
        {side(1)}
      </div>

      {rally > 3 && phase === 'rally' && <div className="rally-tag">{rally} shots</div>}

      {showBanner && (
        <div className="banner flash" key={banner!.at}>
          <div className="big">{banner!.big}</div>
          {banner!.sub && <div className="sub">{banner!.sub}</div>}
        </div>
      )}

      {/* The courtside board. The commentator is the only thing that ever
          appears on it, so it needs no label saying whose voice this is. */}
      {showSub && <div className="callboard">{subtitle!.text}</div>}

      <div className="chips">
        <span className={`chip${conn !== 'open' ? ' bad' : ''}`}>
          {conn === 'open' ? 'Online' : conn}
        </span>
        <span className={`chip${rtt > 160 ? ' warn' : ''}`}>{Math.round(rtt)} ms</span>
        {client.snapshots.depth < 2 && <span className="chip warn">Buffering</span>}
        {muted && <span className="chip warn">Muted</span>}
      </div>
    </div>
  );
}

function phaseLabel(phase: string, rally: number): string {
  switch (phase) {
    case 'serve':
      return 'to serve';
    case 'rally':
      // The cell above it is the shot count, and "1 shots" is the kind of thing
      // a spectator reads once and stops trusting the scoreboard over.
      return rally === 1 ? 'shot' : 'shots';
    case 'point':
      return 'point';
    case 'paused':
      return 'paused';
    case 'gameover':
      return 'final';
    default:
      return 'ready';
  }
}
