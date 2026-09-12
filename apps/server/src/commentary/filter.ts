/**
 * The snark ceiling.
 *
 * Tone rules go in the system prompt AND in an output filter, because a prompt is
 * a request and a filter is a guarantee. Player names are user input rendered to
 * audio in front of an audience; the generated text around them is a language
 * model's idea of a joke. Both get checked.
 *
 * Rejected lines fall through to the next layer rather than being patched up —
 * a mangled line is worse than the cached one it would have replaced.
 */

import { TUNING } from '@rally/protocol';

const BANNED = [
  // Profanity and slurs, stems only; matched on word boundaries below.
  'fuck', 'shit', 'cunt', 'bitch', 'bastard', 'dick', 'piss', 'whore', 'slut',
  'retard', 'idiot', 'moron', 'stupid', 'ugly', 'fat', 'dumb',
  // Anything aimed at a person rather than their play.
  'kill yourself', 'should die', 'hate you', 'worthless', 'pathetic human',
];

const PERSONAL = [
  // Family is off limits however it is phrased. A possessive-pronoun-only rule
  // misses "Ada's mother", which is exactly the line you do not want spoken
  // aloud in front of an audience.
  /\b(mother|mothers|father|fathers|mom|mum|dad|wife|husband|kids?|children|family|parents?)\b/i,
  // Appearance, but only in a possessive context. A bare `looks?` would reject
  // "make it look deliberate" and half of everything else a commentator says —
  // the rule is "never cruel about anything other than their play", not "never
  // use common English words".
  /\b(?:\w+'s|your|their|his|her|its)\s+(looks|face|body|weight|hair|skin|accent|clothes|outfit)\b/i,
  /\b(race|racist|gender|religion|ethnicity|nationality)\b/i,
  /\b(disabled|autistic|retarded|deformed)\b/i,
];

export interface FilterResult {
  ok: boolean;
  reason?: string;
  /** The line, trimmed and normalised for speech. */
  text: string;
}

/**
 * The longest line that still fits inside the hold on play.
 *
 * Speech is ~2.6 words per second and an English word is ~5.5 characters with
 * its space, so the hold's seven seconds buy about eighteen words. A tenth is
 * left as headroom for a slow voice and the network under it, because a line cut
 * off mid-sentence is worse than a line that was never written.
 */
export const LINE_MAX_CHARS = Math.floor(
  (TUNING.commentary.holdPlayMaxMs / 1000) * 2.6 * 5.5 * 0.9,
);

export function filterLine(raw: string, allowPlaceholders = false): FilterResult {
  const text = tidy(raw);

  if (text.length < 4) return { ok: false, reason: 'too short', text };
  /*
   * The length ceiling, and it is a real rule rather than a sanity check.
   *
   * The prompt asks for four to fourteen words, but a prompt is a request. This
   * is the guarantee, and it is set from what the line has to fit inside: speech
   * runs at about 2.6 words a second, play is held while the commentator is
   * talking, and that hold is capped at `commentary.holdPlayMaxMs`. A line
   * longer than this is one the game would start playing underneath — which is
   * the exact thing the hold exists to prevent.
   *
   * Derived, not picked: the hold on play is `commentary.holdPlayMaxMs`, speech
   * runs at about 2.6 words a second, and an English word averages 5.5
   * characters with its space. A line at the old 130 took about nine seconds to
   * say and the hold is seven, so the longest lines were the ones being talked
   * over — the exact thing the hold exists to prevent. See LINE_MAX_CHARS.
   *
   * The old note, still true about why a ceiling exists at all:
   * 130, not 240. Twice the length is twice the time the match spends waiting,
   * and a twenty-word quip is not twice as funny as a ten-word one.
   */
  if (text.length > LINE_MAX_CHARS) return { ok: false, reason: 'too long', text };

  const lower = ` ${text.toLowerCase()} `;
  for (const word of BANNED) {
    const pattern = new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i');
    if (pattern.test(lower)) return { ok: false, reason: `banned: ${word}`, text };
  }
  for (const pattern of PERSONAL) {
    if (pattern.test(text)) return { ok: false, reason: 'personal', text };
  }
  // A model that leaks its scaffolding is a model whose output we do not trust.
  // Bank lines legitimately carry `{player}` / `{opponent}`, and nothing else.
  const stripped = allowPlaceholders
    ? text.replace(/\{(player|opponent)\}/g, 'X')
    : text;
  if (/[{}[\]<>]|```|^\s*(json|system|assistant)\b/i.test(stripped)) {
    return { ok: false, reason: 'markup leak', text };
  }
  return { ok: true, text };
}

/** Clean a line up for speech: collapse whitespace, strip fences and quotes. */
export function tidy(raw: string): string {
  return raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\*+/g, '')
    .trim();
}

/**
 * Strip markdown fences before parsing JSON. Models are told "JSON only, no
 * fences" and still fence it, so do this defensively every single time.
 */
export function parseJsonLoose<T>(raw: string): T | null {
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (m.includes('```') ? '' : m))
    .replace(/```[\s\S]*$/i, '')
    .trim();
  const start = cleaned.search(/[{[]/);
  if (start < 0) return null;
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
