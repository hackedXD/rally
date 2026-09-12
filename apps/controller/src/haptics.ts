/**
 * Phone-side feedback.
 *
 * iOS Safari has no Vibration API — `navigator.vibrate` does nothing at all — so
 * haptics on hit are not available. The substitute is a very short filtered-noise
 * click through the phone's own speaker: pre-built, triggered locally on `CUE`,
 * with zero network dependency on the thing that has to feel instant.
 */

type Click = 'hit' | 'whiff' | 'incoming' | 'won' | 'lost' | 'serve';

const SPECS: Record<Click, { freq: number; dur: number; gain: number; noise: number; sweep: number }> = {
  hit: { freq: 900, dur: 0.012, gain: 0.5, noise: 0.5, sweep: 0.4 },
  whiff: { freq: 300, dur: 0.09, gain: 0.28, noise: 0.7, sweep: 0.5 },
  incoming: { freq: 1400, dur: 0.02, gain: 0.22, noise: 0.1, sweep: 1 },
  won: { freq: 720, dur: 0.16, gain: 0.4, noise: 0.05, sweep: 1.9 },
  lost: { freq: 260, dur: 0.18, gain: 0.32, noise: 0.05, sweep: 0.6 },
  serve: { freq: 560, dur: 0.1, gain: 0.35, noise: 0.08, sweep: 1.5 },
};

export class Haptics {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  enabled = true;

  /** Must be called from the same user gesture that grants motion permission. */
  unlock(): void {
    if (this.ctx) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    void this.ctx.resume();

    const len = Math.floor(this.ctx.sampleRate * 0.2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Silent blip: some browsers only truly start on first playback.
    const s = this.ctx.createBufferSource();
    s.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    s.connect(this.ctx.destination);
    s.start(0);
  }

  play(kind: Click): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const spec = SPECS[kind];
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const out = ctx.createGain();
    out.gain.value = spec.gain;
    out.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(spec.freq, t);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(60, spec.freq * spec.sweep),
      t + spec.dur,
    );
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, t + spec.dur);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + spec.dur + 0.02);

    if (spec.noise > 0 && this.noise) {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = spec.freq * 1.6;
      band.Q.value = 0.9;
      const nenv = ctx.createGain();
      nenv.gain.setValueAtTime(spec.noise * spec.gain, t);
      nenv.gain.exponentialRampToValueAtTime(0.001, t + spec.dur * 0.8);
      n.connect(band).connect(nenv).connect(out);
      n.start(t);
      n.stop(t + spec.dur + 0.02);
    }
  }
}

export const haptics = new Haptics();
