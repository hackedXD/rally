/**
 * The palette, shared between the stylesheet and the renderer.
 *
 * `styles.css` owns these values; three.js cannot read a stylesheet, so the
 * literals below are the renderer's copy of them. Rather than let the two drift,
 * `syncTheme()` reads the custom properties back off `:root` at boot and
 * overwrites the literals — the same trick `courts.ts` uses to keep its court
 * dimensions honest against the server.
 *
 * Only the five paint values are shared. Everything that exists solely in three
 * dimensions — skin, grip, net posts — lives here and nowhere else.
 */

export interface Palette {
  /** In-bounds playing surface. */
  court: string;
  /** The lighter band the court is striped against. */
  courtAlt: string;
  /** Non-volley zone: painted a contrasting green on a real court. */
  kitchen: string;
  /** Out-of-bounds apron, and the world behind it. */
  apron: string;
  apronDeep: string;
  /** Tape. Never type on the green — it measures 3.85:1. */
  line: string;
  ink: string;
  inkBlue: string;
  /** Gold Thread. The ball, and the only thing allowed to signal "live". */
  optic: string;
  chalk: string;
  flag: string;
}

export const PALETTE: Palette = {
  court: '#009647',
  courtAlt: '#00a84f',
  kitchen: '#00753a',
  apron: '#043673',
  apronDeep: '#02224a',
  line: '#ffffff',
  ink: '#011206',
  inkBlue: '#031a3a',
  optic: '#FDB515',
  chalk: '#e8f0ff',
  flag: '#C41230',
};

const VARS: Record<keyof Palette, string> = {
  court: '--court',
  courtAlt: '--court-alt',
  kitchen: '--kitchen',
  apron: '--apron',
  apronDeep: '--apron-deep',
  line: '--line',
  ink: '--ink',
  inkBlue: '--ink-blue',
  optic: '--optic',
  chalk: '--chalk',
  flag: '--flag',
};

/**
 * Reconcile the renderer's copy against the stylesheet.
 *
 * Called once from `main.tsx`, before anything paints. A value edited in CSS
 * therefore reaches the 3D court too, and a mismatch is impossible rather than
 * merely discouraged.
 */
export function syncTheme(): void {
  const style = getComputedStyle(document.documentElement);
  for (const [key, name] of Object.entries(VARS) as [keyof Palette, string][]) {
    const value = style.getPropertyValue(name).trim();
    if (value) PALETTE[key] = value;
  }
}
