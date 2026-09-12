/**
 * The prompts.
 *
 * This is where the tone ceiling and the specificity rules live. Two things in
 * here are load-bearing beyond "ask nicely":
 *
 *   - FACTS must be cited. Generic commentary is the failure mode, and the only
 *     cure is handing over concrete detail and insisting it gets used.
 *   - `newBit` round-trips. The commentator coins "the Kitchen Lawyer" at point
 *     two, the string lands in RUNNING_BITS, and by match point it is being
 *     called back. Judges notice it immediately and it is about thirty lines.
 */

import { CUE_CLASSES, TUNING, type CueClass } from '@rally/protocol';
import { log } from '../../log.js';
import { filterLine, tidy } from '../filter.js';
import type { MatchNarrative } from '../narrative.js';
import { parseModelJson } from './gemini.js';
import type {
  LineContext,
  LiveLine,
  SpecOutcome,
  TextProvider,
  Writer,
} from './types.js';

const logger = log.child('writer');

const TONE = `You are a professional {sport} commentator with the enthusiasm of a
championship caller and the restraint of nobody. You are funny, sharp, and you
roast players for bad shots. You are never cruel about anything other than their
play. No profanity. No comments on appearance, identity, or anything outside this
match.

LENGTH IS THE HARDEST RULE HERE. Most lines are 4 to 10 words. Never more than
14. One sentence, two at a push, and the second is shorter than the first. A
line is spoken over live play at about two and a half words a second, so twenty
words is eight seconds of talking across a rally that lasted three.

Cut every word that is not doing work. "That is a lovely shot from him there"
is "Lovely." Dry beats elaborate; the joke is in what you leave out. Land the
hit and stop — do not explain it, and never add a second clause that restates
the first.

You are speaking aloud; write for the ear. No stage directions, no emoji, no
markdown.`;

const RULES = `RULES
- Reference at least one specific fact from FACTS. Generic commentary is failure.
- Never reuse phrasing from RECENT_QUIPS.
- If RUNNING_BITS is non-empty, call back to one roughly every third line.
- You may coin at most one new nickname or running joke per match.
  If you do, return it in "newBit".
- A "stall" cue means NOTHING is happening: the ball is out of play and the
  player whose serve it is has not served. Fill the silence — that is the whole
  job. Amused, not alarmed: they have wandered off, not broken the game. Never
  describe a shot here, because there has not been one.`;

export class GeminiWriter implements Writer {
  readonly name = 'gemini';

  constructor(private readonly text: TextProvider) {}

  async bank(
    narrative: MatchNarrative,
    classes: readonly CueClass[],
    perClass: number,
  ): Promise<Map<CueClass, string[]>> {
    const out = new Map<CueClass, string[]>();
    const names = narrative.players.map((p) => p.name);
    const keys = classes.filter((c) => CUE_CLASSES.includes(c));

    const user = `The players are ${names[0]} and ${names[1]}, playing ${narrative.sport}.
Write ${perClass} interchangeable commentary lines for each situation below.
These are pre-recorded reactions, so they must make sense without knowing the
score.

Write "{player}" for the player the line is about and "{opponent}" for the other
one — NEVER a real name. Both get substituted before the line is spoken, so a
line written for one player works for either.

Return JSON only, no markdown fences, shaped exactly:
{${keys.map((k) => `\n  "${k}": ["...", "..."]`).join(',')}
}`;

    const replies = await this.text.generate({
      system: TONE.replace('{sport}', narrative.sport),
      user,
      json: true,
      tier: 'fast',
      maxTokens: 2048,
      timeoutMs: 20_000,
    });

    const parsed = parseModelJson<Record<string, unknown>>(replies[0]);
    if (!parsed) {
      logger.warn('cold bank did not parse');
      return out;
    }
    for (const cls of keys) {
      const raw = parsed[cls];
      if (!Array.isArray(raw)) continue;
      const lines = raw
        .filter((l): l is string => typeof l === 'string')
        .map((l) => filterLine(l, true))
        .filter((r) => r.ok)
        .map((r) => r.text);
      if (lines.length) out.set(cls, lines);
    }
    return out;
  }

