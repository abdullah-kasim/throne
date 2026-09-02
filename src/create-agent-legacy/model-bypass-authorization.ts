import { DEFAULT_DATA_DIR } from "./legacy-spawn-data-contracts.ts";
import type {
  CreateAgentDeps,
  RegistrationResolution,
} from "./create.types.ts";
import type { ModelBypassAuthorizationRegistry } from "./create-agent-contracts.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";
import { currentIsoTime } from "./command-context.ts";
import {
  readDurableBypassAuthorizationRegistry,
  resolveDurableBypassAuthorization,
  type DurableBypassAuthorizationEvidence,
  type DurableBypassAuthorizationResolution,
} from "./durable-bypass-authorization.ts";

const AUTHORIZATION_FILE = "bypass-model-authorizations.json";
const REGENT_RECIPIENT_AUTHORIZERS: ReadonlySet<"Lord" | "Regent"> = new Set([
  "Lord",
]);
const ALPHA_OR_SHADOW_RECIPIENT_AUTHORIZERS: ReadonlySet<"Lord" | "Regent"> =
  new Set(["Lord", "Regent"]);

export type ModelBypassAuthorizationEvidence =
  DurableBypassAuthorizationEvidence;
export type ModelBypassAuthorizationResolution =
  DurableBypassAuthorizationResolution;

export async function readModelBypassAuthorizationRegistry(
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<ModelBypassAuthorizationRegistry> {
  return readDurableBypassAuthorizationRegistry(AUTHORIZATION_FILE, dataDir);
}

export function modelBypassAllowedAuthorizers(
  recipientRole: string,
): ReadonlySet<"Lord" | "Regent"> {
  return recipientRole.trim().toLowerCase() === "regent"
    ? REGENT_RECIPIENT_AUTHORIZERS
    : ALPHA_OR_SHADOW_RECIPIENT_AUTHORIZERS;
}

export function resolveModelBypassAuthorization(opts: {
  registry: unknown;
  objectiveCode: string | undefined;
  recipient: string;
  recipientRole: string;
  now: string;
}): ModelBypassAuthorizationResolution {
  return resolveDurableBypassAuthorization({
    registry: opts.registry,
    objectiveCode: opts.objectiveCode,
    recipient: opts.recipient,
    now: opts.now,
    registryLabel: `Regent-owned ${AUTHORIZATION_FILE}`,
    flagLabel: "--bypass-model",
    allowedAuthorizers: modelBypassAllowedAuthorizers(opts.recipientRole),
  });
}

export async function authorizeModelBypass(
  request: RegistrationResolution,
  objectiveContract: ObjectiveContract | undefined,
  deps: CreateAgentDeps,
): Promise<ModelBypassAuthorizationEvidence | undefined> {
  if (request.resuming || request.flags["bypass-model"] !== true) {
    return undefined;
  }
  let registry: unknown;
  try {
    registry = await deps.readModelBypassAuthorizations?.();
  } catch {
    registry = undefined;
  }
  const authorization = resolveModelBypassAuthorization({
    registry,
    objectiveCode:
      objectiveContract?.kind === "campaign"
        ? objectiveContract.objectiveCode
        : undefined,
    recipient: request.name,
    recipientRole: request.role,
    now: currentIsoTime(deps),
  });
  return authorization.kind === "authorized"
    ? authorization.evidence
    : undefined;
}
