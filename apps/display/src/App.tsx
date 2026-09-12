/**
 * The display application.
 *
 * Wires the socket, the audio engine, the scene and the UI together, and owns the
 * few pieces of glue that genuinely need to see all of them: audio unlocking,
 * event-to-feel translation, and the keyboard shortcuts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import {
  TUNING,
  lane,
  type GameEvent,
  type Seat,
  type ShotType,
  type SportId,
  type Vec3,
} from '@rally/protocol';
import { audio } from './audio/engine.js';
import { RallyClient, defaultWsUrl, type RoomView } from './net/client.js';
import { VirtualController, type VirtualState } from './net/virtual.js';
import { Scene } from './scene/Scene.jsx';
import { PingPongScene } from './scene/PingPongScene.jsx';
import type { PpViewName } from './scene/pingpong.js';
import { COURTS } from './scene/courts.js';
import { feel } from './store/feel.js';
import { useGame } from './store/useGame.js';
import { EndCard } from './ui/EndCard.jsx';
import { Hud } from './ui/Hud.jsx';
import { Lobby } from './ui/Lobby.jsx';
import { TimingRing } from './ui/TimingRing.jsx';
import { Tutorial } from './ui/Tutorial.jsx';
import { TunePanel } from './ui/TunePanel.jsx';
import { VirtualPanel } from './ui/VirtualPanel.jsx';

export function App() {
  const store = useGame();
  const [virtualState, setVirtualState] = useState<VirtualState | null>(null);
  const virtual = useRef<VirtualController | null>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);
  /**
   * Table tennis framing, remembered across reloads.
   *
   * First person is the default and the one the game is designed around; the
   * wide view is for a screen somebody is watching rather than playing on. Only
   * this sport has the choice — the others are already framed from a broadcast
   * position, because at 13 m that is the only framing that works.
   */
  const [ppView, setPpView] = useState<PpViewName>(() => {
    try {
      return localStorage.getItem('rally.ppview') === 'wide' ? 'wide' : 'first';
    } catch {
      return 'first';
    }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'v' && e.key !== 'V') return;
      // Never while typing a name into the lobby.
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      setPpView((v) => {
        const next = v === 'first' ? 'wide' : 'first';
        try {
          localStorage.setItem('rally.ppview', next);
        } catch {
          /* private mode */
        }
        return next;
      });
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  /**
   * One client, constructed but NOT connected here.
   *
   * StrictMode runs a component body twice on mount, so a `useMemo` that opens a
   * socket opens two and only ever returns one of them. The orphan is invisible
   * and unreachable — no effect can clean it up — but it is a real display in a
   * real seat, and with `?room=` both of them race for the two seats of the room
   * you were invited to: one wins, the other is told the room is full, and the
   * one the scene actually reads may be the loser. Connecting from an effect,
   * which React pairs with a cleanup, keeps exactly one socket alive.
   */
  const client = useMemo(() => {
    const c = new RallyClient(defaultWsUrl(), {
      onConn: (state) => useGame.getState().setConn(state),
      onRoom: (room: RoomView) => {
        useGame.getState().setRoom(room);
        rememberRoom(room.code);
      },
      onMatchStart: (sport, names) => {
        const g = useGame.getState();
        g.setNames(names);
        g.setSport(sport);
        g.setScreen('playing');
        // Table tennis scores the real game. Every other sport here plays
        // rally-to-7, which is the locked scoring decision for the shared engine.
        const target = sport === 'tabletennis' ? 11 : 7;
        g.showBanner(`${names[0]} vs ${names[1]}`, `First to ${target}, win by 2`, 2400);
        feel.reset();
        audio.setSport(sport);
        audio.startCrowd();
      },
      onEvent: (e) => handleEvent(e),
      onMatchEnd: (winner, final, summary) => {
        useGame.getState().setResult(winner, final, summary);
        // The coach stops when the match does, or its card sits over the end
        // card telling somebody to win a point that is no longer available.
        useGame.getState().setTutorial(false);
        feel.cancelReplay();
      },
      onLobbyStatus: (text, progress, done) => {
        const g = useGame.getState();
        g.setLobbyStatus(text, progress, done);
        if (!done && g.screen === 'lobby') g.setScreen('preparing');
      },
      onTuning: (values) => useGame.getState().setTuning(values),
      onError: (code, message) => {
        useGame.getState().setError(`${code}: ${message}`);
        setTimeout(() => useGame.getState().setError(null), 5000);
      },
    });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    client.connect('pickleball', new URLSearchParams(location.search).get('room'));
    return () => client.close();
  }, [client]);

  // Subtitles come from the audio engine, which is the thing that knows when a
  // line actually starts playing rather than when it was scheduled.
  useEffect(() => {
    audio.onSubtitle = (text) => useGame.getState().setSubtitle(text);
  }, []);

  // Network readout.
  useEffect(() => {
    const id = setInterval(
      () => useGame.getState().setNet(client.clock.rtt, client.clock.offset),
      600,
    );
    return () => clearInterval(id);
  }, [client]);

  /**
   * Translate game events into feel. This is the only place the two meet, and
   * keeping it in one function is what stops screen shake ending up scattered
   * across five components.
   */
  const handleEvent = useCallback((e: GameEvent) => {
    const g = useGame.getState();
    g.pushEvent(e);
    const d = e.data;

    switch (e.type) {
      case 'serve':
      case 'hit': {
        const shot = (d.shot as ShotType) ?? 'serve';
        const speed = Number(d.speed) || 6;
        const strength = Math.min(1, speed / TUNING.shot.maxReturn);
        const contact = contactPoint(e);
        feel.hit(strength, contact, shot);
        audio.sfxPlay(shot, 0.6 + strength * 0.6);
        break;
      }
      case 'whiff':
        audio.sfxPlay('whiff', 0.8);
        break;
      case 'bounce':
        audio.sfxPlay('bounce', 0.5);
        break;
      case 'net':
        audio.sfxPlay('net', 1);
        feel.hit(0.35, [Number(d.x) || 0, Number(d.height) || 0.8, 0], 'rally');
        break;
      case 'out':
        audio.sfxPlay('out', 0.7);
        break;
      case 'point': {
        audio.sfxPlay('point', 1);
        audio.crowdReact(Math.min(1, Number(d.rallyLength) / 10));
        g.showBanner(
          `${d.winnerName}`,
          `${d.scoreAfter}   ·   ${d.rallyLength} shots`,
          Math.max(1500, TUNING.match.pointPauseMs - 300),
        );
        // The winning-shot replay. The ball history already exists for lag
        // compensation; replaying it at 0.35x with a swooping camera is the
        // highest crowd reaction per line of code in the whole project.
        const history = client.snapshots.ballHistory;
        if (Number(d.rallyLength) >= 3 && history.length > 10) {
          const last = history.at(-1)!.p;
          // The winning shot, not the last three seconds: at 0.35x even a short
          // clip fills the pause between points.
          feel.startReplay(history.slice(-26), last);
        }
        break;
      }
      case 'rally_milestone':
        // No banner: this fires DURING a rally, and a full-screen overlay across
        // the court at shot six is worse than useless. The rally pill under the
        // scoreboard already reports it.
        break;
      case 'streak':
        g.showBanner(`${d.length} in a row`, '', 1400);
        break;
      case 'comeback':
        g.showBanner('Comeback', `from ${d.deficit} down`, 1800);
        break;
      case 'game_point':
        g.showBanner('Match point', '', 1800);
        break;
      default:
        break;
    }
  }, [client]);

  // ── Audio unlocking ─────────────────────────────────────────────────────────
  // Browsers will not let you play audio without a user gesture, and this failure
  // appears only on the demo machine, at the worst moment.
  const unlockAudio = useCallback(async () => {
    const ok = await audio.unlock();
    useGame.getState().setAudioReady(ok);
    if (!ok) return false;
    client.audioUnlocked();
    // A match already under way has passed the point where the crowd would have
    // been started, so start it now rather than leaving an empty stadium for the
    // rest of the game.
    if (useGame.getState().screen === 'playing') audio.startCrowd();
    return true;
  }, [client]);

  /**
   * Unlock on the first gesture anywhere on the page.
   *
   * Audio needs a user gesture, and the Start button used to be the only thing
   * that supplied one. In a two-phone match nobody ever touches the display —
   * both players pair from their phones and the match starts itself — so waiting
   * for that button means the whole game is silent. Any click or key will do.
   */
  const audioReady = store.audioReady;
  useEffect(() => {
    if (audioReady) return;
    const onGesture = (): void => void unlockAudio();
    window.addEventListener('pointerdown', onGesture, { capture: true });
    window.addEventListener('keydown', onGesture, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', onGesture, { capture: true });
      window.removeEventListener('keydown', onGesture, { capture: true });
    };
  }, [audioReady, unlockAudio]);

  const startMatch = useCallback(() => {
    // The synchronous part of unlocking is what needs the user gesture, and it
    // has already happened by the time this returns a promise — so start the
    // match immediately rather than waiting on audio that may never resume. A
    // silent demo is bad; a demo that will not start is worse.
    void unlockAudio();
    client.start();
  }, [client, unlockAudio]);

  const playHere = useCallback(() => {
    void unlockAudio();
    const room = useGame.getState().room;
    if (!room || virtual.current) return;
    // A real name rather than "You": the commentator says this out loud, and
    // "You takes it" is not a sentence.
    const vc = new VirtualController(
      defaultWsUrl(),
      room.code,
      room.seat,
      room.pairToken,
      localPlayerName(),
    );
    vc.onChange = setVirtualState;
    vc.connect();
    virtual.current = vc;
    useGame.getState().toggleVirtual();
  }, [unlockAudio]);

  // ── Input ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === 'm') {
        const next = !useGame.getState().muted;
        useGame.getState().setMuted(next);
        audio.setMuted(next);
        client.setMuted(next);
      } else if (key === 't') {
        useGame.getState().toggleTune();
      } else if (key === ' ') {
        e.preventDefault();
        virtual.current?.beginCharge();
      } else if (key === 'enter') {
        virtual.current?.serve();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') virtual.current?.releaseCharge();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [client]);

  useEffect(() => {
    const el = canvasWrap.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      virtual.current?.setAim(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (e.clientY - r.top) / r.height,
      );
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      virtual.current?.beginCharge();
    };
    const up = () => virtual.current?.releaseCharge();
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  useEffect(() => () => virtual.current?.disconnect(), []);

  /**
   * Start the coached match.
   *
   * Everything here is an ordinary lobby action — pair something to your seat,
   * put a weak bot opposite, start. The tutorial itself is drawn on top and
   * changes nothing about the match, which is what stops it from teaching a game
   * nobody afterwards gets to play.
   */
  /*
   * Stable, and it has to be. The overlay runs its checklist on an interval
   * keyed to its props, and App re-renders on every event, ping and subtitle —
   * an inline arrow here hands it a new identity several times a second, which
   * tears the interval down before it can ever fire. The tutorial then shows
   * step one forever while the player does everything right.
   */
  const endTutorial = useCallback(() => useGame.getState().setTutorial(false), []);

  const startTutorial = useCallback(() => {
    void unlockAudio();
    const g = useGame.getState();
    // A phone already paired stays the controller; without one the mouse takes
    // the seat, so pressing Tutorial always produces something playable rather
    // than an instruction to go and find a phone first.
    if (!g.room?.seats.some((s) => lane(s.seat) === lane(g.room?.seat ?? 0) && s.paired)) {
      playHere();
    }
    // 0.25, not the usual 0.55. A tutorial you lose every point of teaches
    // nothing but that the game is hard.
    client.addBot(0.25);
    g.setTutorial(true);
    client.start();
  }, [client, unlockAudio, playHere]);


  // Moving to a friend's room leaves the mouse controller paired to the old one,
  // holding a seat in a room nobody is looking at any more.
  const roomCode = store.room?.code;
  useEffect(() => {
    const vc = virtual.current;
    if (!vc || !roomCode || vc.room === roomCode) return;
    vc.disconnect();
    virtual.current = null;
    setVirtualState(null);
  }, [roomCode]);

  const ownSeat: Seat = store.room?.seat ?? 0;
  const court = COURTS[store.sport as SportId] ?? COURTS.pickleball;
  const playing = store.screen === 'playing' || store.screen === 'over';
  // Table tennis is drawn by its own renderer — see PingPongScene for why.
  const pingpong = store.sport === 'tabletennis';

  return (
    <div className={`stage${virtualState && playing ? ' has-vc' : ''}`}>
      <div className="canvas-wrap" ref={canvasWrap}>
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{ fov: 35, near: 0.1, far: 200 }}
        >
          {pingpong ? (
            <PingPongScene client={client} ownSeat={ownSeat} view={ppView} />
          ) : (
            <Scene client={client} court={court} sport={store.sport} ownSeat={ownSeat} />
          )}
        </Canvas>
      </div>

      {playing && <Hud client={client} ownSeat={ownSeat} />}
      {playing && store.tutorial && (
        <Tutorial client={client} ownSeat={ownSeat} sport={store.sport} onDone={endTutorial} />
      )}
      {playing && pingpong && <TimingRing client={client} ownSeat={ownSeat} />}
      {!playing && (
        <Lobby
          client={client}
          onStart={startMatch}
          onPlayHere={playHere}
          onTutorial={startTutorial}
        />
      )}
      {store.screen === 'over' && (
        <EndCard
          ownSeat={ownSeat}
          onRematch={() => {
            useGame.getState().reset();
            useGame.getState().setScreen('playing');
            feel.reset();
            client.rematch();
          }}
          onLobby={() => {
            useGame.getState().reset();
            feel.reset();
          }}
        />
      )}
      {playing && !store.audioReady && (
        // Nobody has touched this screen, so the browser will not let a sound out
        // of it. Say so, rather than being mysteriously silent.
        <button className="sound-prompt" onClick={() => void unlockAudio()}>
          Click anywhere for sound
        </button>
      )}
      {virtualState && playing && (
        <VirtualPanel state={virtualState} onServe={() => virtual.current?.serve()} />
      )}
      {store.showTune && <TunePanel client={client} />}
      {store.error && <div className="toast">{store.error}</div>}
    </div>
  );
}

