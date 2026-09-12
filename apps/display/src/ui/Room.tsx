/**
 * The room: two sides of one court.
 *
 * The screen is the court seen from above, split by the net. Each half is a
 * seat, and a seat that nobody is in is not a blank box — it is that half of the
 * court painted unlit, with its own QR code taped where the service line would
 * be. Pairing is therefore the content of the screen rather than a panel beside
 * it, and the code a player scans is inside the half they are about to play in.
 *
 * The second seat's code is shown only while no other display has claimed it.
 * Pair tokens are single-use, so the same code advertised in two places fails on
 * whichever scan arrives second — and a QR that "just doesn't work" is the least
 * debuggable failure there is.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';
import { NAME_MAX, ROOM_ALPHABET, filterName, lane, type SportId } from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import { useGame } from '../store/useGame.js';

interface Props {
  client: RallyClient;
  onStart: () => void;
  onPlayHere: () => void;
  onTutorial: () => void;
  onBackToRack: () => void;
}

/**
 * The pairing address with the token dropped.
 *
 * The debuggable half of a QR that "just doesn't work" is the origin — is it
 * https, is it this machine's LAN address or somebody's localhost. The token is
 * twenty-two characters nobody can read off a screen, and printing it breaks
 * across three lines and buries the part that matters.
 */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
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
      // Ink on tape. A QR wants maximum contrast far more than it wants to match
      // the palette, and a mis-scanned code is the one failure with no recovery.
      color: { dark: '#04143a', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(() => {
      // The library writes inline `width`/`height` in pixels, and an inline style
      // beats every stylesheet rule. Left alone, the author `max-width` clamps the
      // width while the inline height stands, and the code renders stretched.
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
    });
  }, [url, size]);

  return (
    <div className="pair-frame">
      <canvas ref={canvasRef} />
    </div>
  );
}

/** Copies to the clipboard and says so, because a silent copy looks broken. */
function CopyButton({ text }: { text: string }) {
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
      {copied ? 'Copied' : 'Copy invite link'}
    </button>
  );
}

/**
 * Your own name, edited where it is displayed.
 *
 * In place rather than in a settings panel, because the thing being edited is
 * exactly the thing on the half of the court beside it — and because a name the
 * commentator is about to say out loud should be read back where it will be said
 * from.
 *
 * The draft is local while the field has focus and comes from the server the
 * rest of the time. Both halves matter: without the draft, every keystroke would
 * be overwritten by the last name the server acknowledged, and without the
 * handover the player would never see the server's version of what they typed —
 * which can differ, since two people arriving with one name get one suffixed.
 */
