/**
 * @rally/motion — pure sensor fusion and swing detection.
 *
 * No DOM, no events, no clock of its own: samples in, quaternions and swings
 * out. That is what lets real swings be recorded to JSON once and then iterated
 * against forever, instead of re-testing by waving a phone around.
 */

export * from './fusion.js';
export * from './swing.js';
export * from './pingpong-swing.js';
export * from './calibration.js';
export * from './source.js';