/**
 * Keep the room code in the address bar.
 *
 * Reloading mid-lobby is common — someone denies motion access and starts over —
 * and without this the display silently opens a brand new room while the friend
 * it invited is still sitting in the old one.
 */
function rememberRoom(code: string): void {
  const url = new URL(location.href);
  if (url.searchParams.get('room') === code) return;
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);
}

/**
 * A stable, speakable name for whoever is playing from this machine. Remembered,
 * so a rematch does not rename them mid-session.
 */
function localPlayerName(): string {
  const stored = localStorage.getItem('rally.name');
  if (stored) return stored;
  const adjectives = ['Swift', 'Lucky', 'Bold', 'Calm', 'Sly', 'Keen', 'Wild'];
  const nouns = ['Otter', 'Falcon', 'Comet', 'Pike', 'Ember', 'Moth', 'Fox'];
  const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
  const name = `${pick(adjectives)} ${pick(nouns)}`;
  localStorage.setItem('rally.name', name);
  return name;
}

/** Where a hit happened, for the impact ring and the shake. */
function contactPoint(e: GameEvent): Vec3 {
  const z = Number(e.data.contactZ);
  const y = Number(e.data.contactHeight);
  return [0, Number.isFinite(y) ? y : 0.8, Number.isFinite(z) ? z : 0];
}

export { lane };
