import { HARNESS_NAMES, runtimeHarness, type Harness } from '../harness-routing/harness.ts';
import type { AgentSpawnRecord } from './agent-spawn-records.ts';
import { isInsideWindow } from './recall-report-logs.ts';

export type UnmeasuredSessionsByHarness = Readonly<Record<string, number>>;

function hasRecallAndReadLogging(harness: string): boolean {
  return runtimeHarness(harness as Harness) === HARNESS_NAMES.CLAUDE;
}

export function unmeasuredSessionsByHarness(
  agents: readonly AgentSpawnRecord[],
  since: Date | undefined,
): UnmeasuredSessionsByHarness {
  const counts: Record<string, number> = {};
  for (const { spawn } of agents) {
    if (hasRecallAndReadLogging(spawn.harness) || !isInsideWindow(spawn.spawned_at, since)) continue;
    counts[spawn.harness] = (counts[spawn.harness] ?? 0) + 1;
  }
  return counts;
}
