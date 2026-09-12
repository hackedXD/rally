/**
 * The player's name: generated once, remembered, and editable.
 *
 * Lives in the contract package rather than in either client because both of
 * them read and write the SAME browser key, and the server sanitises what
 * arrives with the same `sanitizeName` two files over. Three copies of one
 * string constant is how the phone and the screen end up remembering two
 * different names for one person.
 *
 * ── Reaching storage through `globalThis` ────────────────────────────────────
 *
 * This package is compiled twice: with the DOM lib for the two browser apps, and
 * without it for the server and the simulation. `localStorage` is therefore not
 * a name that type-checks here, and it is not a thing that EXISTS on the server
 * either. Going through `globalThis` says both of those out loud, and makes the
 * no-storage case — Node, a private window, a browser set to refuse — an
 * ordinary branch rather than a thrown exception on a page that then renders
 * blank.
 */

import { NAME_MAX, sanitizeName } from './schemas.js';

/** The browser key. One key, one name, both surfaces. */
export const NAME_KEY = 'rally.name';

/*
 * Module scope is safe for these, where it was not inside the controller.
 *
 * The phone loads its name while its own module body is still evaluating, and a
 * `const` further down THAT file is in the temporal dead zone at the time —
 * reaching one throws, and the page renders blank. An import is different: this
 * module is fully evaluated before the importing module's first line runs, so
 * the lists are built by the time anything can ask for a name.
 */
const ADJECTIVES = ['Swift', 'Lucky', 'Bold', 'Calm', 'Sly', 'Keen', 'Wild'];
const NOUNS = ['Otter', 'Falcon', 'Comet', 'Pike', 'Ember', 'Moth', 'Fox'];

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's storage, or nothing at all. Never throws. */
function storage(): Storage | null {
  const store = (globalThis as { localStorage?: Storage }).localStorage;
  return store ?? null;
}

/** A speakable name for somebody who has not chosen one. */
export function randomName(): string {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
  return sanitizeName(`${pick(ADJECTIVES)} ${pick(NOUNS)}`);
}

/**
 * This player's name: what they chose, or one invented and kept.
 *
 * Sanitised on the way OUT as well as in. A name stored before this field was
 * editable, or by a hand-edited devtools entry, is still user input by the time
 * the commentator reads it aloud.
 */
export function loadName(): string {
  const stored = storage()?.getItem(NAME_KEY);
  if (typeof stored === 'string' && stored.trim()) return sanitizeName(stored);
  const name = randomName();
  saveName(name);
  return name;
}

/**
 * Remember a name, and return the form that was actually stored.
 *
 * Returning the cleaned string rather than the raw one is what keeps a text box
 * honest: the caller renders what the commentator will say, not what was typed.
 */
export function saveName(raw: string): string {
  const name = sanitizeName(raw);
  try {
    storage()?.setItem(NAME_KEY, name);
  } catch {
    // Private browsing, or a quota. A name that is not remembered is still a
    // name; it must not take the page down with it.
  }
  return name;
}

/**
 * A half-typed name, kept typeable.
 *
 * What the text boxes run on every keystroke, and NOT `sanitizeName`: that one
 * trims and substitutes "Player" for anything empty, so it would eat the
 * trailing space of "Ada " the moment it was typed and make the surname
 * unreachable. This only removes what can never be part of a name.
 *
 * It filters rather than rejects, which is the difference between a paste of
 * "Ada <3" landing as "Ada 3" and the box silently ignoring the paste — the
 * second looks broken, and the whole point of cleaning as they type is that the
 * rules are visible rather than sprung on them at Save.
 */
export function filterName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 '-]/g, '').slice(0, NAME_MAX);
}
