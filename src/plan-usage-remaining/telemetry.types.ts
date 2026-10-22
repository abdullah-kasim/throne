export interface UsageWindow {
  cap_window: string;
  used_pct: number;
  remaining_pct: number;
  reset_time?: string;
  severity?: string;
  scope_model?: string;
  projected_remaining_pct?: number | null;
}

export interface UnreadableUsageWindow {
  cap_window: string;
  scope_model?: string;
  reset_time?: string;
  issue: 'invalid-percentage' | 'unexpected-shape';
}

export const USAGE_READING_SOURCES = {
  FRESH: 'fresh',
  CACHED: 'cached',
  LAST_GOOD_AFTER_RATE_LIMIT: 'last good after a 429',
} as const;

export type UsageReadingSource = (typeof USAGE_READING_SOURCES)[keyof typeof USAGE_READING_SOURCES];

export interface UsagePayload {
  source: 'api' | 'error';
  harness: 'claude';
  as_of: string;
  windows?: UsageWindow[];
  unreadable_windows?: UnreadableUsageWindow[];
  error?: string;
  reading_source?: UsageReadingSource;
}
