import { DEFAULT_DATA_DIR } from '../agentdata/spawn-data-contracts.ts';
import type { UsageBypassAuthorizationEvidence } from "./create.types.ts";
import type { UsageBypassAuthorizationRegistry } from "./create-agent-contracts.ts";
import type {
  CreateAgentDeps,
  RegistrationResolution,
  StageResult,
} from "./create.types.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";
import { currentIsoTime, stderrWriter } from "./command-context.ts";
import {
  readDurableBypassAuthorizationRegistry,
  resolveDurableBypassAuthorization,
  type DurableBypassAuthorizationResolution,
} from "./durable-bypass-authorization.ts";

const AUTHORIZATION_FILE = "bypass-usage-authorizations.json";
const USAGE_BYPASS_AUTHORIZERS = new Set(["Lord", "Regent"]);

export type UsageBypassAuthorizationResolution =
  DurableBypassAuthorizationResolution;

export async function readUsageBypassAuthorizationRegistry(
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<UsageBypassAuthorizationRegistry> {
  return readDurableBypassAuthorizationRegistry(
    AUTHORIZATION_FILE,
    dataDir,
  ) as Promise<UsageBypassAuthorizationRegistry>;
}

export function resolveUsageBypassAuthorization(opts: {
  registry: unknown;
  objectiveCode: string | undefined;
  recipient: string;
  now: string;
}): UsageBypassAuthorizationResolution {
  return resolveDurableBypassAuthorization({
    registry: opts.registry,
    objectiveCode: opts.objectiveCode,
    recipient: opts.recipient,
    now: opts.now,
    registryLabel: `Regent-owned ${AUTHORIZATION_FILE}`,
    flagLabel: "--bypass-usage",
    allowedAuthorizers: USAGE_BYPASS_AUTHORIZERS,
  });
}

export async function authorizeUsageBypass(
  request: RegistrationResolution,
  objectiveContract: ObjectiveContract | undefined,
  deps: CreateAgentDeps,
): Promise<StageResult<UsageBypassAuthorizationEvidence | undefined>> {
  if (request.resuming || request.flags["bypass-usage"] !== true) {
    return { ok: true, value: undefined };
  }
  let registry: unknown;
  try {
    registry = await deps.readUsageBypassAuthorizations?.();
  } catch {
    registry = undefined;
  }
  const authorization = resolveUsageBypassAuthorization({
    registry,
    objectiveCode:
      objectiveContract?.kind === "campaign"
        ? objectiveContract.objectiveCode
        : undefined,
    recipient: request.name,
    now: currentIsoTime(deps),
  });
  if (authorization.kind === "authorized") {
    return { ok: true, value: authorization.evidence };
  }
  stderrWriter(deps)(
    `create-agent: refusing --bypass-usage for "${request.name}" — ${authorization.reason}. ` +
      "Nothing was registered, trusted, routed, or launched.\n",
  );
  return { ok: false, code: 1 };
}
