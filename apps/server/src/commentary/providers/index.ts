/**
 * Provider selection. One place decides what the commentary stack is, so the
 * Director never branches on whether keys are configured.
 */

import { CONFIG, hasElevenLabs, hasGemini } from '../../config.js';
import { log } from '../../log.js';
import { GeminiTextProvider } from './gemini.js';
import { GeminiWriter } from './gemini-writer.js';
import { OfflineWriter } from './offline-text.js';
import type { VoiceProvider, Writer } from './types.js';
import { ElevenLabsVoice, SpeechSynthesisVoice } from './voice.js';

export * from './types.js';
export { GeminiTextProvider } from './gemini.js';
export { GeminiWriter } from './gemini-writer.js';
export { OfflineWriter } from './offline-text.js';
export { ElevenLabsVoice, SpeechSynthesisVoice, estimateDurationMs, findBoundary } from './voice.js';

export interface ProviderSet {
  writer: Writer;
  voice: VoiceProvider;
  /** Always present: the writer the fallback chain ends at. */
  offline: OfflineWriter;
}

export function selectProviders(seed = 1): ProviderSet {
  const offline = new OfflineWriter(seed);
  const writer: Writer = hasGemini()
    ? new GeminiWriter(new GeminiTextProvider())
    : offline;
  const voice: VoiceProvider = hasElevenLabs()
    ? new ElevenLabsVoice()
    : new SpeechSynthesisVoice();

  log.info(
    `commentary: writer=${writer.name} voice=${voice.name}` +
      (hasGemini() ? ` models=${CONFIG.gemini.modelFast}/${CONFIG.gemini.modelLive}` : ''),
  );
  return { writer, voice, offline };
}
