/**
 * Court dimensions, mirrored from the sport modules.
 *
 * The display imports only `@rally/protocol` (coding standard 4), so it cannot
 * reach into `@rally/sim` for a `SportModule`. These few numbers are the price of
 * that boundary, and they are checked against the server's `/api/sports` at
 * runtime so they cannot drift silently.
 */

import type { CourtSpec, SportId } from '@rally/protocol';

export const COURTS: Record<SportId, CourtSpec> = {
  pickleball: {
    length: 13.41,
    width: 6.1,
    netHeight: 0.86,
    nonVolleyZone: 2.13,
    surround: 3.2,
    tableHeight: 0,
  },
  tabletennis: {
    length: 7.2,
    width: 3.3,
    netHeight: 0.34,
    nonVolleyZone: 0,
    surround: 2.4,
    tableHeight: 0.76,
  },
  bowling: {
    length: 18.29,
    width: 1.05,
    netHeight: 0,
    nonVolleyZone: 0,
    surround: 1.2,
    tableHeight: 0,
  },
};

/**
 * Reconcile against the server so a change to a sport module is visible here
 * without a redeploy, and a mismatch is loud rather than mysterious.
 */
export async function syncCourts(): Promise<void> {
  try {
    const res = await fetch('/api/sports');
    if (!res.ok) return;
    const json = (await res.json()) as { sports: { id: SportId; court: CourtSpec }[] };
    for (const s of json.sports) {
      if (!s.court || !COURTS[s.id]) continue;
      const before = JSON.stringify(COURTS[s.id]);
      COURTS[s.id] = s.court;
      if (before !== JSON.stringify(s.court)) {
        console.info(`[courts] ${s.id} updated from the server`);
      }
    }
  } catch {
    // Offline or pre-boot: the built-in numbers are correct for the shipped
    // sport modules, so this is a refinement rather than a requirement.
  }
}
