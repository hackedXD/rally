/**
 * mock-text — replaces Gemini.
 *
 * Returns canned lines after a configurable artificial delay, which is the only
 * practical way to test the timeout paths: the real thing is fast most of the
 * time and catastrophically slow exactly once, on stage.
 *
 *   new MockTextProvider({ delayMs: 2000 })   // trips the speculative timeout
 *   new MockTextProvider({ failRate: 1 })     // trips the fallback chain
 */

import type { PromptSpec, TextProvider } from '../../apps/server/src/commentary/providers/types.js';

export interface MockTextOptions {
  /** Artificial latency before responding. */
  delayMs?: number;
  /** Probability a call rejects, for exercising the fallback chain. */
  failRate?: number;
  /** Lines to return, cycled. */
  lines?: string[];
}

const DEFAULT_LINES = [
  'That was a decision, and it was the wrong one.',
  'Textbook. If the textbook were written by an optimist.',
  'The net remains undefeated.',
  'Somebody get that ball a passport, it is going places.',
];

export class MockTextProvider implements TextProvider {
  readonly name = 'mock-text';
  private calls = 0;

  constructor(private readonly opts: MockTextOptions = {}) {}

  get callCount(): number {
    return this.calls;
  }

  async generate(prompt: PromptSpec): Promise<string[]> {
    this.calls++;
    await sleep(this.opts.delayMs ?? 20);
    if (Math.random() < (this.opts.failRate ?? 0)) throw new Error('mock-text: simulated failure');
    const lines = this.opts.lines ?? DEFAULT_LINES;

    if (!prompt.json) return [lines[this.calls % lines.length]];

    // Mimic the shapes the real prompts ask for, fences included, so the
    // defensive parsing gets exercised too.
    if (prompt.user.includes('"newBit"')) {
      return [
        '```json\n' +
          JSON.stringify({ line: lines[this.calls % lines.length], newBit: null }) +
          '\n```',
      ];
    }
    const keys = [...prompt.user.matchAll(/"([a-z0-9._]+)":/gi)].map((m) => m[1]);
    const out: Record<string, unknown> = {};
    for (const [i, key] of keys.entries()) {
      out[key] = prompt.user.includes('outcome id')
        ? lines[(this.calls + i) % lines.length]
        : [lines[i % lines.length], lines[(i + 1) % lines.length]];
    }
    return [JSON.stringify(out)];
  }

  async *stream(prompt: PromptSpec): AsyncIterable<string> {
    this.calls++;
    const lines = this.opts.lines ?? DEFAULT_LINES;
    const text = lines[this.calls % lines.length];
    void prompt;
    for (const word of text.split(' ')) {
      await sleep((this.opts.delayMs ?? 20) / 8);
      yield word + ' ';
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
