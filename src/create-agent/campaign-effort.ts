import type { CreateAgentDeps, RegistrationResolution } from "./create.types.ts";

export function campaignEffortOfAlpha(
  request: RegistrationResolution,
  launchEffort: number,
): number | undefined {
  if (request.resuming) return undefined;
  if (request.role.trim().toLowerCase() !== "alpha") return undefined;
  return request.requestedEffort === undefined ? undefined : launchEffort;
}

export async function inheritedCampaignEffort(
  request: RegistrationResolution,
  deps: CreateAgentDeps,
): Promise<number | undefined> {
  if (request.resuming) return undefined;
  const supervisorName = request.flags.supervisor;
  if (typeof supervisorName !== "string" || supervisorName === "") return undefined;
  const supervisorSpec = await deps.readSpawnSpec(supervisorName).catch(() => null);
  return supervisorSpec?.campaign_effort;
}
