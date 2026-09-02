import { Injectable } from "@nestjs/common";
import { errorText } from "../shared-policy/error-text.ts";
import { deliverOpeningPrompt } from "./herdr-opening-prompt.ts";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupportedComposerHarness } from "../codex-screen/composer/composer.types.ts";
import { HARNESS_NAMES, runtimeHarness } from "../harness-routing/harness.ts";
import { AgentResolutionError, sameAgentName } from "./herdr-identity-contracts.ts";
import { argvExecutableCandidates, executableName, isLiveHarnessProcess, paneHasLiveHarnessProcess } from "./herdr-process-detection.ts";
import { getPaneProcessInfo, listNameOwners, listPanes, listTabs, resolveAgent, renameAgent } from "./herdr-runtime.service.ts";
import { parseAgentList } from "./herdr-inventory.service.ts";
import {
  SUPPORTED_HARNESS_EXECUTABLES,
  sleep,
} from "./herdr-screen.service.ts";
import type { readFileSync } from "node:fs";
import type {
  HerdrAgent,
  HerdrNameOwner,
  HerdrPane,
  HerdrPaneProcessInfo,
  HerdrTab,
} from "./herdr-inventory.service.ts";
import {
  IncompleteHerdrPaneProcessInfoError,
  parseReadText,
} from "./herdr-inventory.service.ts";
import { runHerdr, type HerdrRuntimeMode } from "./herdr-client.ts";
import {
  DEFAULT_HERDR_RUNTIME_MODE,
  THRONE_HERDR_SESSION,
} from "./herdr-client.ts";
import {
  currentPaneId,
  insideHerdr,
  resolveCurrentAgentName,
} from "./herdr-session.service.ts";
import {
  closeAgentTab,
  closePane,
  closeTab,
  createTab,
  renameTab,
} from "./herdr-tab.service.ts";
import { submitToAgent } from "./herdr-send.service.ts";
import { SubmitNotSentError } from "./herdr-send.types.ts";
import { HerdrInventoryService } from "./herdr-inventory.service.ts";
import { HerdrTabService } from "./herdr-tab.service.ts";
import { HerdrCommandError } from "./herdr-client.ts";
import type {
  AgentStartEvidence,
  StartCallerContext,
  StartOptions,
  ShellReadyEvidence,
  StartEvidencePhase,
} from "./herdr-create.contracts.ts";
import type { PersonaConfig } from "../application-config.service.ts";

const CANONICAL_ROLE_PREFIX_PATTERN = /^(alpha|shadow)-(.+)$/i;

/**
 * Computes the herdr tab label for a NEWLY-spawned agent: the canonical
 * `alpha-`/`shadow-` prefix swapped for the active persona's role word,
 * lowercased to match the exact-lowercase tab-label contract `renameAgent`
 * enforces. Never touches the registered/ledger name — callers keep writing
 * `canonicalName` there unchanged. Degrades to `canonicalName` verbatim when
 * `activePersona` is absent (the majority-case path, since `config.user.ts`
 * is gitignored and absent in every worktree) or when `canonicalName` doesn't
 * carry the canonical role-prefix grammar this function knows how to rewrite.
 */
export function derivePersonaTabLabel(
  canonicalName: string,
  activePersona: PersonaConfig | undefined,
): string {
  if (activePersona === undefined) return canonicalName;
  const match = CANONICAL_ROLE_PREFIX_PATTERN.exec(canonicalName);
  if (match === null) return canonicalName;
  const role = match[1].toLowerCase() as "alpha" | "shadow";
  return `${activePersona.roleWords[role]}-${match[2]}`.toLowerCase();
}

export class OpeningPromptDeliveryError extends Error {
  readonly name = "OpeningPromptDeliveryError";
  readonly agentName: string;
  readonly retrySafe: boolean;

  constructor(
    agentName: string,
    retrySafe: boolean,
    detail: string,
    cause?: unknown,
  ) {
    super(
      `opening prompt for "${agentName}" was ` +
        `${retrySafe ? "not delivered" : "left indeterminate"}: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.agentName = agentName;
    this.retrySafe = retrySafe;
  }
}

export class RegisteredAgentRestoredTabCollisionError extends Error {
  readonly name = "RegisteredAgentRestoredTabCollisionError";
  readonly registeredAgentName: string;

  constructor(registeredAgentName: string, detail: string, cause?: unknown) {
    super(
      `cannot resume registered agent "${registeredAgentName}" in its restored tab: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.registeredAgentName = registeredAgentName;
  }
}

export class AgentStartIndeterminateError extends Error {
  readonly name = "AgentStartIndeterminateError";
  readonly agentName: string;
  readonly tabId: string;
  readonly paneId: string;

