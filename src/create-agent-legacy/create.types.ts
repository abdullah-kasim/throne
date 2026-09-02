import type {
  writeIdentity,
  writeOpeningPrompt,
} from "./legacy-identity-data.service.ts";
import type {
  agentRegistrationExists,
  markAgentTasked,
  readSpawnSpec,
  writeSpawnSpec,
} from "./legacy-spawn-data-contracts.ts";
import type { Harness } from "../harness-routing/harness.ts";
import type { ModelPairPool, PlanPresetName } from "../config.ts";
import type {
  reconcileIndeterminateAgentStart,
  resumeRegisteredAgentInRestoredTab,
} from "../herdr/herdr-create.service.ts";
import type { closeAgentTab } from "./legacy-herdr-tab.service.ts";
import type { resolveAgent } from "./legacy-herdr-runtime.service.ts";
import type { startAgent } from "./legacy-herdr-creation-orchestration.ts";
import type { MessageQueueStore } from "./legacy-message-queue.store.ts";
import type {
  ensureCodexTrust,
  probeCodexTrustPrompt,
} from "./legacy-codex-trust.service.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";
import type { writeQueueLaunchLinkage } from "./queue-launch-writeback.ts";
import type { readUsageLogRaw } from "./legacy-usage-log.ts";
import type { CapabilityEvidence } from "./legacy-capabilities.ts";
import type {
  CodexUsageReader,
  OpenCodeGoUsageReader,
  UsageReader,
} from "../shared-policy/usage-readers.ts";
import type { NativeClaudeUsageReader } from "./native-availability.ts";
import type { appendLaunchLedgerEntry } from "../alpha-launch-queue/launch-ledger.ts";
import type { TreeBase } from "../agentdata/tree-base-data.service.ts";
import type { RegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import type {
  CustomHarnessRequest,
  ModelBypassAuthorizationRegistry,
  StagerRouteAuthorizationEvidence,
  UsageBypassAuthorizationEvidence as ContractUsageBypassAuthorizationEvidence,
  UsageBypassAuthorizationRegistry,
} from "./create-agent-contracts.ts";

/**
 * Structural view of the queue store's public surface used across this
 * pipeline. The legacy and replacement classes are independently constructed
 * and structurally identical, but private fields brand each declaration.
 * Typing `CreateAgentDeps` fields against this `Pick`-derived shape keeps the
 * field assignable from either store without importing the replacement class.
 */
type MessageQueueStoreApi = Pick<MessageQueueStore, "insertWorkItem" | "close">;

export interface ParsedFlags {
  harness?: string;
  "harness-executable"?: string;
  model?: string;
  effort?: string;
  name?: string;
  supervisor?: string;
  escalation?: string;
  role?: string;
  cwd?: string;
  prompt?: string;
  "objective-code"?: string;
  "empty-worktree"?: boolean;
  "deliverable-shape"?: string;
  requires?: string;
  "non-campaign"?: boolean;
  "run-custom-harness-to-exit"?: boolean;
  "clear-environment"?: boolean;
  env?: string[];
  "stdout-path"?: string;
  "stderr-path"?: string;
  "exit-status-path"?: string;
  "wall-time-path"?: string;
  "launcher-evidence-path"?: string;
  "timeout-ms"?: string;
  "bypass-model"?: boolean;
  "bypass-zero-quota"?: boolean;
  "bypass-opencode-telemetry-unavailable"?: boolean;
  "bypass-effort"?: boolean;
  "bypass-alpha-guardrail"?: boolean;
  "bypass-preset-agent"?: boolean;
  "bypass-usage"?: boolean;
  help?: boolean;
}

export interface UsageBypassAuthorizationEvidence {
  authorizer: "Lord" | "Regent";
  objective_code: string;
  recipient: string;
  evidence_locator: string;
}

export interface ModelBypassAuthorizationEvidence {
  authorizer: "Lord" | "Regent";
  objective_code: string;
  recipient: string;
  evidence_locator: string;
}

/**
 * `customHarnessService.run`'s own deps view. It never enqueues an opening
 * prompt, so it omits `openMessageQueueStore` rather than embedding concrete
 * store classes in `run`'s contravariant parameter position.
 */
type CustomHarnessDeps = Omit<
  CreateAgentDeps,
  "customHarnessService" | "openMessageQueueStore"
>;

export interface CreateAgentDeps {
  customHarnessService?: {
    run: (
      request: CustomHarnessRequest,
      deps: CustomHarnessDeps,
    ) => Promise<number>;
  };
  validateAlphaTree?: (
    name: string,
    cwd: string,
  ) => Promise<string | undefined>;
  validateShadowTree?: (
    name: string,
    cwd: string,
  ) => Promise<string | undefined>;
  resolveAgent: typeof resolveAgent;
  startAgent: typeof startAgent;
  // The opening prompt is enqueued through the same centralized delivery
  // path `send-agent` uses, selected between these two transports the same
  // way `send-agent.command.ts` selects them; each is optional so
  // production wiring can default to the real store/flag while tests inject
  // fakes only where they exercise this path.
  openMessageQueueStore?: () => MessageQueueStoreApi;
  enqueueTimestampMs?: () => number;
  resumeRegisteredAgentInRestoredTab: typeof resumeRegisteredAgentInRestoredTab;
  reconcileIndeterminateAgentStart?: typeof reconcileIndeterminateAgentStart;
  closeAgentTab: typeof closeAgentTab;
  ensureCodexTrust: typeof ensureCodexTrust;
  probeCodexTrustPrompt: typeof probeCodexTrustPrompt;
  writeIdentity: typeof writeIdentity;
  writeOpeningPrompt: typeof writeOpeningPrompt;
  writeSpawnSpec: typeof writeSpawnSpec;
  readSpawnSpec: typeof readSpawnSpec;
  markAgentTasked?: typeof markAgentTasked;
  registrationExists: typeof agentRegistrationExists;
  removeRegistration: (name: string) => Promise<void>;
  getClaudeUsage: UsageReader;
  nativeClaudeUsageReader?: NativeClaudeUsageReader;
  getCodexUsage: CodexUsageReader;
  getOpenCodeGoUsage: OpenCodeGoUsageReader;
  readUsageLogRaw?: typeof readUsageLogRaw;
  readUsageBypassAuthorizations?: () => Promise<UsageBypassAuthorizationRegistry>;
  readModelBypassAuthorizations?: () => Promise<ModelBypassAuthorizationRegistry>;
  readStagerRouteAuthorizations?: () => Promise<unknown>;
  readModelAllowlist?: (
    ownerAlphaName: string,
  ) => Promise<ModelPairPool | undefined>;
  openQueueStore?: () => RegentQueueStore;
  planPresetName?: PlanPresetName;
  targetEffort?: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => string;
  afterRegistration?: () => Promise<void>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  writeQueueLaunchLinkage?: typeof writeQueueLaunchLinkage;
  appendLaunchLedgerEntry?: typeof appendLaunchLedgerEntry;
  readTreeBase?: (name: string) => Promise<TreeBase | null>;
  launchLedgerPath?: string;
}

export interface CreateAgentRequest {
  flags: ParsedFlags;
  passthrough?: string[];
  oneShot: boolean;
  harness: Harness;
  model: string;
  requestedEffort?: number;
  requestedExecutable?: string;
  role: string;
  requestedName: string;
  name: string;
  requestedCwd: string;
  emptyWorktree?: boolean;
  deliverableShape?: "verdict-only";
}

export interface RegistrationResolution extends CreateAgentRequest {
  objectiveContract?: ObjectiveContract;
  launchHarness: Harness;
  launchModel: string;
  launchEffort?: number;
  cwd: string;
  resuming: boolean;
  customExecutable?: string;
  customPassthrough: string[];
  emptyWorktree?: boolean;
}

export interface PolicyResolution extends RegistrationResolution {
  objectiveContract?: ObjectiveContract;
  launchEffort: number;
  routingNote: string;
  durableRoutingNote: boolean;
  capabilityEvidence?: CapabilityEvidence;
  capabilityOverrideNote: string;
  effortOverrideNote: string;
  harnessOverrideNote: string;
  usageBypassAuthorization?: UsageBypassAuthorizationEvidence;
  modelBypassAuthorization?: ModelBypassAuthorizationEvidence;
  stagerRouteAuthorization?: StagerRouteAuthorizationEvidence;
  bypassedObjectiveCode: boolean;
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
