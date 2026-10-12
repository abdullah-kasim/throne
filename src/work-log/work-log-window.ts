export interface WorkLogWindow {
  readonly since: number;
  readonly until: number;
}

export function isInWindow(timestamp: number | null | undefined, window: WorkLogWindow): boolean {
  return timestamp != null && timestamp >= window.since && timestamp <= window.until;
}