  async speculate(
    narrative: MatchNarrative,
    outcomes: readonly SpecOutcome[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!outcomes.length) return out;

    const user = `${RULES}

STATE
${JSON.stringify(compact(narrative))}

The rally is live. Write one line for each of these possible next outcomes.
Return JSON only, keyed by outcome id:
{${outcomes.map((o) => `\n  "${o.key}": "..."   // ${o.describe}`).join(',')}
}`;

    const replies = await this.text.generate({
      system: TONE.replace('{sport}', narrative.sport),
      user,
      json: true,
      tier: 'fast',
      maxTokens: 400,
      timeoutMs: TUNING.commentary.speculativeTimeoutMs,
    });

    const parsed = parseModelJson<Record<string, unknown>>(replies[0]);
    if (!parsed) return out;
    for (const o of outcomes) {
      const raw = parsed[o.key];
      if (typeof raw !== 'string') continue;
      const r = filterLine(raw);
      if (r.ok) out.set(o.key, r.text);
    }
    return out;
  }

  async live(ctx: LineContext): Promise<LiveLine> {
    const user = `${RULES}

STATE
${JSON.stringify({ ...compact(ctx.narrative), cue: ctx.cls, detail: ctx.data })}

Return JSON only: { "line": string, "newBit": string | null }`;

    const replies = await this.text.generate({
      system: TONE.replace('{sport}', ctx.narrative.sport),
      user,
      json: true,
      tier: 'live',
      maxTokens: 200,
      timeoutMs: TUNING.commentary.liveTimeoutMs,
    });

    const parsed = parseModelJson<{ line?: unknown; newBit?: unknown }>(replies[0]);
    const line = typeof parsed?.line === 'string' ? parsed.line : '';
    const result = filterLine(line);
    if (!result.ok) {
      if (line) logger.warn('live line rejected:', result.reason);
      return { line: '', newBit: null };
    }
    const bit =
      typeof parsed?.newBit === 'string' && parsed.newBit.trim().length > 1
        ? tidy(parsed.newBit).slice(0, 40)
        : null;
    // A nickname is spoken aloud too, so it passes the same filter.
    const bitOk = bit && filterLine(bit).ok ? bit : null;
    return { line: result.text, newBit: bitOk };
  }

  /**
   * Token stream for the live layer, fed straight into the voice socket so
   * synthesis starts before the writing has finished.
   *
   * Plain text, not JSON: a stream you have to wait for the closing brace of is
   * not a stream. The `newBit` round trip belongs to the non-streaming path.
   */
  liveStream(ctx: LineContext): AsyncIterable<string> {
    const user = `${RULES}

STATE
${JSON.stringify({ ...compact(ctx.narrative), cue: ctx.cls, detail: ctx.data })}

Write ONE spoken line. Plain text only — no JSON, no quotes, no markdown.`;
    return this.text.stream({
      system: TONE.replace('{sport}', ctx.narrative.sport),
      user,
      json: false,
      tier: 'live',
      maxTokens: 120,
      timeoutMs: TUNING.commentary.liveTimeoutMs,
    });
  }
}

/** Trim the narrative to what the writer can actually use. */
function compact(n: MatchNarrative) {
  return {
    score: n.score,
    serving: n.serving,
    phase: n.phase,
    rally: n.rally,
    lastEvent: n.lastEvent,
    players: n.players.map((p) => ({
      name: p.name,
      whiffs: p.whiffs,
      netErrors: p.netErrors,
      outErrors: p.outErrors,
      pointsInARow: p.pointsInARow,
      avgSwingSpeed: p.avgSwingSpeed,
      signatureShot: p.signatureShot,
    })),
    FACTS: n.facts,
    RECENT_QUIPS: n.recentQuips,
    RUNNING_BITS: n.runningBits,
  };
}
