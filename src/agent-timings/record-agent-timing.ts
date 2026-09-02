import {
  readAgentRole,
  identityFieldForRecording,
} from '../agentdata/identity-data.service.ts';
import { agentRegistrationExists, readSpawnSpec, type SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { realAppendAgentTiming, type AppendAgentTiming } from './agent-timing-log.ts';
import { buildAgentTimingRow, type AgentTimingRow } from './agent-timing.types.ts';
import type { ReapReason } from './reap-reason.ts';

export interface RecordAgentTimingDeps {
  registrationExists: (name: string) => Promise<boolean>;
  readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  readAgentRole: typeof readAgentRole;
  appendTiming: AppendAgentTiming;
  now: () => string;
}

export const REAL_RECORD_DEPS: RecordAgentTimingDeps = {
  registrationExists: agentRegistrationExists,
  readSpawnSpec,
  readAgentRole,
  appendTiming: realAppendAgentTiming(),
  now: () => new Date().toISOString(),
};

export async function recordAgentTiming(name: string, reapReason: ReapReason, deps: RecordAgentTimingDeps = REAL_RECORD_DEPS): Promise<void> {
  if (!(await deps.registrationExists(name))) return;
  const spec = await deps.readSpawnSpec(name);
  const row: AgentTimingRow = buildAgentTimingRow({
    name,
    role: identityFieldForRecording(await deps.readAgentRole(name)),
    harness: spec?.harness ?? null,
    model: spec?.model ?? null,
    spawnedAt: spec?.spawned_at ?? null,
    reapedAt: deps.now(),
    reapReason,
  });
  await deps.appendTiming(row);
}
