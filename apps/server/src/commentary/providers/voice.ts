/**
 * Voice providers.
 *
 * `ElevenLabsVoice` produces real MP3 bytes. `SpeechSynthesisVoice` produces
 * nothing at all and instead marks the cue `speak: true`, which tells the display
 * to say the line through the browser's own speech synthesis.
 *
 * That second one is why Rally has a commentator on a laptop with no API keys and
 * no network: it is the default, not a degraded mode, and the whole layered cache
 * architecture behaves identically either way because the cue pipeline never
 * learns which voice it is using.
 */

import WebSocket from 'ws';
import { CONFIG } from '../../config.js';
import { log } from '../../log.js';
import type { SynthResult, VoiceProvider } from './types.js';

const logger = log.child('voice');

/**
 * A process-wide gate on concurrent ElevenLabs requests.
 *
 * The limit belongs to the API key, not to a room — and a room is exactly the
 * wrong place to enforce it. Two matches preparing their cold banks at the same
 * time is the ordinary case on a shared server, and two rooms each politely
 * batching eight requests is sixteen arriving at a door that, on the smaller
 * plans, admits two.
 */
class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    // A `while` rather than an `if`: waking up is permission to re-check, not
    // permission to proceed, or two waiters released together both walk in.
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
  }

  release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const gate = new Gate(Math.max(1, CONFIG.elevenlabs.concurrency));

/**
 * Rate-limit warnings, collapsed.
 *
 * Every line of a cold bank hitting the same limit produces a hundred identical
 * warnings, which buries the one thing worth reading in the log.
 */
let throttledAt = 0;
let throttledSince = 0;
function noteThrottled(detail: string): void {
  throttledSince++;
  const now = Date.now();
  if (now - throttledAt < 10_000) return;
  logger.warn(
    `tts rate-limited (${throttledSince} since the last report): ${detail}. ` +
      `Concurrency is capped at ${CONFIG.elevenlabs.concurrency}; ` +
      'lower ELEVENLABS_CONCURRENCY if this persists.',
  );
  throttledAt = now;
  throttledSince = 0;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long to wait before retrying a 429. Honours `retry-after` when present. */
export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const header = Number(retryAfter);
  if (Number.isFinite(header) && header > 0) return Math.min(8000, header * 1000);
  // Exponential with jitter, so a batch released together does not re-collide.
  return Math.min(8000, 2 ** attempt * 250 + Math.random() * 250);
}

/** Attempts per line before giving the words to the browser's own voice. */
const MAX_ATTEMPTS = 4;

/** Rough speech duration, for scheduling and ducking. ~2.6 words/second. */
export function estimateDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(700, Math.round((words / 2.6) * 1000) + 200);
}

export class SpeechSynthesisVoice implements VoiceProvider {
  readonly name = 'browser-speech-synthesis';
  readonly producesAudio = false;

  async synth(text: string): Promise<SynthResult> {
    return { audio: new Uint8Array(0), durationMs: estimateDurationMs(text), speak: true };
  }

  /** Nothing to stream: the display speaks the text as it arrives. */
  async *streamSynth(): AsyncIterable<Uint8Array> {
    // Intentionally empty.
  }
}

export class ElevenLabsVoice implements VoiceProvider {
  readonly name = 'elevenlabs';
  readonly producesAudio = true;

