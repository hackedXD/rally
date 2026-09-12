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
import { COURTS } from './scene/courts.js';
import { feel } from './store/feel.js';
import { useGame } from './store/useGame.js';
import { EndCard } from './ui/EndCard.jsx';
import { Hud } from './ui/Hud.jsx';
import { Lobby } from './ui/Lobby.jsx';
import { TunePanel } from './ui/TunePanel.jsx';
import { VirtualPanel } from './ui/VirtualPanel.jsx';

export function App() {
  const store = useGame();
  const [virtualState, setVirtualState] = useState<VirtualState | null>(null);
  const virtual = useRef<VirtualController | null>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);

  const client = useMemo(() => {
    const joinCode = new URLSearchParams(location.search).get('room');
    const c = new RallyClient(defaultWsUrl(), {
      onConn: (state) => useGame.getState().setConn(state),
      onRoom: (room: RoomView) => useGame.getState().setRoom(room),
      onMatchStart: (sport, names) => {
        const g = useGame.getState();
        g.setNames(names);
        g.setSport(sport);
        g.setScreen('playing');
        g.showBanner(`${names[0]} vs ${names[1]}`, 'First to 7, win by 2', 2400);
        feel.reset();
        audio.startCrowd();
      },
      onEvent: (e) => handleEvent(e),
      onMatchEnd: (winner, final, summary) => {
        useGame.getState().setResult(winner, final, summary);
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
    c.connect('pickleball', joinCode);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          feel.startReplay(history.slice(-90), last);
        }
        break;
      }
      case 'rally_milestone':
        g.showBanner(`${d.shots} shots`, 'and still going', 1400);
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
    if (ok) client.audioUnlocked();
    return ok;
  }, [client]);

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

  const ownSeat: Seat = store.room?.seat ?? 0;
  const court = COURTS[store.sport as SportId] ?? COURTS.pickleball;
  const playing = store.screen === 'playing' || store.screen === 'over';

  return (
    <div className="stage">
      <div className="canvas-wrap" ref={canvasWrap}>
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{ fov: 35, near: 0.1, far: 200 }}
        >
          <Scene client={client} court={court} sport={store.sport} ownSeat={ownSeat} />
        </Canvas>
      </div>

      {playing && <Hud client={client} ownSeat={ownSeat} />}
      {!playing && <Lobby client={client} onStart={startMatch} onPlayHere={playHere} />}
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
      {virtualState && playing && (
        <VirtualPanel state={virtualState} onServe={() => virtual.current?.serve()} />
      )}
      {store.showTune && <TunePanel client={client} />}
      {store.error && <div className="toast">{store.error}</div>}
    </div>
  );
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
