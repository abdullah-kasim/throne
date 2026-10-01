import {
  planRolePool,
  targetEffortForRole,
  activePlanPresetName,
  type EffortRole,
  type ModelPairPool,
  type PlanRole,
} from "../config.ts";
import { configuredRegentLaunch } from "../regent-state/regent-state.service.ts";
import { steeringUserConfigPath } from "../steering-user-config.ts";
import { resolveLiveThroneRoot } from "../throne-root-resolution.ts";

const EFFORT_NAMES = ["", "low", "medium", "high", "xhigh", "max", "ultracode"];

const POOL_ROLES: readonly { planRole: PlanRole; effortRole: EffortRole }[] = [
  { planRole: "Alpha", effortRole: "alpha" },
  { planRole: "Shadow", effortRole: "shadow" },
  { planRole: "ShadowSlice99", effortRole: "shadowSlice99" },
  { planRole: "Stager", effortRole: "stager" },
];

function describePool(pool: ModelPairPool): string {
  return pool.map(({ harness, model }) => `${harness}/${model}`).join(", ");
}

function describeEffort(effort: number): string {
  return `${effort} (${EFFORT_NAMES[effort] ?? "unknown"} on claude)`;
}

export function renderResolvedSteering(configPath: string): string {
  const lines = [
    `check-config: ${configPath} loaded and validated.`,
    `plan preset: ${activePlanPresetName()}`,
  ];
  for (const { planRole, effortRole } of POOL_ROLES) {
    lines.push(
      `${planRole}: ${describePool(planRolePool(planRole))} at effort ${describeEffort(targetEffortForRole(effortRole))}`,
    );
  }
  const regent = configuredRegentLaunch();
  lines.push(
    regent === undefined
      ? "Regent: no regentRoute; launches as before (recorded route at effort 1, or bare claudey)"
      : `Regent: ${regent.harness}/${regent.model} at effort ${describeEffort(regent.effort)}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function run(): Promise<number> {
  const configPath = steeringUserConfigPath(await resolveLiveThroneRoot());
  process.stdout.write(renderResolvedSteering(configPath));
  return 0;
}
