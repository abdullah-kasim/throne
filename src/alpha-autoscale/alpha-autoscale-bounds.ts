import type { PressureClassification } from "../pressure-signal/classify-pressure.ts";

/**
 * QUOTA IS NOT PSI: pressure cannot grant launch permission.
 * LOW PRESSURE IS NOT DEMAND: it only exposes bounded capacity for an already-eligible launch.
 */
export const ALPHA_LIVE_FLOOR_MINIMUM = 4;
export const ALPHA_AUTOSCALE_HEADROOM = 2;
export const ALPHA_AUTOSCALE_HARD_MAXIMUM = 8;
export const LOW_PRESSURE_CAPACITY_THRESHOLD = 20;

if (ALPHA_AUTOSCALE_HEADROOM <= 0) {
  throw new Error("Alpha autoscale headroom must be positive");
}

export const ALPHA_AUTOSCALE_BOUNDS = {
  floor: ALPHA_LIVE_FLOOR_MINIMUM,
  headroom: ALPHA_AUTOSCALE_HEADROOM,
  ceiling: ALPHA_LIVE_FLOOR_MINIMUM + ALPHA_AUTOSCALE_HEADROOM,
  hardMaximum: ALPHA_AUTOSCALE_HARD_MAXIMUM,
} as const;

export function effectiveAlphaCapacity(
  pressure: PressureClassification,
): number {
  return pressure.pressure !== null &&
    pressure.pressure <= LOW_PRESSURE_CAPACITY_THRESHOLD
    ? ALPHA_AUTOSCALE_BOUNDS.hardMaximum
    : ALPHA_AUTOSCALE_BOUNDS.ceiling;
}
