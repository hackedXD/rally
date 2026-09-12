/**
 * mock-voice — replaces ElevenLabs.
 *
 * Note that the SHIPPED offline voice is this same idea promoted to production:
 * `SpeechSynthesisVoice` marks each cue `speak: true` and the display says the
 * line with the browser's own speech synthesis. Free, instant, no quota, and it
 * means Rally has a commentator with no API keys configured at all.
 *
 * What is left here is the piece that only a test wants: a provider that returns
 * real audio-shaped bytes with a configurable delay and failure rate, so the
 * streaming and batching paths can be exercised without a network.
 */

import type {
  SynthResult,
  VoiceProvider,
} from '../../apps/server/src/commentary/providers/types.js';
import { estimateDurationMs } from '../../apps/server/src/commentary/providers/voice.js';

export interface MockVoiceOptions {
  delayMs?: number;
  failRate?: number;
  /** Bytes of fake audio per character of text. */
  bytesPerChar?: number;
}

export class MockVoiceProvider implements VoiceProvider {
  readonly name = 'mock-voice';
  readonly producesAudio = true;
  synthesised: string[] = [];

  constructor(private readonly opts: MockVoiceOptions = {}) {}

  async synth(text: string): Promise<SynthResult> {
    await sleep(this.opts.delayMs ?? 10);
    if (Math.random() < (this.opts.failRate ?? 0)) throw new Error('mock-voice: simulated failure');
    this.synthesised.push(text);
    const n = Math.max(64, text.length * (this.opts.bytesPerChar ?? 32));
    return { audio: fakeAudio(n), durationMs: estimateDurationMs(text), speak: false };
  }

  async *streamSynth(text: AsyncIterable<string>): AsyncIterable<Uint8Array> {
    let all = '';
    for await (const piece of text) {
      all += piece;
      await sleep((this.opts.delayMs ?? 10) / 4);
      yield fakeAudio(Math.max(32, piece.length * 24));
    }
    this.synthesised.push(all.trim());
  }
}

function fakeAudio(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // An MP3 frame header, so anything sniffing the bytes sees something plausible.
  out[0] = 0xff;
  out[1] = 0xfb;
  for (let i = 2; i < n; i++) out[i] = (i * 37) & 0xff;
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
