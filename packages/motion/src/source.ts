/**
 * The `SwingSource` seam (design §7). W1 owns the real implementation; W3 and W4
 * develop against mocks of it.
 */

import type { Quat, SwingInput } from '@rally/protocol';

export interface SwingSource {
  onPose(cb: (q: Quat, ct: number) => void): void;
  onSwing(cb: (s: SwingInput) => void): void;
  calibrate(): Promise<void>;
}

/** A recorded sensor trace, for offline iteration against real swings. */
export interface RecordedSample {
  t: number;
  o?: { alpha: number; beta: number; gamma: number; screen: number };
  r?: { alpha: number; beta: number; gamma: number };
  a?: { x: number; y: number; z: number };
}

export interface Recording {
  label: string;
  device: string;
  samples: RecordedSample[];
}
