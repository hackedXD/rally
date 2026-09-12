/**
 * The display owns all audio.
 *
 *   AudioContext
 *   +-- masterGain
 *       +-- musicGain        (ducked -10 dB under commentary)
 *       +-- sfxGain          (ducked -6 dB)
 *       +-- commentaryGain
 *
 * Two things here are load-bearing and both fail only on the demo machine, at the
 * worst possible moment, if you get them wrong:
 *
 *   1. The context is unlocked from a real user gesture. Browsers will not let you
 *      play audio otherwise.
 *   2. Preloaded cues are decoded to AudioBuffers BEFORE the match starts, so
 *      playing one is just scheduling a buffer source: sub-millisecond.
 */

import { TUNING, type PreloadedCue, type ShotType } from '@rally/protocol';

type SfxKind = ShotType | 'bounce' | 'net' | 'out' | 'point' | 'whiff';

interface Playing {
  source: AudioBufferSourceNode | null;
  utterance: SpeechSynthesisUtterance | null;
  priority: number;
  endsAt: number;
  id: string;
}

interface QueuedCue {
  id: string;
  priority: number;
  queuedAt: number;
}

const dbToGain = (db: number): number => 10 ** (db / 20);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private sfx: GainNode | null = null;
  /** Which sport's voices `sfxPlay` uses. See SFX_TABLETENNIS. */
  private sport = 'pickleball';
  private commentary: GainNode | null = null;

  private buffers = new Map<string, AudioBuffer>();
  private cues = new Map<string, PreloadedCue>();
  private playing: Playing | null = null;
  private queue: QueuedCue[] = [];
  private muted = false;
  private crowd: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  /** Streaming cue assembly: chunks arrive as binary frames. */
  private streams = new Map<string, { chunks: Uint8Array[]; priority: number; began: number }>();

  onSubtitle: (text: string, speaker: string) => void = () => undefined;

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  get state(): string {
    return this.ctx?.state ?? 'closed';
  }

  get bufferedCount(): number {
    return this.buffers.size;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async unlock(): Promise<boolean> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor({ latencyHint: 'interactive' });

      this.master = this.ctx.createGain();
      this.music = this.ctx.createGain();
      this.sfx = this.ctx.createGain();
      this.commentary = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.music.gain.value = 0.32;
      this.sfx.gain.value = 0.8;
      this.commentary.gain.value = 1.0;
      this.music.connect(this.master);
      this.sfx.connect(this.master);
      this.commentary.connect(this.master);
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') {
      // Never await this unconditionally. In some browsers a `resume()` that the
      // engine will not honour stays pending forever, and awaiting it from a
      // click handler silently takes the whole start-the-match flow with it.
      await Promise.race([
        this.ctx.resume().catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 500)),
      ]);
      // A silent blip: some browsers only truly start on first playback.
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
    }
    if (this.ctx.state !== 'running') {
      console.warn('[audio] context is', this.ctx.state, '— audio will be silent');
      return false;
    }
    // Anything that arrived before there was a context to decode into is still
    // sitting here undecoded. That is the normal case in a two-phone match: the
    // pairing happens entirely on the phones, the cold bank lands while this page
    // has never been touched, and the gesture that unlocks audio comes later — or
    // is the very first click anyone makes on it.
    await this.decodePending();
    return true;
  }

  /** Decode every stored cue that has bytes but no buffer yet. */
  private async decodePending(): Promise<number> {
    if (!this.ctx) return 0;
    let decoded = 0;
    for (const cue of this.cues.values()) {
      if (!cue.audioB64 || this.buffers.has(cue.id)) continue;
      if (await this.decode(cue)) decoded++;
    }
    if (decoded) console.info(`[audio] decoded ${decoded} cue(s) held back until unlock`);
    return decoded;
  }

  private async decode(cue: PreloadedCue): Promise<boolean> {
    if (!this.ctx) return false;
    try {
      const bytes = base64ToBytes(cue.audioB64);
      const buffer = await this.ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
      this.buffers.set(cue.id, buffer);
      return true;
    } catch (err) {
      console.warn('[audio] could not decode cue', cue.id, err);
      return false;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
    if (muted && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  // ── Cue preloading ──────────────────────────────────────────────────────────

  /**
   * Decode every preloaded cue up front. At play time there is nothing left to
   * do but schedule it, which is what makes cached commentary land in one network
   * hop.
   */
  async preload(cues: PreloadedCue[]): Promise<number> {
    let decoded = 0;
    for (const cue of cues) {
      this.cues.set(cue.id, cue);
      // No context yet means no gesture yet. Keep the cue — `unlock` decodes
      // whatever has piled up — but do not drop the bytes on the floor.
      if (!cue.audioB64 || this.buffers.has(cue.id) || !this.ctx) continue;
      if (await this.decode(cue)) decoded++;
    }
    return decoded;
  }

  // ── Playback ────────────────────────────────────────────────────────────────

  /**
   * A line, once started, always finishes.
   *
   * This used to let a higher-priority cue fade the current one out over 60 ms
   * and take over, which sounds reasonable and is the single worst thing the
   * audio engine can do: the interesting lines are the high-priority ones, so
   * the policy reliably cut off the commentary you most wanted to hear, and
   * during a busy rally it cut off nearly everything. A half-spoken sentence
   * reads as a bug in a way that a slightly late one never does.
   *
   * Nothing here interrupts any more — a cue either queues behind what is
   * playing or is dropped before it starts. The server does its half by holding
   * the next serve until the queue has drained (see `speakingUntil` in the
   * commentary director), so lines land in the gaps rather than piling up.
   *
   * Priority still matters, just earlier: it decides who gets the queue slot
   * when the queue is full, rather than who gets to talk over whom.
   */
  playCue(id: string, priority: number): void {
    if (this.muted) return;
    const cue = this.cues.get(id);
    if (!cue) return;

    if (this.playing && performance.now() < this.playing.endsAt) {
      if (this.queue.length >= TUNING.commentary.queueMaxDepth) {
        // Full. Displace the least important queued line rather than the one
        // currently being spoken, and only for something that outranks it.
        let worst = 0;
        for (let i = 1; i < this.queue.length; i++) {
          if (this.queue[i].priority < this.queue[worst].priority) worst = i;
        }
        if (priority <= this.queue[worst].priority) return;
        this.queue.splice(worst, 1);
      }
      this.queue.push({ id, priority, queuedAt: performance.now() });
      return;
    }
    this.start(cue, priority);
  }

  /**
   * How long until everything queued has been said, ms.
   *
   * The display's own view of the same number the server is tracking. Used to
   * keep the subtitle up for as long as there is something still to say.
   */
  get speakingForMs(): number {
    const now = performance.now();
    let ms = this.playing ? Math.max(0, this.playing.endsAt - now) : 0;
    for (const q of this.queue) ms += this.cues.get(q.id)?.durationMs ?? 0;
    return ms;
  }

  private start(cue: PreloadedCue, priority: number): void {
    this.onSubtitle(cue.text, 'commentary');
    this.duck(true);

    const buffer = this.buffers.get(cue.id);
    if (buffer && this.ctx && this.commentary) {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.commentary);
      source.start();
      const endsAt = performance.now() + buffer.duration * 1000;
      this.playing = { source, utterance: null, priority, endsAt, id: cue.id };
      source.onended = () => this.finished(cue.id);
      return;
    }

    // No audio bytes: speak it. This is the no-API-keys path, and it behaves
    // identically from everywhere else's point of view.
    if (cue.speak !== false && typeof speechSynthesis !== 'undefined') {
      const u = new SpeechSynthesisUtterance(cue.text);
      u.rate = 1.18;
      u.pitch = 1.04;
      u.volume = 0.95;
      const voice = pickVoice();
      if (voice) u.voice = voice;
      const endsAt = performance.now() + cue.durationMs + 200;
      this.playing = { source: null, utterance: u, priority, endsAt, id: cue.id };
      u.onend = () => this.finished(cue.id);
      u.onerror = () => this.finished(cue.id);
      try {
        speechSynthesis.speak(u);
      } catch {
        this.finished(cue.id);
      }
      return;
    }

    // Nothing to play, but the subtitle is still worth showing.
    this.playing = {
      source: null,
      utterance: null,
      priority,
      endsAt: performance.now() + cue.durationMs,
      id: cue.id,
    };
    setTimeout(() => this.finished(cue.id), cue.durationMs);
  }

  private finished(id: string): void {
    if (this.playing?.id !== id) return;
    this.playing = null;
    this.duck(false);

    // Drop stale cues before taking the next one — commentary about a point two
    // rallies ago is worse than silence. A line that has already started is
    // never dropped; this only ever discards things that never got to speak.
    const now = performance.now();
    this.queue = this.queue.filter(
      (q) => q.priority >= 3 || now - q.queuedAt < TUNING.commentary.queueStaleMs,
    );
    const next = this.queue.shift();
    if (next) this.playCue(next.id, next.priority);
  }

  private stopCurrent(fadeSeconds: number): void {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    if (p.source && this.ctx && this.commentary) {
      try {
        this.commentary.gain.setTargetAtTime(0, this.ctx.currentTime, fadeSeconds / 3);
        p.source.stop(this.ctx.currentTime + fadeSeconds);
        setTimeout(() => {
          if (this.ctx && this.commentary) {
            this.commentary.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
          }
        }, fadeSeconds * 1000 + 20);
      } catch {
        /* already stopped */
      }
    }
    if (p.utterance && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  /** Duck music and effects under commentary with 80 ms linear ramps. */
  private duck(on: boolean): void {
    if (!this.ctx || !this.music || !this.sfx) return;
    const t = this.ctx.currentTime;
    const ramp = TUNING.commentary.duckRampMs / 1000;
    const musicTarget = on ? 0.32 * dbToGain(TUNING.commentary.duckMusicDb) : 0.32;
    const sfxTarget = on ? 0.8 * dbToGain(TUNING.commentary.duckSfxDb) : 0.8;
    this.music.gain.cancelScheduledValues(t);
    this.sfx.gain.cancelScheduledValues(t);
    this.music.gain.linearRampToValueAtTime(musicTarget, t + ramp);
    this.sfx.gain.linearRampToValueAtTime(sfxTarget, t + ramp);
  }

  // ── Streaming cues ──────────────────────────────────────────────────────────

  beginStream(id: string, priority: number, speak: boolean, text?: string): void {
    if (speak && text) {
      this.cues.set(id, {
        id,
        text,
        audioB64: '',
        durationMs: Math.max(900, text.length * 55),
        layer: 'cache',
        cls: 'point.close',
        speak: true,
      });
      this.playCue(id, priority);
      return;
    }
    this.streams.set(id, { chunks: [], priority, began: performance.now() });
  }

  pushStream(id: string, bytes: Uint8Array): void {
    this.streams.get(id)?.chunks.push(bytes);
  }

  streamText(id: string, text: string): void {
    const cue = this.cues.get(id);
    if (cue) cue.text = text;
    else this.onSubtitle(text, 'commentary');
  }

  /**
   * Assemble and play a streamed cue.
   *
   * A 150 ms jitter buffer before starting is the theory; in practice MP3 frames
   * cannot be decoded independently by `decodeAudioData`, so the whole stream is
   * concatenated and decoded once on END. For an 8-20 word line that is a few
   * hundred milliseconds of extra latency on the ONE layer that already had
   * seconds of dead time to play with — and it is robust, which the alternative
   * is not.
   */
  async endStream(id: string): Promise<void> {
    const stream = this.streams.get(id);
    this.streams.delete(id);
    if (!stream || !stream.chunks.length || !this.ctx) return;

    const total = stream.chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of stream.chunks) {
      joined.set(c, at);
      at += c.length;
    }
    try {
      const buffer = await this.ctx.decodeAudioData(joined.buffer as ArrayBuffer);
      this.buffers.set(id, buffer);
      const existing = this.cues.get(id);
      this.cues.set(id, {
        id,
        text: existing?.text ?? '',
        audioB64: '',
        durationMs: buffer.duration * 1000,
        layer: 'cache',
        cls: existing?.cls ?? 'point.close',
        speak: false,
      });
      this.playCue(id, stream.priority);
    } catch (err) {
      console.warn('[audio] streamed cue failed to decode', err);
    }
  }

  // ── Effects ─────────────────────────────────────────────────────────────────

  /**
   * All sound effects are synthesised. Each shot type needs a distinct sound or
   * players will not perceive the difference between them — and five generated
   * tones read as intentional where five free samples read as a scramble.
   */
  /** Called when a match starts, so contact sounds match the sport being played. */
  setSport(id: string): void {
    this.sport = id;
  }

  sfxPlay(kind: SfxKind, gain = 1): void {
    if (!this.ctx || !this.sfx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.connect(this.sfx);

    const table = this.sport === 'tabletennis' ? SFX_TABLETENNIS : SFX;
    const spec = table[kind] ?? table.rally;
    out.gain.value = spec.gain * gain;

    // Body: a short pitched thud.
    const osc = ctx.createOscillator();
    osc.type = spec.wave;
    osc.frequency.setValueAtTime(spec.freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, spec.freq * spec.sweep), t + spec.decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0008, t + spec.decay);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + spec.decay + 0.02);

    // Attack: filtered noise, which is what makes it read as a strike.
    if (spec.noise > 0) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer();
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = spec.noiseFreq;
      band.Q.value = 1.1;
      const nenv = ctx.createGain();
      nenv.gain.setValueAtTime(spec.noise, t);
      nenv.gain.exponentialRampToValueAtTime(0.0008, t + spec.noiseDecay);
      noise.connect(band).connect(nenv).connect(out);
      noise.start(t);
      noise.stop(t + spec.noiseDecay + 0.02);
    }
  }

  private noise: AudioBuffer | null = null;
  private noiseBuffer(): AudioBuffer {
    if (this.noise || !this.ctx) return this.noise as AudioBuffer;
    const len = Math.floor(this.ctx.sampleRate * 0.25);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  /** Crowd ambience, ducked under commentary along with everything else. */
  startCrowd(): void {
    if (!this.ctx || !this.music || this.crowd) return;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 4);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let low = 0;
      for (let i = 0; i < len; i++) {
        // Brown-ish noise with a slow swell: reads as a room, not as static.
        low = (low + (Math.random() * 2 - 1) * 0.02) * 0.996;
        const swell = 0.65 + 0.35 * Math.sin((i / len) * Math.PI * 2 * 3 + ch);
        d[i] = low * swell;
      }
    }
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    source.connect(filter).connect(gain).connect(this.music);
    source.start();
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 2);
    this.crowd = { source, gain };
  }

  /** A short swell, for a point won. */
  crowdReact(strength = 1): void {
    if (!this.ctx || !this.crowd) return;
    const t = this.ctx.currentTime;
    const g = this.crowd.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.min(1, 0.5 + 0.5 * strength), t + 0.12);
    g.linearRampToValueAtTime(0.5, t + 1.4);
  }

  stopCrowd(): void {
    if (!this.crowd) return;
    try {
      this.crowd.source.stop();
    } catch {
      /* already stopped */
    }
    this.crowd = null;
  }

  reset(): void {
    this.stopCurrent(0.02);
    this.queue = [];
    this.streams.clear();
  }
}

