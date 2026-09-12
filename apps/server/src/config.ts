/**
 * Configuration. Secrets live in environment variables and never in a client
 * bundle (§8.6). Model IDs live here rather than inline, so a model swap is a
 * config change and never a code change mid-demo.
 */

import { config as loadEnv } from 'dotenv';

loadEnv();

const str = (key: string, dflt = ''): string => process.env[key]?.trim() || dflt;
const num = (key: string, dflt: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : dflt;
};
const bool = (key: string): boolean => {
  const v = str(key).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
};

export const CONFIG = {
  port: num('PORT', 8787),
  host: str('HOST', '0.0.0.0'),
  serveStatic: bool('RALLY_SERVE_STATIC'),
  /** Public HTTPS origin for the controller QR code. Auto-derived when blank. */
  publicOrigin: str('RALLY_PUBLIC_ORIGIN'),
  logLevel: str('RALLY_LOG', 'info') as 'debug' | 'info' | 'warn' | 'error',
  recordReplays: bool('RALLY_RECORD'),
  replayDir: str('RALLY_REPLAY_DIR', 'replays'),

  gemini: {
    apiKey: str('GEMINI_API_KEY'),
    /**
     * Fast model for the speculative layer and the cold bank — latency is the
     * whole point in those paths.
     */
    modelFast: str('GEMINI_MODEL_FAST', 'gemini-3.5-flash-lite'),
    /** Better writing for the live layer, where there is dead time to spend. */
    modelLive: str('GEMINI_MODEL_LIVE', 'gemini-3.6-flash'),
    endpoint: str(
      'GEMINI_ENDPOINT',
      'https://generativelanguage.googleapis.com/v1beta/models',
    ),
  },

  elevenlabs: {
    apiKey: str('ELEVENLABS_API_KEY'),
    voiceId: str('ELEVENLABS_VOICE_ID', 'pNInz6obpgDQGcFmaJgB'),
    /** Purpose-built for real-time use: sub-300 ms to first audio. */
    model: str('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
    endpoint: str('ELEVENLABS_ENDPOINT', 'https://api.elevenlabs.io/v1'),
    wsEndpoint: str('ELEVENLABS_WS', 'wss://api.elevenlabs.io/v1'),
    /** Standard tiers cap concurrency around 15; synthesise in batches of 8. */
    batchSize: num('ELEVENLABS_BATCH', 8),
  },

  /** Force the offline commentator even when keys are present. */
  forceOfflineAi: bool('RALLY_FORCE_OFFLINE_AI'),
} as const;

export function hasGemini(): boolean {
  return !CONFIG.forceOfflineAi && CONFIG.gemini.apiKey.length > 10;
}

export function hasElevenLabs(): boolean {
  return !CONFIG.forceOfflineAi && CONFIG.elevenlabs.apiKey.length > 10;
}

/** One-line description of the commentary stack in use, for the boot banner. */
export function aiStatus(): string {
  const text = hasGemini() ? `Gemini (${CONFIG.gemini.modelFast} / ${CONFIG.gemini.modelLive})` : 'offline writer';
  const voice = hasElevenLabs() ? `ElevenLabs (${CONFIG.elevenlabs.model})` : 'browser speech synthesis';
  return `${text} + ${voice}`;
}
