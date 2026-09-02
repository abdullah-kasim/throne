import type { Harness } from "../../harness-routing/harness.ts";
import type { AgentStartEvidence } from "../../herdr/herdr-create.contracts.ts";
import type { HerdrAgent } from "../../herdr/herdr-identity-contracts.ts";
import type {
  SupportedAgentScreenSnapshot,
  SupportedComposerHarness,
} from "../../codex-screen/composer/composer.types.ts";
import type { SessionCandidate, SwitchRequest, LaunchRecipe } from "../../session/session.contracts.ts";
import type { SpawnSpec } from "../../agentdata/spawn-data-contracts.ts";


// A status capture or recipient inspection has exactly two states: it either
// resolved to a definite verdict or it did not. A third "indeterminate"
// outcome would encode OUR failure to observe as if it were a fact about the
// recipient, and every consumer of these types uses that outcome to gate a
// destructive action (closing a live pane) — so an unresolved observation
// must refuse, never invent a speculative "ready"/"captured" reading.
export type StatusCaptureRefusal = "unresolved" | "identity-changed" | "unexpected-harness" | "screen-unusable" | "composer-not-empty";
export type AgentStatusCapture =
  | { outcome: "captured"; text: string }
  | { outcome: "refused"; code: StatusCaptureRefusal; reason: string };
export type SwitchInspectionRefusal = "unresolved" | "identity-changed" | "status-rejects-input" | "cwd-mismatch" | "cwd-unresolvable" | "unsupported-harness" | "screen-unusable" | "composer-unavailable" | "composer-not-empty";
export type SwitchRecipientInspection =
  | { outcome: "ready"; agent: HerdrAgent; harness: SupportedComposerHarness; snapshot: SupportedAgentScreenSnapshot }
  | { outcome: "refused"; code: SwitchInspectionRefusal; reason: string };
export interface SwitchTransactionInput { agentName: string; spawn: SpawnSpec; request: SwitchRequest; preserved: { identity: string; tree: string }; }
export interface SwitchTransactionDeps {
  inspectRecipient: (name: string, expectedCwd: string) => Promise<SwitchRecipientInspection>;
  captureStatus: (recipient: HerdrAgent, harness: SupportedComposerHarness) => Promise<AgentStatusCapture>;
  listSessionCandidates?: (harness: Harness, cwd: string) => Promise<readonly SessionCandidate[]>;
  closeAgent: (agent: Pick<HerdrAgent, "tabId" | "paneId">) => Promise<void>;
  withRecipientPaneLock: <T>(paneId: string, action: () => Promise<T>) => Promise<T>;
  startAgent: (name: string, opts: { cwd: string; argv: string[] }) => Promise<AgentStartEvidence>;
  persistSpawnSpec: (spec: SpawnSpec) => Promise<void>;
  readSpawnSpec?: () => Promise<SpawnSpec>;
  resolvePath: (path: string) => Promise<string>;
  readPreservedBytes: () => Promise<{ identity: string; tree: string }>;
  wait: (milliseconds: number) => Promise<void>;
  now: () => Date;
}
export type SwitchPhase = (typeof SWITCH_PHASES)[number];
export const SWITCH_PHASES = ["validate-recipe", "validate-target", "inspect-recipient", "resolve-session", "close-current", "start-target", "verify-target", "persist-spawn", "read-back-spawn", "close-target-state", "resume-previous", "verify-previous", "verify-preserved-bytes"] as const;
export type SwitchPhaseStatus = "ok" | "failed";
export interface SwitchPhaseEvent { phase: SwitchPhase; status: SwitchPhaseStatus; detail?: string; }
// A switch/rollback transaction whose final state cannot be directly
// observed is not a third outcome — that would encode our own uncertainty
// about the observation as if it were the transaction's own state. Once a
// transaction has taken its own irreversible step (closing the current pane,
// launching the target), an unconfirmable follow-on observation is resolved
// by looking again; once out of looks, the transaction structurally defaults
// to the positive/completed side of whichever step it just took, rather
// than inventing a third verdict. A step whose own action has not yet been
// confirmed to have happened at all has no positive side to default to, and
// reports the transaction as failed instead of guessing.
export type SwitchOutcome = "switched" | "refused-before-close" | "target-failed/rollback-restored" | "target-failed/rollback-failed";
export type SwitchRefusalCode = "custom-recipe" | "unsupported-recipe" | "unsupported-target" | "recipient-refused" | "session-unprovable";
export type SpawnEvidenceVerdict = boolean | "unknown";
export type EffortEvidenceSource = "status" | "launch-argv";
export interface SwitchTransactionResult { outcome: SwitchOutcome; spawnEvidenceChanged: SpawnEvidenceVerdict; identityAndTreeUnchanged: boolean; phases: SwitchPhaseEvent[]; reason?: string; code?: SwitchRefusalCode; previous?: LaunchRecipe; target?: LaunchRecipe; sessionId?: string; effortEvidence?: EffortEvidenceSource; startEvidence?: AgentStartEvidence; }
export interface VerificationFailure { ok: false; code: "draft-ownership" | "readiness-exhausted" | "verification-failed"; reason: string; }
export type Verification = { ok: true; effortEvidence: EffortEvidenceSource } | VerificationFailure;
