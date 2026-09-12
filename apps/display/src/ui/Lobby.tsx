/**
 * The lobby.
 *
 * A judge walks up, scans a QR code, and is swinging within thirty seconds — so
 * the QR code is the biggest thing on the screen and everything else is one
 * click.
 */

import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import type { SportId } from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import { useGame } from '../store/useGame.js';

interface Props {
  client: RallyClient;
  onStart: () => void;
  onPlayHere: () => void;
}

export function Lobby({ client, onStart, onPlayHere }: Props) {
  const room = useGame((s) => s.room);
  const sports = useGame((s) => s.sports);
  const status = useGame((s) => s.lobbyStatus);
  const screen = useGame((s) => s.screen);
  const conn = useGame((s) => s.conn);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!room?.pairUrl || !canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, room.pairUrl, {
      width: 460,
      margin: 1,
      color: { dark: '#06090f', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }, [room?.pairUrl]);

  const preparing = screen === 'preparing';
  const seats = room?.seats ?? [];
  const paired = seats.filter((s) => s.paired).length;

  return (
    <div className="lobby">
      <div className="lobby-card">
        <h1>
          Rally<span className="dot">.</span>
        </h1>
        <p className="tagline">
          Motion-controlled swing sports, played across the internet, with a
          commentator who is watching.
        </p>

        <div className="lobby-grid">
          <div>
            <div className="sport-row">
              {sports.map((s) => (
                <button
                  key={s.id}
                  className={`sport-btn${room?.sport === s.id ? ' on' : ''}`}
                  disabled={!s.playable || preparing || !room?.host}
                  onClick={() => client.selectSport(s.id as SportId)}
                  title={s.playable ? s.tagline : 'Interface stub — see sports/bowling.ts'}
                >
                  <span className="t">{s.displayName}</span>
                  <span className="d">{s.tagline}</span>
                </button>
              ))}
            </div>

            <div className="seats">
              {seats.map((s) => (
                <div className="seat" key={s.seat}>
                  <div className="idx">{s.seat + 1}</div>
                  <div className="who">
                    <div className="n">{s.name ?? (s.paired ? 'Connecting…' : 'Empty seat')}</div>
                    <div className="s">
                      {s.bot
                        ? 'Built-in opponent'
                        : s.paired
                          ? s.connected
                            ? 'Phone connected'
                            : 'Phone dropped — waiting'
                          : 'Scan the QR code, or play from this machine'}
                    </div>
                  </div>
                  {s.bot && <div className="badge bot">bot</div>}
                  {s.ready && !s.bot && <div className="badge ready">ready</div>}
                </div>
              ))}
            </div>

            <div className="actions">
              <button className="primary" onClick={onStart} disabled={preparing || paired === 0}>
                {preparing ? 'Preparing…' : 'Start match'}
              </button>
              <button onClick={onPlayHere} disabled={preparing}>
                Play here (mouse)
              </button>
              <button onClick={() => client.addBot(0.55)} disabled={preparing}>
                Add opponent
              </button>
              <div className="spacer" />
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                {conn === 'open' ? `room ${room?.code ?? '····'}` : conn}
              </span>
            </div>

            {preparing && (
              <div className="prep">
                <div className="bar">
                  <i style={{ width: `${Math.round(status.progress * 100)}%` }} />
                </div>
                <div className="txt">{status.text || 'Warming up…'}</div>
              </div>
            )}

            <div className="howto">
              <h3>How to play</h3>
              <ol>
                <li>
                  Scan the code with a phone, tap <b>Tap to play</b>, and hold the
                  phone like a paddle pointing at this screen.
                </li>
                <li>
                  No phone? Hit <b>Play here</b> — move the mouse to aim, hold{' '}
                  <kbd>click</kbd> or <kbd>space</kbd> to wind up, release to swing.
                </li>
                <li>
                  The ring on the court closes at the moment to hit. A thinner ring
                  means a harder ball.
                </li>
                <li>
                  Rally scoring to 7, win by 2. <kbd>M</kbd> mutes the commentator,{' '}
                  <kbd>T</kbd> opens the tuning panel.
                </li>
              </ol>
            </div>
          </div>

          <div className="qr-panel">
            {room?.pairUrl ? (
              <>
                <canvas ref={canvasRef} />
                <div className="code">{room.code}</div>
                <div className="hint">
                  Seat {(room.seat ?? 0) + 1} · scan with your phone camera
                </div>
                <div className="url">{room.pairUrl}</div>
              </>
            ) : (
              <div className="hint">Connecting to the server…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