  /**
   * REST synthesis, for the cold bank and speculative cues where a complete file
   * is what you want to cache. Keep each request well under 1000 characters;
   * commentary lines are 8-20 words anyway.
   */
  async synth(text: string): Promise<SynthResult> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await gate.run(() => this.attempt(text));
      if (res.kind === 'ok') return res.result;
      if (res.kind === 'fail') return fallback(text);
      // Throttled. Wait outside the gate, so the slot goes to somebody who can
      // use it rather than being held through the backoff.
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(retryDelayMs(res.retryAfter, attempt));
    }
    return fallback(text);
  }

  /**
   * One REST attempt.
   *
   * Separated from the retry loop so the concurrency slot covers the request and
   * nothing else — a backoff held inside the gate would idle a slot that another
   * line could be using.
   */
  private async attempt(
    text: string,
  ): Promise<
    | { kind: 'ok'; result: SynthResult }
    | { kind: 'fail' }
    | { kind: 'throttled'; retryAfter: string | null }
  > {
    const body = {
      text: text.slice(0, 900),
      model_id: CONFIG.elevenlabs.model,
      voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.45 },
    };
    const url = `${CONFIG.elevenlabs.endpoint}/text-to-speech/${CONFIG.elevenlabs.voiceId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': CONFIG.elevenlabs.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 429) {
        noteThrottled((await res.text()).slice(0, 120));
        return { kind: 'throttled', retryAfter: res.headers.get('retry-after') };
      }
      if (!res.ok) {
        logger.warn('tts http', res.status, (await res.text()).slice(0, 160));
        return { kind: 'fail' };
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 256) return { kind: 'fail' };
      return {
        kind: 'ok',
        result: { audio: buf, durationMs: estimateDurationMs(text), speak: false },
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') logger.warn('tts timed out');
      else logger.warn('tts failed', err);
      return { kind: 'fail' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * WebSocket streaming synthesis, fed from the text stream.
   *
   * Chunking matters: chunk too eagerly and prosody falls apart, chunk too late
   * and the latency win is gone. Split on sentence and clause boundaries once the
   * buffer is past 25 characters.
   *
   * The socket times out after 180 s of inactivity, so it is opened per line and
   * torn down — simpler and more robust than keepalives for lines this short.
   */
  async *streamSynth(text: AsyncIterable<string>): AsyncIterable<Uint8Array> {
    // A live stream holds its slot for the whole line. That is the point: it is
    // one concurrent request against the same account as every cold-bank line,
    // and the account is what the limit is attached to.
    await gate.acquire();
    try {
      yield* this.streamOne(text);
    } finally {
      gate.release();
    }
  }

  private async *streamOne(text: AsyncIterable<string>): AsyncIterable<Uint8Array> {
    const url =
      `${CONFIG.elevenlabs.wsEndpoint}/text-to-speech/${CONFIG.elevenlabs.voiceId}` +
      `/stream-input?model_id=${encodeURIComponent(CONFIG.elevenlabs.model)}&output_format=mp3_44100_128`;

    const ws = new WebSocket(url, {
      headers: { 'xi-api-key': CONFIG.elevenlabs.apiKey },
    });
    const chunks: Uint8Array[] = [];
    let closed = false;
    let failed = false;
    let notify: (() => void) | null = null;
    const wake = () => {
      notify?.();
      notify = null;
    };

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { audio?: string; isFinal?: boolean };
        if (msg.audio) chunks.push(new Uint8Array(Buffer.from(msg.audio, 'base64')));
        if (msg.isFinal) closed = true;
      } catch {
        /* non-JSON frame; ignore */
      }
      wake();
    });
    ws.on('error', (err) => {
      logger.warn('tts socket error', err);
      failed = true;
      closed = true;
      wake();
    });
    ws.on('close', () => {
      closed = true;
      wake();
    });

    try {
      await once(ws, 'open', 6000);
    } catch {
      logger.warn('tts socket did not open');
      try {
        ws.close();
      } catch {
        /* nothing to close */
      }
      return;
    }

    ws.send(
      JSON.stringify({
        text: ' ',
        voice_settings: { stability: 0.35, similarity_boost: 0.75 },
        generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
      }),
    );

    // Pump the text stream in, clause by clause.
    const pump = (async () => {
      let buffer = '';
      try {
        for await (const piece of text) {
          buffer += piece;
          let cut = findBoundary(buffer);
          while (cut > 0) {
            ws.send(JSON.stringify({ text: buffer.slice(0, cut) }));
            buffer = buffer.slice(cut);
            cut = findBoundary(buffer);
          }
        }
        if (buffer.trim()) ws.send(JSON.stringify({ text: buffer }));
      } catch (err) {
        logger.warn('text stream failed', err);
      } finally {
        try {
          ws.send(JSON.stringify({ text: '' })); // end of input
        } catch {
          /* socket already gone */
        }
      }
    })();

    while (!closed || chunks.length) {
      if (chunks.length) {
        yield chunks.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
        setTimeout(resolve, 250);
      });
    }
    await pump.catch(() => undefined);
    if (!failed) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/** Split on sentence and clause boundaries once there is enough to say. */
export function findBoundary(buffer: string): number {
  if (buffer.length < 25) return 0;
  for (const mark of ['. ', '! ', '? ', ', ']) {
    const at = buffer.indexOf(mark);
    if (at >= 20) return at + mark.length;
  }
  // Nothing punctuated; flush a long buffer at a word boundary anyway.
  if (buffer.length > 90) {
    const space = buffer.lastIndexOf(' ', 90);
    if (space > 20) return space + 1;
  }
  return 0;
}

function fallback(text: string): SynthResult {
  // Audio failed but the words are fine: let the display speak them.
  return { audio: new Uint8Array(0), durationMs: estimateDurationMs(text), speak: true };
}

function once(ws: WebSocket, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    ws.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