  constructor(
    agentName: string,
    tabId: string,
    paneId: string,
    cause: unknown,
  ) {
    super(
      `direct harness launch for "${agentName}" failed after the command was issued; ` +
        `exact tab "${tabId}" and pane "${paneId}" were RETAINED because a harness may ` +
        `already be live there — reconcile that exact tab instead of spawning again`,
      { cause },
    );
    this.agentName = agentName;
    this.tabId = tabId;
    this.paneId = paneId;
  }
}

export class AgentStartPaneBusyError extends Error {
  readonly name = "AgentStartPaneBusyError";
  readonly agentName: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly attempts: number;

  constructor(
    agentName: string,
    tabId: string,
    paneId: string,
    attempts: number,
    cause: HerdrCommandError,
  ) {
    super(
      `herdr agent start for "${agentName}" was rejected as pane-busy on all ` +
        `${attempts} bounded attempts against pane "${paneId}", whose shell had ` +
        `already executed the readiness sentinel; no agent was registered`,
      { cause },
    );
    this.agentName = agentName;
    this.tabId = tabId;
    this.paneId = paneId;
    this.attempts = attempts;
  }
}

export interface CreatedTab {
  tabId: string;
  rootPaneId: string;
}
export interface StartCallerContextDeps {
  runHerdr: typeof runHerdr;
  cwd: () => string;
  env: Record<string, string | undefined>;
  runtimeMode: HerdrRuntimeMode;
}
export type StartFailureOwnership = "determinate" | "indeterminate";
export interface StartFailureAnnotation {
  phase: StartEvidencePhase;
  ownership: StartFailureOwnership;
  tabId: string;
  rootPaneId: string;
  startAttempts: number;
  context: StartCallerContext;
}
export interface ResumeRegisteredAgentInRestoredTabDeps {
  listTabs: () => Promise<HerdrTab[]>;
  listPanes: () => Promise<HerdrPane[]>;
  listNameOwners: () => Promise<HerdrNameOwner[]>;
  getPaneProcessInfo: (paneId: string) => Promise<HerdrPaneProcessInfo>;
  renameAgent: (target: string, name: string) => Promise<void>;
  startInTab: (
    name: string,
    paneId: string,
    opts: StartOptions,
  ) => Promise<string | undefined>;
  startAgent: (name: string, opts: StartOptions) => Promise<AgentStartEvidence>;
  closePane: (paneId: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
}
export type ResumeRegisteredAgentInRestoredTabResult =
  | { kind: "new-tab-launched" }
  | {
      kind: "restored-tab-takeover";
      tabId: string;
      paneId?: string;
      quarantinedOwnerName?: string;
    }
  | { kind: "already-live"; tabId: string; paneId: string };
export type ReconcileIndeterminateAgentStartResult =
  | Extract<ResumeRegisteredAgentInRestoredTabResult, { kind: "already-live" }>
  | { kind: "proven-dead" };
export interface CustomHarnessOneShotOptions {
  name: string;
  cwd: string;
  executable: string;
  argv: string[];
  environment: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  exitStatusPath: string;
  wallTimePath: string;
  launcherEvidencePath: string;
  timeoutMs: number;
  policy: { harness: string; model: string; effort: number };
}
export interface CustomHarnessOneShotResult {
  exitCode: number;
  timedOut: boolean;
  wallTimeMs: number;
}
export interface RunCustomHarnessOneShotDeps {
  listTabs: () => Promise<HerdrTab[]>;
  createTab: (label: string, cwd?: string) => Promise<CreatedTab>;
  runChild: (options: CustomHarnessOneShotOptions) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  evidenceExists: (path: string) => boolean;
  readEvidence: typeof readFileSync;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

/** Nest boundary for Herdr creation effects and their lifecycle dependencies. */
@Injectable()
export class HerdrCreateService {
  private readonly inventory: HerdrInventoryService;
  private readonly tabs: HerdrTabService;

  constructor(inventory: HerdrInventoryService, tabs: HerdrTabService) {
    this.inventory = inventory;
    this.tabs = tabs;
  }

