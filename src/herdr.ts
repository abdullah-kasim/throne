export {
  AGENT_START_BUSY_MAX_ATTEMPTS,
  AGENT_START_BUSY_RETRY_DELAY_MS,
  restoredAgentQuarantineName,
  START_CONTEXT_ENV_ALLOWLIST,
} from "./herdr/herdr-agent-recovery.ts";
export {
  attachThroneHerdr,
  CODEX_HERDR_READ_TIMEOUT_MS,
  type HerdrAttachBoundary,
  HerdrCommandError,
  HerdrCompatibilityError,
  type HerdrProcessBoundary,
  type HerdrRuntimeMode,
  parseHerdrErrorCode,
  preflightHerdrCompatibility,
  pressEnter,
  pressPaneKey,
  runHerdr,
  sendText,
  THRONE_HERDR_PROTOCOL,
  THRONE_HERDR_SESSION,
} from "./herdr/herdr-client.ts";
export {
  codexTextboxClearance,
} from "./herdr/herdr-codex.service.ts";
export {
  type AgentStartEvidence,
  RESTORED_TAB_RACE_RECHECK_ATTEMPTS,
  RESTORED_TAB_RACE_RECHECK_MS,
  type ResumeRegisteredAgentInRestoredTabDeps,
  type ResumeRegisteredAgentInRestoredTabResult,
  type ShellReadyEvidence,
  type StartCallerContext,
  type StartCallerContextDeps,
  type StartEvidencePhase,
  type StartFailureAnnotation,
  type StartInTabDeps,
  type StartOptions,
} from "./herdr/herdr-create.contracts.ts";
export {
  resumeRegisteredAgentInRestoredTab,
  type StartFailureOwnership,
} from "./herdr/herdr-create.service.ts";
export {
  startAgent,
} from "./herdr/herdr-creation-orchestration.ts";
export {
  AgentStartIndeterminateError,
  AgentStartPaneBusyError,
  OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS,
  OPENING_PROMPT_NAME_REGISTRATION_POLL_MILLISECONDS,
  OpeningPromptDeliveryError,
  RegisteredAgentRestoredTabCollisionError,
} from "./herdr/herdr-errors.ts";
export {
  AgentResolutionError,
  type HerdrAgent,
  sameAgentName,
} from "./herdr/herdr-identity-contracts.ts";
export {
  AGENT_STATUSES,
  type AgentStatus,
  agentStatusAcceptsInput,
  type HerdrForegroundProcess,
  type HerdrNameOwner,
  type HerdrPane,
  type HerdrPaneProcessInfo,
  type HerdrTab,
  parseAgentList,
  parseNameOwners,
  parsePaneList,
  parsePaneProcessInfo,
  parseReadText,
  parseTabList,
  type ReadOptions,
  type ReadSource,
} from "./herdr/herdr-inventory.service.ts";
export {
  AGENT_DETECTION_POLL_MS,
  AGENT_DETECTION_TIMEOUT_MS,
  AgentDetectionTimeoutError,
  isIndeterminateAgentStartError,
} from "./herdr/herdr-launch-command.ts";
export {
  annotateStartFailure,
  collectStartCallerContext,
  isTransientPaneBusyStartError,
  readStartFailureAnnotation,
} from "./herdr/herdr-launch-context.ts";
export {
  SHELL_READY_CAPTURE_LINES,
  SHELL_READY_PROBE_COMMAND_MARKER,
  SHELL_READY_PROBE_WINDOW_MS,
  SHELL_READY_TIMEOUT_MS,
  START_EVIDENCE_PHASES,
  startInTab,
} from "./herdr/herdr-launch.ts";
export {
  deliverOpeningPrompt,
  type DeliverOpeningPromptDeps,
} from "./herdr/herdr-opening-prompt.ts";
export {
  isLiveHarnessProcess,
  paneHasLiveHarnessProcess,
} from "./herdr/herdr-process-detection.ts";
export {
  captureProvesExecutedSentinel,
  paneOutputBytes,
  PaneReadinessTimeoutError,
  waitForShellReady,
} from "./herdr/herdr-readiness.ts";
export {
  getPaneProcessInfo,
  listAgents,
  listNameOwners,
  listPanes,
  listTabs,
  readAgent,
  readAgentStatus,
  renameAgent,
  resolveAgent,
} from "./herdr/herdr-runtime.service.ts";
export {
  isTransientComposerObservationFailure,
  readRecentAgentAnsi,
  readRecentCodexAgentAnsi,
  readVisibleAgentAnsi,
  readVisibleAgentText,
  readVisibleCodexAgentAnsi,
  type SupportedScreenObservationDeps,
} from "./herdr/herdr-screen.service.ts";
export {
  REAL_ENTER_UNTIL_EMPTY_DEPS,
} from "./herdr/herdr-send-enter-until-empty.ts";
export {
  submitToAgentWhileLocked,
} from "./herdr/herdr-send-transaction.ts";
export {
  pressEnterUntilEmptyTextbox,
  submitToAgent,
} from "./herdr/herdr-send.service.ts";
export {
  HERDR_PROMPT_SETTLED_TIMEOUT_MS,
  SubmitAssumedFilledError,
  SubmitNotSentError,
  type SubmitToAgentDeps,
  type SubmitToAgentOptions,
} from "./herdr/herdr-send.types.ts";
export {
  currentPaneId,
  insideHerdr,
  resolveCurrentAgentName,
} from "./herdr/herdr-session.service.ts";
export {
  closeAgentTab,
  closePane,
  closeTab,
  type CreatedTab,
  createTab,
  renameTab,
} from "./herdr/herdr-tab.service.ts";
