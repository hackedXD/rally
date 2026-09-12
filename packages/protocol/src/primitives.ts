/**
 * Shared primitive types. Everything on the wire is built from these.
 *
 * Coordinate system (world frame, right-handed, metres):
 *   +X  across the court, toward seat 0's right
 *   +Y  up
 *   +Z  along the court's length, from seat 0's side toward seat 1's side
 *   origin at the centre of the court, on the floor, under the net
 *
 * So seat 0 lives at negative Z and hits toward +Z; seat 1 is the mirror.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w
export type Seat = 0 | 1 | 2 | 3;
export type Millis = number; // server clock, ms since match epoch
export type SportId = 'pickleball' | 'tabletennis' | 'badminton' | 'bowling';

export const SEATS: readonly Seat[] = [0, 1, 2, 3] as const;

/** The two seats used by every v1 sport. */
export type DuelSeat = 0 | 1;

export function otherSeat(seat: Seat): Seat {
  return (seat === 0 ? 1 : 0) as Seat;
}

/** Sign of the half of the court a seat plays on: seat 0 → -1, seat 1 → +1. */
export function seatSign(seat: Seat): -1 | 1 {
  return seat === 0 ? -1 : 1;
}

/**
 * Narrow a `Seat` to the 0|1 index used by two-element tuples (scores, names).
 * Seats 2 and 3 exist in the type for doubles; every v1 sport is 1v1 and folds
 * them onto the nearer lane rather than widening every tuple in the protocol.
 */
export function lane(seat: Seat): 0 | 1 {
  return seat === 0 || seat === 2 ? 0 : 1;
}