interface SfxSpec {
  freq: number;
  sweep: number;
  decay: number;
  wave: OscillatorType;
  gain: number;
  noise: number;
  noiseFreq: number;
  noiseDecay: number;
}

/**
 * Table tennis, whose two contacts have to be told apart without looking.
 *
 * Half of knowing where the ball is in that sport is hearing it, and the shared
 * table below gets it backwards for a table: its `bounce` is a low dull thud,
 * which is what a pickleball on a court sounds like and nothing like a hollow
 * celluloid ball on a hard sheet. Transplanted from `pickle`:
 *
 *   bat   — celluloid on RUBBER over wood. Dense, damped, dark: mostly noise
 *           with a low thud of body under it, and no ring at all.
 *   table — a hollow ball on a hard sheet. Bright, pitched, hollow — a tok with
 *           almost no body, well over an octave above the bat.
 *
 * The same burst shaped two ways rather than two arbitrary beeps, so they belong
 * to one world while never being mistaken for each other.
 */
const SFX_TABLETENNIS: Record<string, SfxSpec> = {
  serve:  { freq: 250, sweep: 0.55, decay: 0.05, wave: 'triangle', gain: 0.5, noise: 0.34, noiseFreq: 950, noiseDecay: 0.07 },
  drive:  { freq: 240, sweep: 0.55, decay: 0.05, wave: 'triangle', gain: 0.6, noise: 0.44, noiseFreq: 1150, noiseDecay: 0.075 },
  smash:  { freq: 260, sweep: 0.5,  decay: 0.06, wave: 'triangle', gain: 0.8, noise: 0.6,  noiseFreq: 1400, noiseDecay: 0.08 },
  // A graze — the ball met the bat with nobody swinging at it. Deliberately
  // almost nothing: the crack's body with none of its attack. The full crack
  // made every ball that brushed the bat sound like a drive somebody meant.
  dink:   { freq: 170, sweep: 0.6,  decay: 0.055, wave: 'sine',    gain: 0.3, noise: 0.06, noiseFreq: 700,  noiseDecay: 0.02 },
  lob:    { freq: 220, sweep: 0.6,  decay: 0.06, wave: 'triangle', gain: 0.4, noise: 0.24, noiseFreq: 900,  noiseDecay: 0.06 },
  rally:  { freq: 230, sweep: 0.55, decay: 0.05, wave: 'triangle', gain: 0.55, noise: 0.4, noiseFreq: 1050, noiseDecay: 0.075 },
  bounce: { freq: 1400, sweep: 0.8, decay: 0.06, wave: 'sine',     gain: 0.34, noise: 0.16, noiseFreq: 3000, noiseDecay: 0.02 },
  net:    { freq: 170, sweep: 0.55, decay: 0.12, wave: 'sawtooth', gain: 0.45, noise: 0.25, noiseFreq: 500, noiseDecay: 0.1 },
  // The floor is neither: dull, low, and no pitch worth hearing.
  out:    { freq: 130, sweep: 0.55, decay: 0.1,  wave: 'sine',     gain: 0.3, noise: 0.08, noiseFreq: 600,  noiseDecay: 0.04 },
  whiff:  { freq: 260, sweep: 0.35, decay: 0.22, wave: 'sine',     gain: 0.3, noise: 0.45, noiseFreq: 700,  noiseDecay: 0.2 },
  point:  { freq: 620, sweep: 1.4,  decay: 0.22, wave: 'triangle', gain: 0.45, noise: 0.06, noiseFreq: 1800, noiseDecay: 0.04 },
};