function NameField({ client, current }: { client: RallyClient; current: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  /**
   * What was just committed, held until the server answers. Without it the field
   * snaps back to the OLD name for one round trip after Enter — brief on a laptop
   * beside the server, a clear "it didn't take" over the internet.
   */
  const [pending, setPending] = useState<string | null>(null);
  const shown = draft ?? pending ?? current;

  // Any change from the server ends the wait, whatever it says.
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (lastCurrent.current === current) return;
    lastCurrent.current = current;
    setPending(null);
  }, [current]);

  const commit = (): void => {
    // A field emptied and left empty is not a request to be called "".
    if (draft !== null && draft.trim()) setPending(client.setName(draft));
    setDraft(null);
  };

  return (
    <input
      className="player-name"
      value={shown}
      aria-label="Your name"
      maxLength={NAME_MAX}
      autoComplete="off"
      spellCheck={false}
      size={Math.max(4, shown.length || 4)}
      title="Your name, as the commentator will say it"
      // Cleaned as they type, so the cap and the allowed characters are visible
      // facts about the field rather than a surprise rewrite on blur.
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

export function Room({ client, onStart, onPlayHere, onTutorial, onBackToRack }: Props) {
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
  const startLabel = startLabelFor(
    preparing,
    waitingOnThem,
    Boolean(mine?.paired),
    Boolean(theirs?.paired),
  );
  const sportName = sports.find((s) => s.id === sport)?.displayName ?? sport;
  const iAmPaired = Boolean(mine?.paired);

  const half = (side: 'mine' | 'theirs') => {
    const s = side === 'mine' ? mine : theirs;
    if (!s) return null;
    const isYou = side === 'mine';
    const url = isYou ? room?.pairUrl : room?.otherPairUrl;
    // An open seat we can hand a code to. A seat somebody else's display has
    // claimed shows no code, because that display is already showing one.
    const showPair = Boolean(url) && !s.paired && !s.bot;
    // Designed absence: an unclaimed seat is this half of the court painted
    // unlit, showing exactly what will fill it.
    const open = !s.paired && !s.bot;

    return (
      <div className={`half${isYou ? '' : ' away'}${open ? ' open' : ''}`}>
        <div className="half-top">
          <div className="seat-no">{s.seat + 1}</div>
          {/* The kit this seat plays in. The same two colours are on the court,
              so a spectator can map a plate to a player. */}
          <span className={`kit${isYou ? '' : ' them'}`} aria-hidden="true" />
          <div className="half-badges">
            {isYou && <span className="badge">You</span>}
            {s.bot && <span className="badge">Bot</span>}
            {s.ready && !s.bot && <span className="badge live">Ready</span>}
          </div>
        </div>

        <div className="half-body">
          {showPair && url ? (
            <div className="pair">
              <Qr url={url} size={isYou ? 512 : 448} />
              {/* No room code printed under it. The code joins a room from
                  another display; a phone can only ever scan, and offering it a
                  number to type is an invitation to a dead end.

                  The link itself does stay, small and quiet. A QR that "just
                  doesn't work" is the least debuggable failure there is, and the
                  address it encodes is the only thing that makes it one you can
                  actually debug. */}
              <div className="pair-call">Scan to take this side</div>
              <div className="pair-url">{shortUrl(url)}</div>
            </div>
          ) : isYou ? (
            <NameField client={client} current={s.name ?? client.name} />
          ) : (
            <div className="player-name">{s.name ?? (s.paired ? 'Connecting…' : 'Open')}</div>
          )}
        </div>

        <p className="half-status">{seatStatus(s, isYou, Boolean(room?.otherPairUrl))}</p>
      </div>
    );
  };

  return (
    <div className="room">
      <div className="room-head">
        <div className="wordmark">Rally</div>
        <div className="room-sport">
          {sportName}
          {room?.host && (
            <button onClick={onBackToRack} disabled={preparing}>
              Change
            </button>
          )}
        </div>
        <div className="chip">{conn === 'open' ? `Room ${room?.code ?? '····'}` : conn}</div>
      </div>

      <div className="vs">
        {half('mine')}
        <div className="net">
          <div className="net-cord" />
          <div className="net-start">
            {/*
              * Enabled with nothing paired: the server fills empty seats with
              * bots, so this always starts something, and the label says exactly
              * what that something is.
              */}
            <button className="primary" onClick={onStart} disabled={preparing || waitingOnThem}>
              {startLabel}
            </button>
          </div>
          <div className="net-mesh" />
        </div>
        {half('theirs')}
      </div>

      <div className="room-foot">
        {preparing && (
          <div className="prep">
            <div className="prep-bar">
              <i style={{ '--p': status.progress } as CSSProperties} />
            </div>
            <div className="prep-txt">{status.text || 'Warming up…'}</div>
          </div>
        )}

        <div className="room-actions">
          <button onClick={onTutorial} disabled={preparing}>
            Tutorial
          </button>
          <button onClick={onPlayHere} disabled={preparing}>
            Play here (mouse)
          </button>
          <button onClick={() => client.addBot(0.55)} disabled={preparing || paired === 2}>
            Add bot
          </button>
          {/* A way out of a room that has gone wrong — a phone that will not
              pair, a code somebody else is already using — without reloading the
              page and losing the sport you picked. */}
          <button onClick={() => client.newRoom()} disabled={preparing}>
            New room
          </button>
          <div className="spacer" />
          {room && (
            <div className="invite">
              <div className="code-plate">
                <span>Room</span>
                <b>{room.code}</b>
              </div>
              <CopyButton text={room.joinUrl} />
              <form
                className="join"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (joinCode.length === 4) client.joinRoom(joinCode);
                }}
              >
                <input
                  aria-label="Join a room by code"
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
        </div>

        <p className="prep-txt">{howLine(sport as SportId, iAmPaired)}</p>

        {room?.pairUrl && insecure(room.pairUrl) && (
          <p className="warn-note">
            This link is plain HTTP, so the phone will load but cannot use its
            motion sensors — iOS grants those only over HTTPS. Run{' '}
            <code>npm run tunnel</code> and set <code>RALLY_PUBLIC_ORIGIN</code>, or
            use Play here.
          </p>
        )}
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

/** One line under a seat saying what that seat is waiting for. */
function seatStatus(
  s: { seat: number; paired: boolean; bot: boolean; connected: boolean },
  isYou: boolean,
  weShowItsCode: boolean,
): string {
  if (s.bot) return 'Built-in opponent';
  if (s.paired) return s.connected ? 'Phone connected' : 'Phone dropped — waiting';
  if (isYou) return 'Scan with your phone, or play from this machine';
  // Their seat. If we are not the screen showing its code, somebody else's is —
  // which is exactly what has happened once a friend opens the invite link.
  return weShowItsCode
    ? 'Open — scan it, or send the invite link to a friend'
    : 'Someone is here, connecting a phone…';
}

/**
 * The one line of instruction the room owes a first-timer.
 *
 * Which line depends on what they are actually holding: somebody with a phone
 * paired does not need the mouse controls, and table tennis is a different game
 * with a different answer.
 */
function howLine(sport: SportId, paired: boolean): string {
  if (!paired) {
    return 'No phone? Play here — move the mouse to aim, hold click or space to wind up, release to swing, Enter to serve.';
  }
  if (sport === 'tabletennis') {
    return 'The bat goes where you point the phone. Brush up the back of the ball for topspin, cut down it for backspin. M mutes the commentator, V switches the view.';
  }
  return 'Hold the phone like a paddle and swing when the ring on the court closes. A thinner ring means a harder ball. M mutes the commentator.';
}
