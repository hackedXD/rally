/**
 * Gemini, over plain `fetch`. No SDK: the REST surface is three fields and a
 * dependency that can break a build at 3am is not worth the convenience.
 *
 * Two models, two jobs (design §4.1):
 *   fast  — the speculative layer and the cold bank. Latency is the whole point.
 *   live  — between points, where there is dead time and better writing pays.
 *
 * Everything here times out rather than blocking, and returns empty rather than
 * throwing. A dead API must degrade the commentary, never the match.
 */

import { CONFIG } from '../../config.js';
import { log } from '../../log.js';
import { parseJsonLoose, tidy } from '../filter.js';
import type { PromptSpec, TextProvider } from './types.js';

const logger = log.child('gemini');

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

export class GeminiTextProvider implements TextProvider {
  readonly name = 'gemini';

  private model(tier: PromptSpec['tier']): string {
    return tier === 'live' ? CONFIG.gemini.modelLive : CONFIG.gemini.modelFast;
  }

  async generate(prompt: PromptSpec): Promise<string[]> {
    const body = {
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      generationConfig: {
        maxOutputTokens: prompt.maxTokens ?? 512,
        temperature: 1.0,
        ...(prompt.json ? { responseMimeType: 'application/json' } : {}),
      },
    };

    const text = await this.post(
      `${this.model(prompt.tier)}:generateContent`,
      body,
      prompt.timeoutMs,
    );
    if (!text) return [];
    return [text];
  }

  /**
   * Streaming generation. Gemini's streaming endpoint returns a JSON array that
   * arrives in fragments, so chunks are extracted as they appear rather than
   * waiting for a well-formed document.
   */
  async *stream(prompt: PromptSpec): AsyncIterable<string> {
    const url =
      `${CONFIG.gemini.endpoint}/${this.model(prompt.tier)}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(CONFIG.gemini.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), prompt.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: {
            maxOutputTokens: prompt.maxTokens ?? 256,
            temperature: 1.0,
          },
        }),
      });
      if (!res.ok || !res.body) {
        logger.warn('stream failed', res.status);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Server-sent events: one JSON object per `data:` line.
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload) as GeminiResponse;
            const chunk = obj.candidates?.[0]?.content?.parts?.[0]?.text;
            if (chunk) yield chunk;
          } catch {
            /* partial frame; the next read completes it */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') logger.warn('stream error', err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<string | null> {
    const url = `${CONFIG.gemini.endpoint}/${path}?key=${encodeURIComponent(CONFIG.gemini.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn('http', res.status, (await res.text()).slice(0, 200));
        return null;
      }
      const json = (await res.json()) as GeminiResponse;
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
      return text ? tidy(text) : null;
    } catch (err) {
      if ((err as Error).name === 'AbortError') logger.warn('timed out after', timeoutMs, 'ms');
      else logger.warn('request failed', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse a model's JSON reply, stripping fences defensively. */
export function parseModelJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  return parseJsonLoose<T>(raw);
}
