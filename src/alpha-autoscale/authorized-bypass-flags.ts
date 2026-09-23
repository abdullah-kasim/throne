import {
  readModelBypassAuthorizationRegistry,
  resolveModelBypassAuthorization,
} from "../create-agent-legacy/model-bypass-authorization.ts";
import {
  readUsageBypassAuthorizationRegistry,
  resolveUsageBypassAuthorization,
} from "../create-agent-legacy/usage-bypass-authorization.ts";

export interface BypassRegistries {
  readonly modelRegistry: unknown;
  readonly usageRegistry: unknown;
}

export function bypassFlagsAuthorizedInRegistries(
  registries: BypassRegistries,
  objectiveCode: string,
  alphaName: string,
  now: string,
): readonly string[] {
  const modelAuthorization = resolveModelBypassAuthorization({
    registry: registries.modelRegistry,
    objectiveCode,
    recipient: alphaName,
    recipientRole: "Alpha",
    now,
  });
  const usageAuthorization = resolveUsageBypassAuthorization({
    registry: registries.usageRegistry,
    objectiveCode,
    recipient: alphaName,
    now,
  });
  return [
    ...(modelAuthorization.kind === "authorized" ? ["--bypass-model"] : []),
    ...(usageAuthorization.kind === "authorized" ? ["--bypass-usage"] : []),
  ];
}

async function registryOrNothing(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

export async function readBypassFlagsAuthorizedForAlpha(
  objectiveCode: string,
  alphaName: string,
): Promise<readonly string[]> {
  return bypassFlagsAuthorizedInRegistries(
    {
      modelRegistry: await registryOrNothing(() => readModelBypassAuthorizationRegistry()),
      usageRegistry: await registryOrNothing(() => readUsageBypassAuthorizationRegistry()),
    },
    objectiveCode,
    alphaName,
    new Date().toISOString(),
  );
}
