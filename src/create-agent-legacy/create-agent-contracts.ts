import type { CapabilityEvidence } from "./legacy-capabilities.ts";
import type { DurableBypassAuthorizationRegistry } from "./durable-bypass-authorization.ts";

export type CreateAgentWriter = (text: string) => void;

export interface CreateAgentOutputDeps {
  writeStdout?: CreateAgentWriter;
  writeStderr?: CreateAgentWriter;
  now?: () => string;
}

export interface CustomHarnessFlags {
  env?: string[];
  "stdout-path"?: string;
  "stderr-path"?: string;
  "exit-status-path"?: string;
  "wall-time-path"?: string;
  "launcher-evidence-path"?: string;
  "timeout-ms"?: string;
}

export interface CustomHarnessRequest {
  flags: CustomHarnessFlags;
  passthrough?: string[];
  name: string;
  cwd: string;
  requestedExecutable?: string;
  launchHarness: string;
  launchModel: string;
  launchEffort: number;
}

export interface UsageBypassAuthorizationEvidence {
  authorizer: "Lord" | "Regent";
  objective_code: string;
  recipient: string;
  evidence_locator: string;
}

export interface UsageBypassAuthorizationRegistry {
  version: 1;
  authorizations: Array<
    UsageBypassAuthorizationEvidence & { expires_at: string }
  >;
}

/** Mirrors `UsageBypassAuthorizationRegistry` above: `--bypass-model`'s
 *  registry type lives here (not in `model-bypass-authorization.ts`) so
 *  `create.types.ts` can depend on it without depending on the module that
 *  itself depends on `create.types.ts`. */
export type ModelBypassAuthorizationRegistry =
  DurableBypassAuthorizationRegistry;

export interface StagerRouteAuthorizationEvidence {
  authorizer: "Lord";
  recipient: string;
  harness: string;
  model: string;
  evidence_locator: string;
}

export interface CreateAgentRequestShape {
  flags: object;
  passthrough?: string[];
  oneShot: boolean;
  harness: string;
  model: string;
  requestedEffort?: number;
  requestedExecutable?: string;
  role: string;
  requestedName: string;
  name: string;
  requestedCwd: string;
  emptyWorktree?: boolean;
}

export interface PolicyResolutionShape extends CreateAgentRequestShape {
  launchHarness: string;
  launchModel: string;
  launchEffort: number;
  cwd: string;
  resuming: boolean;
  customExecutable?: string;
  customPassthrough: string[];
  routingNote: string;
  durableRoutingNote: boolean;
  capabilityEvidence?: CapabilityEvidence;
  capabilityOverrideNote: string;
  effortOverrideNote: string;
  harnessOverrideNote: string;
  usageBypassAuthorization?: UsageBypassAuthorizationEvidence;
  stagerRouteAuthorization?: StagerRouteAuthorizationEvidence;
}

export interface StageSuccess<T> {
  ok: true;
  value: T;
}

export interface StageRefusal {
  ok: false;
  code: number;
}

export type StageResult<T> = StageSuccess<T> | StageRefusal;