/** One distinct sound per shot silhouette. */
const SFX: Record<string, SfxSpec> = {
  serve:  { freq: 380, sweep: 0.5, decay: 0.1,  wave: 'triangle', gain: 0.5, noise: 0.3, noiseFreq: 2200, noiseDecay: 0.05 },
  drive:  { freq: 300, sweep: 0.4, decay: 0.11, wave: 'square',   gain: 0.6, noise: 0.4, noiseFreq: 2600, noiseDecay: 0.05 },
  smash:  { freq: 210, sweep: 0.3, decay: 0.16, wave: 'sawtooth', gain: 0.8, noise: 0.6, noiseFreq: 3200, noiseDecay: 0.07 },
  dink:   { freq: 620, sweep: 0.7, decay: 0.07, wave: 'sine',     gain: 0.35, noise: 0.16, noiseFreq: 1500, noiseDecay: 0.03 },
  lob:    { freq: 480, sweep: 0.8, decay: 0.12, wave: 'sine',     gain: 0.4, noise: 0.2, noiseFreq: 1200, noiseDecay: 0.05 },
  rally:  { freq: 340, sweep: 0.5, decay: 0.09, wave: 'triangle', gain: 0.5, noise: 0.3, noiseFreq: 2200, noiseDecay: 0.045 },
  bounce: { freq: 150, sweep: 0.45, decay: 0.08, wave: 'sine',    gain: 0.34, noise: 0.14, noiseFreq: 900, noiseDecay: 0.03 },
  net:    { freq: 120, sweep: 0.6, decay: 0.2,  wave: 'triangle', gain: 0.45, noise: 0.4, noiseFreq: 500, noiseDecay: 0.16 },
  out:    { freq: 190, sweep: 0.35, decay: 0.2, wave: 'sine',     gain: 0.3, noise: 0.1, noiseFreq: 700, noiseDecay: 0.06 },
  whiff:  { freq: 260, sweep: 0.35, decay: 0.22, wave: 'sine',    gain: 0.3, noise: 0.45, noiseFreq: 700, noiseDecay: 0.2 },
  point:  { freq: 520, sweep: 1.6, decay: 0.3,  wave: 'triangle', gain: 0.45, noise: 0.08, noiseFreq: 1800, noiseDecay: 0.05 },
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedVoice: SpeechSynthesisVoice | null | undefined;
/** Prefer an energetic English voice; never shop for voices at runtime twice. */
function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice;
  if (typeof speechSynthesis === 'undefined') {
    cachedVoice = null;
    return null;
  }
  const voices = speechSynthesis.getVoices();
  if (!voices.length) {
    cachedVoice = undefined; // try again once the list populates
    return null;
  }
  const prefer = ['Daniel', 'Google UK English Male', 'Arthur', 'Oliver', 'Matthew', 'Alex'];
  for (const name of prefer) {
    const hit = voices.find((v) => v.name.includes(name));
    if (hit) return (cachedVoice = hit);
  }
  cachedVoice = voices.find((v) => v.lang.startsWith('en')) ?? voices[0] ?? null;
  return cachedVoice;
}

export const audio = new AudioEngine();
