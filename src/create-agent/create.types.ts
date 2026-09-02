import type {
  writeIdentity,
  writeOpeningPrompt,
} from "../agentdata/identity-data.service.ts";
import type {
  agentRegistrationExists,
  markAgentTasked,
  readSpawnSpec,
  writeSpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import type { Harness } from "../harness-routing/harness.ts";
import type { ModelPair, ModelPairPool, PlanPresetName } from "../config.ts";
import type {
  reconcileIndeterminateAgentStart,
  resumeRegisteredAgentInRestoredTab,
} from "../herdr/herdr-create.service.ts";
import type { closeAgentTab } from "../herdr/herdr-tab.service.ts";
import type { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import type { startAgent } from "../herdr/herdr-creation-orchestration.ts";
import type { MessageQueueStore } from "../message-queue/message-queue.store.ts";
import type {
  ensureCodexTrust,
  probeCodexTrustPrompt,
} from "../codex-trust/codex-trust.service.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";
import type { LaneBalanceVerdict } from "../token-balance/token-balance-report.ts";
import type { writeQueueLaunchLinkage } from "./queue-launch-writeback.ts";
import type { readUsageLogRaw } from "../plan-usage-remaining/telemetry-core/log.ts";
import type {
  CodexUsageReader,
  OpenCodeGoUsageReader,
  UsageReader,
} from "../shared-policy/usage-readers.ts";
import type { NativeClaudeUsageReader } from "./native-availability.ts";
import type { appendLaunchLedgerEntry } from "../alpha-launch-queue/launch-ledger.ts";
import type { TreeBase } from "../agentdata/tree-base-data.service.ts";
import type { RegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import type { CapabilityEvidence } from "../harness-routing/policy/capabilities.ts";
import type { awaitSpawnTaskingConfirmation } from "../session/runtime-model-acceptance.ts";
import type { writeModelAllowlist } from "./model-allowlist.ts";
import type {
  CustomHarnessRequest,
  ModelBypassAuthorizationRegistry,
  StagerRouteAuthorizationEvidence,
  UsageBypassAuthorizationEvidence as ContractUsageBypassAuthorizationEvidence,
  UsageBypassAuthorizationRegistry,
} from "./create-agent-contracts.ts";

/**
 * What a lane-bearing campaign records at Alpha spawn and every descendant
 * Shadow/ShadowSlice99 inherits verbatim: either the balancer's chosen
 * lane, or that the campaign runs under an explicit per-campaign model
 * mandate (the same `--bypass-model` authorization precedent as
 * `model-bypass-authorization.ts`) that skips lane gating entirely.
 * `undefined` means the campaign was never lane-gated (kill switch or
 * operator setting off, or the balancer verdict was unavailable/blocked) —
 * today's unbalanced spawn behavior, unchanged.
 */
export type LaneEvidence = { readonly lane: string } | { readonly mandate: true };

/**
 * Whether a spawned agent's opening prompt landed as more than an enqueue:
 * `"tasked"` — enqueued and the transcript confirmed assistant activity;
 * `"enqueued-unconfirmed"` — enqueued but the bounded wait expired with no
 * confirming evidence (the exact shape of a swallowed opening prompt);
 * `"quarantined-not-tasked"` — enqueued but the transcript shows a different
 * model than requested; `"not-applicable"` — confirmation was never
 * attempted (non-Claude harness, a resume that left the harness already
 * live, or no genuine caller-supplied prompt to confirm).
 */
export type SpawnTaskingOutcome =
  | "tasked"
  | "enqueued-unconfirmed"
  | "quarantined-not-tasked"
  | "not-applicable";

export interface ParsedFlags {
  harness?: string;
  "harness-executable"?: string;
  model?: string;
  "model-hint"?: string;
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

export interface CreateAgentDeps {
  customHarnessService?: {
    run: (
      request: CustomHarnessRequest,
      deps: CreateAgentDeps,
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
  openMessageQueueStore?: () => MessageQueueStore;
  enqueueTimestampMs?: () => number;
  // Confirms a genuine opening-prompt enqueue actually produced assistant
  // activity in the spawned agent's own transcript. Optional so tests can
  // inject a fast fake; production wiring defaults to the real bounded-wait
  // primitive.
  confirmSpawnTasking?: typeof awaitSpawnTaskingConfirmation;
  resumeRegisteredAgentInRestoredTab: typeof resumeRegisteredAgentInRestoredTab;
  reconcileIndeterminateAgentStart?: typeof reconcileIndeterminateAgentStart;
  closeAgentTab: typeof closeAgentTab;
  ensureCodexTrust: typeof ensureCodexTrust;
  probeCodexTrustPrompt: typeof probeCodexTrustPrompt;
  writeIdentity: typeof writeIdentity;
  writeOpeningPrompt: typeof writeOpeningPrompt;
  writeSpawnSpec: typeof writeSpawnSpec;
  writeModelAllowlist: typeof writeModelAllowlist;
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
  // Not wired to a real data source by this slice — see
  // `resolveLaneEvidenceStage`'s doc comment in `lane-inheritance.ts`.
  // Absent means "no verdict"/"disabled", the same safe no-op every other
  // kill-switch gate produces before its consumers land.
  resolveTokenBalanceVerdict?: () => LaneBalanceVerdict | undefined;
  isTokenBalanceOperatorEnabled?: () => boolean;
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
  laneEvidence?: LaneEvidence;
  modelHint?: ModelPair;
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
