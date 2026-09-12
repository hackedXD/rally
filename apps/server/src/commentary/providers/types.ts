/**
 * Swappable providers keep the demo alive when an API dies (design §7).
 *
 * Every implementation must time out rather than block. Your APIs will fail
 * exactly once, on stage, and the game has to keep playing without a hitch.
 */

import type { CueClass } from '@rally/protocol';

export interface PromptSpec {
  system: string;
  user: string;
  /** Ask for JSON and parse defensively; some models fence it anyway. */
  json: boolean;
  maxTokens?: number;
  /** Hard deadline. Past this the caller stops waiting and falls through. */
  timeoutMs: number;
  /** 'fast' for the cold bank and speculative layers, 'live' for between points. */
  tier: 'fast' | 'live';
}

export interface TextProvider {
  readonly name: string;
  /** One-shot generation. Returns [] rather than throwing. */
  generate(prompt: PromptSpec): Promise<string[]>;
  /** Token stream for the live layer. Yields nothing rather than throwing. */
  stream(prompt: PromptSpec): AsyncIterable<string>;
}

export interface SynthResult {
  /** MP3 bytes, or empty when the voice is synthesised on the client. */
  audio: Uint8Array;
  durationMs: number;
  /**
   * True when the display must speak the text itself via `speechSynthesis`.
   * This is how Rally has a commentator with no API keys configured at all.
   */
  speak: boolean;
}

export interface VoiceProvider {
  readonly name: string;
  /** True when this provider returns real audio bytes. */
  readonly producesAudio: boolean;
  synth(text: string): Promise<SynthResult>;
  /** Streaming synthesis for the live layer. */
  streamSynth(text: AsyncIterable<string>): AsyncIterable<Uint8Array>;
}

/** What the director asks a writer for. */
export interface LineRequest {
  cls: CueClass;
  count: number;
}

// ── The writer layer ──────────────────────────────────────────────────────────

/**
 * `TextProvider` is the low-level seam (prompt in, strings out). `Writer` is the
 * layer the Director actually talks to, because the offline writer wants
 * structured match state rather than a prompt string — forcing templates through
 * a prompt would be pure ceremony.
 */

import type { EventData, Seat } from '@rally/protocol';
import type { MatchNarrative } from '../narrative.js';

export interface LineContext {
  cls: CueClass;
  narrative: MatchNarrative;
  /** Seat the event is about, when there is one. */
  subject?: Seat;
  data: EventData;
}

/** One of the small number of ways a rally can resolve (design §8.5.3). */
export interface SpecOutcome {
  /** Stable key used to match the cue when the rally actually resolves. */
  key: string;
  /** Human description handed to the writer. */
  describe: string;
  cls: CueClass;
}

export interface LiveLine {
  line: string;
  /**
   * A nickname or running joke the writer wants to keep. The round trip is the
   * whole game: coined at point 2, called back at match point.
   */
  newBit: string | null;
}

export interface Writer {
  readonly name: string;
  /**
   * Layer 0 — pre-written lines, keyed by cue class.
   *
   * Lines may contain `{player}` and `{opponent}` placeholders; the Director
   * instantiates each such line once per seat and tags it, so a cached line about
   * one player can never fire when the other one wins the point. A line with no
   * placeholder is seat-agnostic and usable for anybody.
   */
  bank(
    narrative: MatchNarrative,
    classes: readonly CueClass[],
    perClass: number,
  ): Promise<Map<CueClass, string[]>>;
  /** Layer 1 — one line for each way the rally might resolve. */
  speculate(
    narrative: MatchNarrative,
    outcomes: readonly SpecOutcome[],
  ): Promise<Map<string, string>>;
  /** Layer 2 — the novel, specific line. */
  live(ctx: LineContext): Promise<LiveLine>;
  /** Optional token stream, so synthesis can start before writing finishes. */
  liveStream?(ctx: LineContext): AsyncIterable<string> | null;
}
