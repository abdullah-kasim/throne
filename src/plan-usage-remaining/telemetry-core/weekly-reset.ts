import { MODEL_NAMES } from '../../harness-routing/harness.ts';

export const WEEKLY_CAP_WINDOW = 'weekly';
const SCOPED_WEEKLY_CAP_WINDOW_PREFIX = 'weekly:';

export interface WeeklyResetReading {
  cap_window: string;
  scope_model?: string;
  reset_time?: string | null;
}

export function isFableWeeklyReading(reading: WeeklyResetReading): boolean {
  if (!reading.cap_window.startsWith(SCOPED_WEEKLY_CAP_WINDOW_PREFIX)) return false;
  const scope =
    reading.scope_model ??
    reading.cap_window.slice(SCOPED_WEEKLY_CAP_WINDOW_PREFIX.length);
  return scope.toLowerCase() === MODEL_NAMES.FABLE;
}

export function contemporaneousWeeklyReset(
  batch: readonly WeeklyResetReading[],
): string | undefined {
  return (
    batch.find((reading) => reading.cap_window === WEEKLY_CAP_WINDOW)?.reset_time ??
    undefined
  );
}
