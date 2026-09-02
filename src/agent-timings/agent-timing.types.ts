import { isReapReason, type ReapReason } from './reap-reason.ts';

export interface AgentTimingRow {
  name: string;
  role: string;
  harness: string | null;
  model: string | null;
  spawned_at: string | null;
  reaped_at: string;
  reap_reason: ReapReason;
  duration_ms: number | null;
}

export function buildAgentTimingRow(input: {
  name: string;
  role: string;
  harness: string | null;
  model: string | null;
  spawnedAt: string | null;
  reapedAt: string;
  reapReason: ReapReason;
}): AgentTimingRow {
  let durationMs: number | null = null;
  if (input.spawnedAt !== null) {
    const spawnedAtMs = Date.parse(input.spawnedAt);
    const reapedAtMs = Date.parse(input.reapedAt);
    const differenceMs = reapedAtMs - spawnedAtMs;
    if (Number.isFinite(spawnedAtMs) && Number.isFinite(reapedAtMs) && differenceMs >= 0) durationMs = differenceMs;
  }
  return {
    name: input.name,
    role: input.role,
    harness: input.harness,
    model: input.model,
    spawned_at: input.spawnedAt,
    reaped_at: input.reapedAt,
    reap_reason: input.reapReason,
    duration_ms: durationMs,
  };
}

export function serializeAgentTimingRow(row: AgentTimingRow): string {
  return `${JSON.stringify(row)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function toAgentTimingRow(value: unknown): AgentTimingRow | undefined {
  if (!isRecord(value)) return undefined;
  const { name, role, harness, model, spawned_at, reaped_at, reap_reason, duration_ms } = value;
  if (typeof name !== 'string' || name.trim() === '' || typeof role !== 'string' ||
    !isNullableString(harness) || !isNullableString(model) || !isNullableString(spawned_at) ||
    typeof reaped_at !== 'string' || reaped_at.trim() === '' || typeof reap_reason !== 'string' ||
    !isReapReason(reap_reason) || (duration_ms !== null && typeof duration_ms !== 'number')) return undefined;
  return { name, role, harness, model, spawned_at, reaped_at, reap_reason, duration_ms };
}

export function parseAgentTimings(raw: string): AgentTimingRow[] {
  const rows: AgentTimingRow[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = toAgentTimingRow(JSON.parse(line));
      if (row !== undefined) rows.push(row);
    } catch {}
  }
  return rows;
}
