/**
 * The heads-up display.
 *
 * A spectator who has never seen the game must be able to tell who is winning
 * within five seconds, so the scoreboard is large, centred, and marks the server
 * and game point without needing a legend.
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
  const now = performance.now();
  const showBanner = banner && now - banner.at < banner.ttl;
  const showSub = subtitle && now - subtitle.at < 6000;

  return (
    <div className="hud">
      <div className="scoreboard">
        {[0, 1].map((i) => {
          const seat = i as Seat;
          const isYou = lane(ownSeat) === i;
          const serving = score?.server !== undefined && lane(score.server) === i;
          const player = snap?.players.find((p) => lane(p.seat) === i);
          return (
            <div
              key={i}
              className={`side${isYou ? ' you' : ''}${serving ? ' serving' : ''}`}
              style={i === 1 ? { textAlign: 'right' } : undefined}
            >
              <div
                className="name"
                style={i === 1 ? { justifyContent: 'flex-end' } : undefined}
              >
                {i === 0 && (
                  <span className={`dot${player && !player.connected ? ' off' : ''}`} />
                )}
                {names[i] ?? `Player ${i + 1}`}
                {i === 1 && (
                  <span className={`dot${player && !player.connected ? ' off' : ''}`} />
                )}
              </div>
              <div className="pts">{score?.points[i] ?? 0}</div>
            </div>
          );
        })}
        <div className="mid" style={{ order: 1 }}>
          <div className="label">{gamePoint ? 'Match pt' : phaseLabel(phase)}</div>
          <div className={`value${gamePoint ? ' hot' : ''}`}>
            {gamePoint ? '!' : rally > 0 ? `${rally}` : '—'}
          </div>
        </div>
      </div>

      {rally > 3 && phase === 'rally' && (
        <div className="rally-pill">
          rally <strong>{rally}</strong> shots
        </div>
      )}

      {showBanner && (
        <div className="banner flash" key={banner!.at}>
          <div className="big">{banner!.big}</div>
          {banner!.sub && <div className="sub">{banner!.sub}</div>}
        </div>
      )}

      {showSub && (
        <div className="subtitle">
          <span className="who">Commentary</span>
          {subtitle!.text}
        </div>
      )}

      <div className="corner">
        <span className={`chip${conn !== 'open' ? ' bad' : ''}`}>
          {conn === 'open' ? 'online' : conn}
        </span>
        <span className={`chip${rtt > 160 ? ' warn' : ''}`}>{Math.round(rtt)} ms</span>
        {client.snapshots.depth < 2 && <span className="chip warn">buffering</span>}
        {muted && <span className="chip warn">muted</span>}
      </div>
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'serve':
      return 'To serve';
    case 'rally':
      return 'Rally';
    case 'point':
      return 'Point';
    case 'paused':
      return 'Paused';
    case 'gameover':
      return 'Final';
    default:
      return 'Ready';
  }
}
