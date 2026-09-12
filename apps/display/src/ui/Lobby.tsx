/**
 * The lobby.
 *
 * A judge walks up, scans a QR code, and is swinging within thirty seconds — so
 * the QR code is the biggest thing on the screen and everything else is one
 * click.
 *
 * There are three ways to end up with an opponent, and all three live here:
 *
 *   - a bot, one click;
 *   - a second phone scanning this same screen (two people, one room);
 *   - a friend somewhere else opening the invite link on their own screen.
 *
 * The second seat's QR code is shown only while no other display has claimed
 * that seat. Pair tokens are single-use, so the same code advertised in two
 * places fails on whichever scan arrives second — and a QR that "just doesn't
 * work" is the least debuggable failure there is.
 */

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { NAME_MAX, ROOM_ALPHABET, filterName, lane, type SportId } from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import { useGame } from '../store/useGame.js';

interface Props {
  client: RallyClient;
  onStart: () => void;
  onPlayHere: () => void;
  onTutorial: () => void;
}

/** A phone will not grant motion access to a page served over plain HTTP. */
function insecure(url: string): boolean {
  return url.startsWith('http://');
}

/**
 * A QR code that stays square.
 *
 * The bitmap is rendered well above its CSS box: a retina panel and a phone
 * camera both want the extra resolution, and the wrapper does the sizing.
 */
