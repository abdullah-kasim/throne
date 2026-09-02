import { Injectable } from "@nestjs/common";
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

import {
  exactLabelTabs,
  inspectRestoredTab,
  classifyRestoredOwnerSnapshot,
} from "./herdr-restored-tab-inspection.ts";
import type {
  RestoredTabSnapshot,
  RestoredOwnerSnapshotState,
  RestoredOwnerRecheckResult,
  ResumeRegisteredAgentInRestoredTabDeps,
  ResumeRegisteredAgentInRestoredTabResult,
} from "./herdr-create.contracts.ts";
import { RegisteredAgentRestoredTabCollisionError } from "./herdr-errors.ts";
import {
  RESTORED_TAB_RACE_RECHECK_ATTEMPTS,
  RESTORED_TAB_RACE_RECHECK_MS,
} from "./herdr-create.contracts.ts";
import type { ReconcileIndeterminateAgentStartResult } from "./herdr-create.contracts.ts";
import { trimPreExistingRestoredPanes } from "./herdr-restored-tab-cleanup.ts";

export async function recheckRestoredOwnerBeforeQuarantine(
  registeredAgentName: string,
  tabId: string,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<RestoredOwnerRecheckResult> {
  for (
    let attempt = 1;
    attempt <= RESTORED_TAB_RACE_RECHECK_ATTEMPTS;
    attempt += 1
  ) {
    const snapshot = await inspectRestoredTab(registeredAgentName, tabId, deps);
    const state = classifyRestoredOwnerSnapshot(
      registeredAgentName,
      tabId,
      snapshot,
      undefined,
    );
    if (state.kind === "already-live") {
      return state;
    }
    if (state.kind === "unowned") {
      return { kind: "ready-for-takeover", snapshot };
    }
    if (state.kind === "unowned-live") {
      throw new RegisteredAgentRestoredTabCollisionError(
        registeredAgentName,
        "restored owner recheck cannot claim a live pane without a recorded cwd",
      );
    }
    if (attempt === RESTORED_TAB_RACE_RECHECK_ATTEMPTS) {
      if (state.kind === "owner-unavailable") {
        throw new RegisteredAgentRestoredTabCollisionError(
          registeredAgentName,
          `exact owner pane "${state.owner.paneId}" remained unavailable after ${RESTORED_TAB_RACE_RECHECK_ATTEMPTS} rechecks`,
        );
      }
      return {
        kind: "ready-for-takeover",
        snapshot,
        owner: state.owner,
      };
    }
    await deps.sleep(RESTORED_TAB_RACE_RECHECK_MS);
  }
  throw new Error("restored owner recheck exhausted without a result");
}

export function restoredAgentQuarantineName(
  registeredAgentName: string,
  owner: Pick<HerdrNameOwner, "tabId" | "paneId">,
): string {
  const stableIds = `${owner.tabId}-${owner.paneId}`
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${registeredAgentName}--restored-stale-${stableIds}`;
}

export async function quarantineRestoredNameOwner(
  registeredAgentName: string,
  owner: HerdrNameOwner,
  deps: Pick<
    ResumeRegisteredAgentInRestoredTabDeps,
    "renameAgent" | "listNameOwners"
  >,
): Promise<string> {
  const quarantineName = restoredAgentQuarantineName(
    registeredAgentName,
    owner,
  );
  try {
    await deps.renameAgent(owner.paneId, quarantineName);
  } catch (error) {
    const refreshed = await deps.listNameOwners();
    const movedByConcurrentReconciler = refreshed.some(
      (candidate) =>
        candidate.name === quarantineName &&
        candidate.tabId === owner.tabId &&
        candidate.paneId === owner.paneId,
    );
    if (!movedByConcurrentReconciler) {
      throw error;
    }
  }
  return quarantineName;
}

export async function verifyConcurrentRegisteredAgentWinner(
  registeredAgentName: string,
  expectedTabId: string,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<ResumeRegisteredAgentInRestoredTabResult | undefined> {
  for (
    let attempt = 1;
    attempt <= RESTORED_TAB_RACE_RECHECK_ATTEMPTS;
    attempt += 1
  ) {
    const matchingTabs = exactLabelTabs(
      await deps.listTabs(),
      registeredAgentName,
    );
    if (matchingTabs.length !== 1) {
      throw new RegisteredAgentRestoredTabCollisionError(
        registeredAgentName,
        `name-taken recheck found ${matchingTabs.length} exact restored tabs`,
      );
    }
    if (matchingTabs[0]!.tabId !== expectedTabId) {
      throw new RegisteredAgentRestoredTabCollisionError(
        registeredAgentName,
        `name-taken recheck moved the exact label from tab "${expectedTabId}" to "${matchingTabs[0]!.tabId}"`,
      );
    }

    const snapshot = await inspectRestoredTab(
      registeredAgentName,
      expectedTabId,
      deps,
    );
    const state = classifyRestoredOwnerSnapshot(
      registeredAgentName,
      expectedTabId,
      snapshot,
    );
    if (state.kind === "already-live") {
      return state.result;
    }
    if (
      attempt === RESTORED_TAB_RACE_RECHECK_ATTEMPTS &&
      state.kind === "owner-unavailable"
    ) {
      throw new RegisteredAgentRestoredTabCollisionError(
        registeredAgentName,
        `agent_name_taken exact owner pane "${state.owner.paneId}" remained unavailable after ${RESTORED_TAB_RACE_RECHECK_ATTEMPTS} rechecks`,
      );
    }

    if (attempt < RESTORED_TAB_RACE_RECHECK_ATTEMPTS) {
      await deps.sleep(RESTORED_TAB_RACE_RECHECK_MS);
    }
  }
  return undefined;
}

export async function claimUnownedLiveRestoredAgent(
  registeredAgentName: string,
  tabId: string,
  pane: HerdrPane,
  recordedCwd: string | undefined,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<
  Extract<ResumeRegisteredAgentInRestoredTabResult, { kind: "already-live" }>
> {
  await deps.renameAgent(pane.paneId, registeredAgentName);

  const matchingTabs = exactLabelTabs(
    await deps.listTabs(),
    registeredAgentName,
  );
  if (matchingTabs.length !== 1 || matchingTabs[0]!.tabId !== tabId) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      "post-claim verification did not retain one exact restored tab",
    );
  }

  const snapshot = await inspectRestoredTab(registeredAgentName, tabId, deps);
  const state = classifyRestoredOwnerSnapshot(
    registeredAgentName,
    tabId,
    snapshot,
    recordedCwd,
  );
  if (
    state.kind !== "already-live" ||
    state.result.paneId !== pane.paneId ||
    pane.terminalId !==
      snapshot.panes.find((candidate) => candidate.paneId === pane.paneId)
        ?.terminalId
  ) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `post-claim verification did not retain live ownership on pane "${pane.paneId}"`,
    );
  }
  return state.result;
}

@Injectable()
export class RestoredAgentRecoveryService {
  recheckRestoredOwnerBeforeQuarantine = recheckRestoredOwnerBeforeQuarantine;
  restoredAgentQuarantineName = restoredAgentQuarantineName;
}

export async function reconcileIndeterminateAgentStartWithDeps(
  registeredAgentName: string,
  expectedTabId: string,
  expectedPaneId: string,
  opts: StartOptions,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<ReconcileIndeterminateAgentStartResult> {
  const matchingTabs = exactLabelTabs(
    await deps.listTabs(),
    registeredAgentName,
  );
  if (matchingTabs.length !== 1 || matchingTabs[0]!.tabId !== expectedTabId) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `fresh-launch reconciliation expected exact tab "${expectedTabId}" but found ${matchingTabs.length}`,
    );
  }

  const snapshot = await inspectRestoredTab(
    registeredAgentName,
    expectedTabId,
    deps,
  );
  if (!snapshot.panes.some((pane) => pane.paneId === expectedPaneId)) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `fresh-launch root pane "${expectedPaneId}" is unavailable`,
    );
  }
  const state = classifyRestoredOwnerSnapshot(
    registeredAgentName,
    expectedTabId,
    snapshot,
    opts.cwd,
  );
  if (state.kind === "already-live") return state.result;
  if (state.kind === "unowned-live") {
    return claimUnownedLiveRestoredAgent(
      registeredAgentName,
      expectedTabId,
      state.pane,
      opts.cwd,
      deps,
    );
  }
  if (state.kind === "unowned" || state.kind === "owner-shell-only") {
    // A single snapshot immediately after an indeterminate start cannot tell
    // "genuinely dead" apart from "still starting" — the harness process may
    // not have attached to the pane yet. Give it the same bounded recheck
    // window the restored-tab-takeover path already gives a shell-only
    // owner before declaring death, so a still-starting process is adopted
    // instead of being torn down and relaunched into a second, competing
    // process in the same worktree.
    const rechecked = await recheckRestoredOwnerBeforeQuarantine(
      registeredAgentName,
      expectedTabId,
      deps,
    );
    if (rechecked.kind === "already-live") return rechecked.result;
    return { kind: "proven-dead" };
  }
  throw new RegisteredAgentRestoredTabCollisionError(
    registeredAgentName,
    `fresh-launch owner pane "${state.owner.paneId}" is unavailable`,
  );
}

export async function resumeRegisteredAgentInRestoredTabWithDeps(
  registeredAgentName: string,
  opts: StartOptions,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<ResumeRegisteredAgentInRestoredTabResult> {
  const matchingTabs = exactLabelTabs(
    await deps.listTabs(),
    registeredAgentName,
  );
  if (matchingTabs.length === 0) {
    await deps.startAgent(registeredAgentName, opts);
    return { kind: "new-tab-launched" };
  }
  if (matchingTabs.length > 1) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `${matchingTabs.length} tabs have the exact registered-agent label`,
    );
  }

  const tab = matchingTabs[0]!;
  let takeoverSnapshot = await inspectRestoredTab(
    registeredAgentName,
    tab.tabId,
    deps,
  );
  const initialState = classifyRestoredOwnerSnapshot(
    registeredAgentName,
    tab.tabId,
    takeoverSnapshot,
    opts.cwd,
  );
  if (initialState.kind === "already-live") {
    return initialState.result;
  }
  if (initialState.kind === "unowned-live") {
    return claimUnownedLiveRestoredAgent(
      registeredAgentName,
      tab.tabId,
      initialState.pane,
      opts.cwd,
      deps,
    );
  }

  let ownerToQuarantine: HerdrNameOwner | undefined;
  if (
    initialState.kind === "owner-shell-only" ||
    initialState.kind === "owner-unavailable"
  ) {
    const rechecked = await recheckRestoredOwnerBeforeQuarantine(
      registeredAgentName,
      tab.tabId,
      deps,
    );
    if (rechecked.kind === "already-live") {
      return rechecked.result;
    }
    takeoverSnapshot = rechecked.snapshot;
    ownerToQuarantine = rechecked.owner;
  }

  let quarantinedOwnerName: string | undefined;
  if (ownerToQuarantine !== undefined) {
    quarantinedOwnerName = await quarantineRestoredNameOwner(
      registeredAgentName,
      ownerToQuarantine,
      deps,
    );
  }

  const launchPaneId =
    ownerToQuarantine?.paneId ??
    (takeoverSnapshot.panes.length === 1
      ? takeoverSnapshot.panes[0]!.paneId
      : undefined);
  if (launchPaneId === undefined) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `restored tab "${tab.tabId}" has ${takeoverSnapshot.panes.length} panes and no unique shell owner to launch in`,
    );
  }

  let newAgentPaneId: string | undefined;
  try {
    newAgentPaneId = await deps.startInTab(
      registeredAgentName,
      launchPaneId,
      opts,
    );
  } catch (error) {
    if (
      !(error instanceof HerdrCommandError) ||
      error.code !== "agent_name_taken"
    ) {
      throw error;
    }
    const concurrentWinner = await verifyConcurrentRegisteredAgentWinner(
      registeredAgentName,
      tab.tabId,
      deps,
    );
    if (concurrentWinner !== undefined) {
      return concurrentWinner;
    }
    throw error;
  }

  if (newAgentPaneId === undefined) {
    try {
      const owner = (await deps.listNameOwners()).find(
        (candidate) =>
          candidate.name === registeredAgentName &&
          candidate.tabId === tab.tabId,
      );
      newAgentPaneId = owner?.paneId;
    } catch {}
  }
  await trimPreExistingRestoredPanes(
    takeoverSnapshot.panes,
    newAgentPaneId,
    deps,
  );
  return {
    kind: "restored-tab-takeover",
    tabId: tab.tabId,
    paneId: newAgentPaneId,
    quarantinedOwnerName,
  };
}

export const AGENT_START_BUSY_MAX_ATTEMPTS = 3;
export const AGENT_START_BUSY_RETRY_DELAY_MS = 400;
export const START_CONTEXT_ENV_ALLOWLIST = [
  "TERM",
  "TERM_PROGRAM",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "XDG_SESSION_TYPE",
  "CLAUDE_BIN",
  "CODEX_BIN",
  "YOLO_OVERRIDE_DIR",
] as const;

import { deliverOpeningPrompt } from "./herdr-opening-prompt.ts";
