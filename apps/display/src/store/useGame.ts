/**
 * UI state only.
 *
 * The snapshot buffer and the feel state deliberately live outside this store —
 * they are written at 30 Hz and read at 60+, and React is the wrong place for
 * either. What lives here is what the DOM actually renders: the lobby, the
 * scoreboard, subtitles, the end card.
 */

import { create } from 'zustand';
import type { GameEvent, Seat, SportId, SportMeta } from '@rally/protocol';
import type { ConnState, RoomView } from '../net/client.js';

export type Screen = 'connecting' | 'lobby' | 'preparing' | 'playing' | 'over';

/**
 * Which of the two lobby screens is up.
 *
 * The rack chooses a sport and re-stripes the live court behind it; the room is
 * the two sides of that court, where phones pair and the match starts. They are
 * separate screens because they ask separate questions, and because a stranger
 * walking up should be looking at one of them, not at both at once.
 */
export type LobbyStep = 'rack' | 'room';

export interface Banner {
  big: string;
  sub: string;
  at: number;
  ttl: number;
}

export interface GameState {
  screen: Screen;
  lobbyStep: LobbyStep;
  conn: ConnState;
  room: RoomView | null;
  sport: SportId;
  sports: SportMeta[];
  names: [string, string];
  lobbyStatus: { text: string; progress: number; done: boolean };
  result: { winner: Seat; final: [number, number]; summary: string[] } | null;
  subtitle: { text: string; at: number } | null;
  banner: Banner | null;
  muted: boolean;
  audioReady: boolean;
  error: string | null;
  showTune: boolean;
  showVirtual: boolean;
  /**
   * Whether the coached overlay is running.
   *
   * Deliberately not a game mode: the match underneath is an ordinary one
   * against a weak bot, and this flag only decides whether anything is drawn on
   * top of it. See `ui/tutorial.ts`.
   */
  tutorial: boolean;
  tuning: Record<string, number>;
  /** Rolling log of the last few events, for the debug overlay. */
  recent: GameEvent[];
  rtt: number;
  offset: number;

  setConn(conn: ConnState): void;
  setRoom(room: RoomView): void;
  setScreen(screen: Screen): void;
  setLobbyStep(step: LobbyStep): void;
  setSport(sport: SportId): void;
  setNames(names: [string, string]): void;
  setLobbyStatus(text: string, progress: number, done: boolean): void;
  setResult(winner: Seat, final: [number, number], summary: string[]): void;
  /** Drop a result without showing one. An abandoned match has no winner. */
  clearResult(): void;
  setSubtitle(text: string): void;
  showBanner(big: string, sub?: string, ttl?: number): void;
  setMuted(muted: boolean): void;
  setAudioReady(ready: boolean): void;
  setError(error: string | null): void;
  toggleTune(): void;
  toggleVirtual(): void;
  setTutorial(on: boolean): void;
  setTuning(values: Record<string, number>): void;
  pushEvent(e: GameEvent): void;
  setNet(rtt: number, offset: number): void;
  reset(): void;
}

export const useGame = create<GameState>((set) => ({
  screen: 'connecting',
  lobbyStep: 'rack',
  conn: 'connecting',
  room: null,
  sport: 'pickleball',
  sports: [],
  names: ['Player 1', 'Player 2'],
  lobbyStatus: { text: '', progress: 0, done: false },
  result: null,
  subtitle: null,
  banner: null,
  muted: false,
  audioReady: false,
  error: null,
  showTune: false,
  showVirtual: false,
  tutorial: false,
  tuning: {},
  recent: [],
  rtt: 0,
  offset: 0,

  setConn: (conn) => set({ conn }),
  setRoom: (room) =>
    set((s) => ({
      room,
      sport: room.sport,
      sports: room.sports.length ? room.sports : s.sports,
      screen: s.screen === 'connecting' || s.screen === 'lobby' ? 'lobby' : s.screen,
      /*
       * Only the host picks the sport, so a guest has no use for the rack and is
       * put straight in the room. Opening an invite link and being shown a
       * carousel you are not allowed to touch is worse than not being shown one.
       */
      lobbyStep: room.host ? s.lobbyStep : 'room',
    })),
  setScreen: (screen) => set({ screen }),
  setLobbyStep: (lobbyStep) => set({ lobbyStep }),
  setSport: (sport) => set({ sport }),
  setNames: (names) => set({ names }),
  setLobbyStatus: (text, progress, done) => set({ lobbyStatus: { text, progress, done } }),
  setResult: (winner, final, summary) =>
    set({ result: { winner, final, summary }, screen: 'over' }),
  clearResult: () => set({ result: null }),
  setSubtitle: (text) => set({ subtitle: { text, at: performance.now() } }),
  showBanner: (big, sub = '', ttl = 1800) =>
    set({ banner: { big, sub, at: performance.now(), ttl } }),
  setMuted: (muted) => set({ muted }),
  setAudioReady: (audioReady) => set({ audioReady }),
  setError: (error) => set({ error }),
  toggleTune: () => set((s) => ({ showTune: !s.showTune })),
  toggleVirtual: () => set((s) => ({ showVirtual: !s.showVirtual })),
  setTutorial: (tutorial) => set({ tutorial }),
  setTuning: (tuning) => set({ tuning }),
  pushEvent: (e) => set((s) => ({ recent: [...s.recent.slice(-11), e] })),
  setNet: (rtt, offset) => set({ rtt, offset }),
  reset: () =>
    set({
      screen: 'lobby',
      // Back to the room rather than the rack: the seats that just played are
      // still in them, and a rematch is one button away.
      lobbyStep: 'room',
      result: null,
      subtitle: null,
      banner: null,
      recent: [],
      tutorial: false,
      lobbyStatus: { text: '', progress: 0, done: false },
    }),
}));
