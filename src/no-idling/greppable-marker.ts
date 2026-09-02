export const REAPABLE_MARKER_COMPLETED = '__REAPABLE__COMPLETED__';
export const REAPABLE_MARKER_CANCELLED = '__REAPABLE_CANCELLED__';
export const REAPABLE_MARKER_TASK_RESTART_REQUIRED =
  '__REAPABLE_TASK_RESTART_REQUIRED__';
export const REAPABLE_MARKER_FAIL = '__REAPABLE_FAIL__';

export const REAPABLE_MARKERS = [
  REAPABLE_MARKER_COMPLETED,
  REAPABLE_MARKER_CANCELLED,
  REAPABLE_MARKER_TASK_RESTART_REQUIRED,
  REAPABLE_MARKER_FAIL,
] as const;

export const REAPABLE_MARKER_PATTERN =
  /__REAPABLE(?:__|_)[A-Z0-9]+(?:_[A-Z0-9]+)*__/;

export function parseReapableMarkers(text: string): readonly string[] {
  const matches: string[] = [];
  const field = /"reapable_status"\s*:\s*"([^"]+)"/g;
  for (const match of text.matchAll(field)) {
    const raw = match[1]!;
    if (REAPABLE_MARKER_PATTERN.test(raw)) {
      matches.push(raw);
    }
  }
  return matches;
}

export const BLOCKED_BY_MARKER_PATTERN =
  /__BLOCKED_BY_([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)__/;

export function parseBlockedByMarkers(text: string): readonly string[] {
  const names: string[] = [];
  for (const match of text.matchAll(
    new RegExp(BLOCKED_BY_MARKER_PATTERN.source, 'g'),
  )) {
    names.push(match[1]!);
  }
  return names;
}