function Qr({ url, size = 512 }: { url: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!url || !canvas) return;
    void QRCode.toCanvas(canvas, url, {
      width: size,
      margin: 1,
      color: { dark: '#06090f', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(() => {
      // The library writes inline `width`/`height` in pixels, and an inline style
      // beats every stylesheet rule. Left alone, the author `max-width` clamps the
      // width while the inline height stands, and the code renders stretched.
      // Clear them and let the square frame do the sizing.
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
    });
  }, [url, size]);

  return (
    <div className="qr-frame">
      <canvas ref={canvasRef} />
    </div>
  );
}

/** Copies to the clipboard and says so, because a silent copy looks broken. */
function CopyButton({ text, label = 'Copy invite link' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      className={copied ? 'copied' : ''}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * Your own name, edited where it is displayed.
 *
 * In place rather than in a settings panel, because the thing being edited is
 * exactly the thing beside it in the seat list — and because a name the
 * commentator is about to say out loud should be read back in the row it will be
 * said from.
 *
 * The draft is local while the field has focus and comes from the server the
 * rest of the time. Both halves matter: without the draft, every keystroke would
 * be overwritten by the last name the server acknowledged, and without the
 * handover the player would never see the server's version of what they typed —
 * which can differ, since two people arriving with one name get one of them
 * suffixed.
 */
function NameField({ client, current }: { client: RallyClient; current: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  /**
   * What was just committed, held until the server answers.
   *
   * Without it the field snaps back to the OLD name for one round trip after
   * you press Enter — brief on a laptop beside the server, a clear "it didn't
   * take" over the internet.
   */
  const [pending, setPending] = useState<string | null>(null);
  const shown = draft ?? pending ?? current;

  // Any change from the server ends the wait, whatever it says. It does not
  // always say what was sent: two people arriving with one name get one of them
  // suffixed, and that is exactly the case the player most needs to see.
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (lastCurrent.current === current) return;
    lastCurrent.current = current;
    setPending(null);
  }, [current]);

  const commit = () => {
    // A field emptied and left empty is not a request to be called "": hand it
    // back the name it had. `saveName` picks the fallback for anything else that
    // sanitises away to nothing.
    if (draft !== null && draft.trim()) setPending(client.setName(draft));
    setDraft(null);
  };

  return (
    <input
      className="name-edit"
      value={shown}
      aria-label="Your name"
      maxLength={NAME_MAX}
      autoComplete="off"
      spellCheck={false}
      title="Your name, as the commentator will say it"
      // Clean as they type rather than on commit, so the cap and the allowed
      // characters are visible facts about the box instead of a surprise rewrite
      // the moment they click away.
      onChange={(e) => setDraft(filterName(e.target.value))}
      onFocus={() => setDraft(current)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function Lobby({ client, onStart, onPlayHere, onTutorial }: Props) {
  const room = useGame((s) => s.room);
  const sport = useGame((s) => s.sport);
  const sports = useGame((s) => s.sports);
  const status = useGame((s) => s.lobbyStatus);
  const screen = useGame((s) => s.screen);
  const conn = useGame((s) => s.conn);
  const [joinCode, setJoinCode] = useState('');

  const preparing = screen === 'preparing';
  const seats = room?.seats ?? [];
  const paired = seats.filter((s) => s.paired).length;

  const mySeat = lane(room?.seat ?? 0);
  const mine = seats[mySeat] ?? null;
  const theirs = seats[1 - mySeat] ?? null;
  /** Their display is here (so no QR for us to show) but no phone on it yet. */
  const waitingOnThem = Boolean(room && !room.otherPairUrl && theirs && !theirs.paired);
  const humanOpponent = Boolean(theirs?.paired && !theirs.bot);
  const startLabel = startLabelFor(preparing, waitingOnThem, Boolean(mine?.paired), Boolean(theirs?.paired));

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
                  className={`sport-btn${room?.sport === s.id ? ' on' : ''}${s.playable ? '' : ' stub'}`}
                  disabled={!s.playable || preparing || !room?.host}
                  onClick={() => client.selectSport(s.id as SportId)}
                  title={
                    !s.playable
                      ? 'Interface stub — see sports/bowling.ts'
                      : room?.host
                        ? s.tagline
                        : 'The player who opened the room picks the sport'
                  }
                >
                  <span className="t">{s.displayName}</span>
                  <span className="d">{s.tagline}</span>
                </button>
              ))}
            </div>

            <div className="seats">
              {seats.map((s) => (
                <div className={`seat${lane(s.seat) === mySeat ? ' you' : ''}`} key={s.seat}>
                  <div className="idx">{s.seat + 1}</div>
                  <div className="who">
                    {lane(s.seat) === mySeat ? (
                      <NameField client={client} current={s.name ?? client.name} />
                    ) : (
                      <div className="n">{s.name ?? (s.paired ? 'Connecting…' : 'Empty seat')}</div>
                    )}
                    <div className="s">
                      {seatStatus(s, lane(s.seat) === mySeat, Boolean(room?.otherPairUrl))}
                    </div>
                  </div>
                  {lane(s.seat) === mySeat && <div className="badge you">you</div>}
                  {s.bot && <div className="badge bot">bot</div>}
                  {s.ready && !s.bot && <div className="badge ready">ready</div>}
                </div>
              ))}
            </div>

            <div className="actions">
              {/*
                * Enabled even with nothing paired: the server fills empty seats
                * with bots, so this always starts something, and the label says
                * exactly what that something is.
                */}
              <button className="primary" onClick={onStart} disabled={preparing || waitingOnThem}>
                {startLabel}
              </button>
              <button onClick={onPlayHere} disabled={preparing}>
                Play here (mouse)
              </button>
              <button onClick={() => client.addBot(0.55)} disabled={preparing || paired === 2}>
                Add bot
              </button>
              {/*
                * First time here? This is the button. It pairs whatever you have
                * — a phone if one is on your seat, the mouse if not — puts a weak
                * bot opposite, and coaches you through a real match.
                */}
              <button onClick={onTutorial} disabled={preparing}>
                Tutorial
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

            {room && (
              <div className="invite">
                <h3>Play a human</h3>
                <p className="invite-lead">
                  {humanOpponent
                    ? `${theirs?.name ?? 'Your opponent'} is in. Once both phones are connected the match starts itself.`
                    : room.otherPairUrl
                      ? `Hand seat ${2 - mySeat}’s code to somebody standing next to you, or send the link to somebody who is not.`
                      : `Seat ${2 - mySeat} is open on another screen — they pair their own phone from there.`}
                </p>

                <div className="invite-row">
                  <div className="invite-code">
                    <span className="lab">Room</span>
                    <b>{room.code}</b>
                  </div>
                  <CopyButton text={room.joinUrl} />
                </div>
                <div className="url">{room.joinUrl}</div>

                <form
                  className="join-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (joinCode.length === 4) client.joinRoom(joinCode);
                  }}
                >
                  <label htmlFor="joincode">Or join their room</label>
                  <input
                    id="joincode"
                    value={joinCode}
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="ABCD"
                    maxLength={4}
                    onChange={(e) =>
                      setJoinCode(
                        [...e.target.value.toUpperCase()]
                          .filter((c) => ROOM_ALPHABET.includes(c))
                          .join('')
                          .slice(0, 4),
                      )
                    }
                  />
                  <button type="submit" disabled={joinCode.length !== 4 || joinCode === room.code}>
                    Join
                  </button>
                </form>
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
                {/*
                  * Table tennis is a different game and needs a different sentence.
                  * Everywhere else you are auto-positioned onto the ball and the
                  * only question is timing — which is exactly what the ring
                  * teaches. Here you have to put the bat where the ball is, and the
                  * wing you play it with counts.
                  */}
                {sport === 'tabletennis' ? (
                  <>
                    <li>
                      The bat goes where you point the phone. Tilt to reach across
                      and up; a ball on your backhand side needs a backhand.
                    </li>
                    <li>
                      Brush up the back of the ball for topspin, cut down it for
                      backspin. Both bend the flight, and both are worth learning.
                    </li>
                    <li>
                      Real rules: 11 points, win by 2. <kbd>V</kbd> switches between
                      standing at the table and the wide view, <kbd>M</kbd> mutes the
                      commentator, <kbd>T</kbd> opens the tuning panel.
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      The ring on the court closes at the moment to hit. A thinner
                      ring means a harder ball.
                    </li>
                    <li>
                      Rally scoring to 7, win by 2. <kbd>M</kbd> mutes the
                      commentator, <kbd>T</kbd> opens the tuning panel.
                    </li>
                  </>
                )}
              </ol>
            </div>
          </div>

          <div className="qr-panel">
            {room?.pairUrl ? (
              <>
                <div className="qr-card">
                  <div className="qr-title">Your phone</div>
                  <Qr url={room.pairUrl} />
                  <div className="code">{room.code}</div>
                  <div className="hint">
                    Seat {(room.seat ?? 0) + 1} · scan with your phone camera
                  </div>
                </div>

                {/* Once that seat has a phone on it the code only says SEAT_TAKEN. */}
                {room.otherPairUrl && !theirs?.paired && (
                  <div className="qr-card second">
                    <div className="qr-title">Second player’s phone</div>
                    <Qr url={room.otherPairUrl} size={384} />
                    <div className="hint">
                      Seat {(1 - mySeat) + 1} · a second phone scanning this screen
                      plays from here, on this court.
                    </div>
                  </div>
                )}

                {insecure(room.pairUrl) && (
                  <div className="warn-note">
                    This link is plain HTTP, so the phone will load but cannot use
                    its motion sensors — iOS grants those only over HTTPS. Run{' '}
                    <code>npm run tunnel</code> and set <code>RALLY_PUBLIC_ORIGIN</code>,
                    or use <b>Play here</b>.
                  </div>
                )}
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

/**
 * What pressing Start actually does, said out loud.
 *
 * Any seat with no phone on it gets a bot — including your own. That is the right
 * default (it is how you watch a demo) and exactly the wrong thing to discover
 * after pressing a button labelled "Start match".
 */
function startLabelFor(
  preparing: boolean,
  waitingOnThem: boolean,
  youArePaired: boolean,
  theyArePaired: boolean,
): string {
  if (preparing) return 'Preparing…';
  if (waitingOnThem) return 'Waiting for them…';
  if (youArePaired) return theyArePaired ? 'Start match' : 'Start vs bot';
  return theyArePaired ? 'Start — a bot plays your seat' : 'Watch two bots';
}

/** One line under a seat's name saying what that seat is waiting for. */
function seatStatus(
  s: { seat: number; paired: boolean; bot: boolean; connected: boolean },
  isYou: boolean,
  weShowItsCode: boolean,
): string {
  if (s.bot) return 'Built-in opponent';
  if (s.paired) return s.connected ? 'Phone connected' : 'Phone dropped — waiting';
  if (isYou) return 'Scan your code, or play from this machine';
  // Their seat. If we are not the screen showing its code, somebody else's is —
  // which is exactly what has happened once a friend opens the invite link.
  return weShowItsCode
    ? `Open — scan seat ${s.seat + 1}’s code, or invite a friend`
    : 'Someone is here, connecting a phone…';
}
