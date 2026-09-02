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

export interface UsagePayload {
  source: 'api' | 'error';
  harness: 'claude';
  as_of: string;
  windows?: UsageWindow[];
  unreadable_windows?: UnreadableUsageWindow[];
  error?: string;
  stale?: boolean;
}