  startAgent(name: string, options: StartOptions): Promise<AgentStartEvidence> {
    return startAgent(name, options, {
      createTab: this.tabs.createTab.bind(this.tabs),
      waitForShellReady: (paneId) => waitForShellReady(paneId),
      startInTab: (agentName, paneId, startOptions) =>
        startInTab(agentName, paneId, startOptions),
      closeTab: this.tabs.closeTab.bind(this.tabs),
      closePane: this.tabs.closePane.bind(this.tabs),
    });
  }

  deliverOpeningPrompt(name: string, prompt: string): Promise<void> {
    return deliverOpeningPrompt(name, prompt);
  }

  resumeRegisteredAgentInRestoredTab(
    name: string,
    options: StartOptions,
  ): Promise<ResumeRegisteredAgentInRestoredTabResult> {
    return resumeRegisteredAgentInRestoredTab(name, options);
  }

  reconcileIndeterminateAgentStart(
    name: string,
    tabId: string,
    paneId: string,
    options: StartOptions,
  ): Promise<ReconcileIndeterminateAgentStartResult> {
    return reconcileIndeterminateAgentStart(name, tabId, paneId, options);
  }

  listAgents() {
    return this.inventory.listAgents();
  }
}
import {
  exactLabelTabs,
  inspectRestoredTab,
  classifyRestoredOwnerSnapshot,
} from "./herdr-restored-tab-inspection.ts";
import type { RestoredOwnerRecheckResult } from "./herdr-create.contracts.ts";
import {
  recheckRestoredOwnerBeforeQuarantine,
  restoredAgentQuarantineName,
} from "./herdr-agent-recovery.ts";
import {
  claimUnownedLiveRestoredAgent,
  quarantineRestoredNameOwner,
  verifyConcurrentRegisteredAgentWinner,
} from "./herdr-agent-recovery.ts";
import {
  RESTORED_TAB_RACE_RECHECK_ATTEMPTS,
  RESTORED_TAB_RACE_RECHECK_MS,
} from "./herdr-create.contracts.ts";
import {
  reconcileIndeterminateAgentStartWithDeps,
  resumeRegisteredAgentInRestoredTabWithDeps,
} from "./herdr-agent-recovery.ts";
import {
  collectStartCallerContext,
  annotateStartFailure,
  readStartFailureAnnotation,
  isTransientPaneBusyStartError,
} from "./herdr-launch-context.ts";
import { startAgent } from "./herdr-creation-orchestration.ts";
import { REAL_RESUME_REGISTERED_AGENT_DEPS } from "./herdr-creation-orchestration.ts";
export async function resumeRegisteredAgentInRestoredTab(
  registeredAgentName: string,
  opts: StartOptions,
  deps: ResumeRegisteredAgentInRestoredTabDeps = REAL_RESUME_REGISTERED_AGENT_DEPS,
): Promise<ResumeRegisteredAgentInRestoredTabResult> {
  return resumeRegisteredAgentInRestoredTabWithDeps(
    registeredAgentName,
    opts,
    deps,
  );
}

export async function reconcileIndeterminateAgentStart(
  registeredAgentName: string,
  expectedTabId: string,
  expectedPaneId: string,
  opts: StartOptions,
  deps: ResumeRegisteredAgentInRestoredTabDeps = REAL_RESUME_REGISTERED_AGENT_DEPS,
): Promise<ReconcileIndeterminateAgentStartResult> {
  return reconcileIndeterminateAgentStartWithDeps(
    registeredAgentName,
    expectedTabId,
    expectedPaneId,
    opts,
    deps,
  );
}

interface LaunchContext {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stagedArtifactPaths?: string[];
  binaryResolution?: HarnessBinaryResolution;
}

interface HarnessBinaryResolution {
  executableName: typeof HARNESS_NAMES.CLAUDE;
  overrideVariable: "CLAUDE_BIN";
  wrapperName: "claudey-all";
}


import { startInTab } from "./herdr-launch.ts";
import {
  SHELL_READY_TIMEOUT_MS,
  SHELL_READY_PROBE_WINDOW_MS,
  SHELL_READY_CAPTURE_LINES,
  SHELL_READY_PROBE_COMMAND_MARKER,
} from "./herdr-launch.ts";
import {
  PaneReadinessTimeoutError,
  paneOutputBytes,
  captureProvesExecutedSentinel,
  waitForShellReady,
} from "./herdr-readiness.ts";
