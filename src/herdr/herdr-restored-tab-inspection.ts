import { Injectable } from "@nestjs/common";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import type { SupportedComposerHarness } from "../codex-screen/composer/composer.types.ts";
import { HARNESS_NAMES, runtimeHarness } from "../harness-routing/harness.ts";
import { AgentResolutionError, sameAgentName } from "./herdr-identity-contracts.ts";
import { argvExecutableCandidates, executableName, isLiveHarnessProcess, paneHasLiveHarnessProcess } from "./herdr-process-detection.ts";
import { getPaneProcessInfo, listNameOwners, listPanes, listTabs, resolveAgent, renameAgent } from "./herdr-runtime.service.ts";
import { pathsResolveEqual } from "../shared-policy/path-equivalence.ts";
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

import { RegisteredAgentRestoredTabCollisionError } from "./herdr-errors.ts";
import {
  RESTORED_TAB_RACE_RECHECK_ATTEMPTS,
  RESTORED_TAB_RACE_RECHECK_MS,
} from "./herdr-create.contracts.ts";
import type {
  RestoredTabSnapshot,
  RestoredOwnerSnapshotState,
  RestoredOwnerRecheckResult,
  ResumeRegisteredAgentInRestoredTabDeps,
  ResumeRegisteredAgentInRestoredTabResult,
} from "./herdr-create.contracts.ts";

export function exactLabelTabs(
  tabs: HerdrTab[],
  registeredAgentName: string,
): HerdrTab[] {
  return tabs.filter((tab) => tab.label === registeredAgentName);
}

type ExactRestoredPaneInspection =
  | { kind: "inspected"; info: HerdrPaneProcessInfo }
  | { kind: "disappeared"; refreshedPanes: HerdrPane[] };

async function inspectExactRestoredPane(
  pane: HerdrPane,
  deps: Pick<
    ResumeRegisteredAgentInRestoredTabDeps,
    "listPanes" | "getPaneProcessInfo" | "sleep"
  >,
): Promise<ExactRestoredPaneInspection> {
  for (
    let attempt = 1;
    attempt <= RESTORED_TAB_RACE_RECHECK_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const info = await deps.getPaneProcessInfo(pane.paneId);
      if (info.paneId !== pane.paneId) {
        throw new Error(
          `herdr pane process-info for "${pane.paneId}" returned "${info.paneId}"`,
        );
      }
      return { kind: "inspected", info };
    } catch (error) {
      if (error instanceof IncompleteHerdrPaneProcessInfoError) {
        if (attempt === RESTORED_TAB_RACE_RECHECK_ATTEMPTS) {
          throw new IncompleteHerdrPaneProcessInfoError(
            `pane "${pane.paneId}" remained incomplete after ${RESTORED_TAB_RACE_RECHECK_ATTEMPTS} attempts`,
            error,
          );
        }
        await deps.sleep(RESTORED_TAB_RACE_RECHECK_MS);
        continue;
      }
      if (
        !(error instanceof HerdrCommandError) ||
        error.code !== "pane_not_found"
      ) {
        throw error;
      }
      const refreshedPanes = await deps.listPanes();
      if (
        refreshedPanes.some((candidate) => candidate.paneId === pane.paneId)
      ) {
        throw error;
      }
      return { kind: "disappeared", refreshedPanes };
    }
  }
  throw new Error(
    "restored pane process inspection exhausted without a result",
  );
}

function sameRestoredTabPaneInventory(
  inspectedPanes: HerdrPane[],
  refreshedPanes: HerdrPane[],
): boolean {
  if (inspectedPanes.length !== refreshedPanes.length) {
    return false;
  }
  const inspectedByPaneId = new Map(
    inspectedPanes.map((pane) => [pane.paneId, pane]),
  );
  return (
    inspectedByPaneId.size === inspectedPanes.length &&
    refreshedPanes.every((pane) => {
      const inspected = inspectedByPaneId.get(pane.paneId);
      return inspected?.terminalId === pane.terminalId;
    })
  );
}

export async function inspectRestoredTab(
  registeredAgentName: string,
  tabId: string,
  deps: Pick<
    ResumeRegisteredAgentInRestoredTabDeps,
    "listPanes" | "listNameOwners" | "getPaneProcessInfo" | "sleep"
  >,
): Promise<RestoredTabSnapshot> {
  let initialPanes = (await deps.listPanes()).filter(
    (pane) => pane.tabId === tabId,
  );
  for (
    let attempt = 1;
    attempt <= RESTORED_TAB_RACE_RECHECK_ATTEMPTS;
    attempt += 1
  ) {
    const pendingPanes = [...initialPanes];
    const queuedPaneIds = new Set(pendingPanes.map((pane) => pane.paneId));
    const panes: HerdrPane[] = [];
    const processInfos: HerdrPaneProcessInfo[] = [];
    for (let index = 0; index < pendingPanes.length; index += 1) {
      const pane = pendingPanes[index]!;
      const inspection = await inspectExactRestoredPane(pane, deps);
      if (inspection.kind === "disappeared") {
        for (const refreshedPane of inspection.refreshedPanes) {
          if (
            refreshedPane.tabId === tabId &&
            !queuedPaneIds.has(refreshedPane.paneId)
          ) {
            pendingPanes.push(refreshedPane);
            queuedPaneIds.add(refreshedPane.paneId);
          }
        }
        continue;
      }
      panes.push(pane);
      processInfos.push(inspection.info);
    }

    const owners = await deps.listNameOwners();
    const refreshedPanes = (await deps.listPanes()).filter(
      (pane) => pane.tabId === tabId,
    );
    const refreshedByPaneId = new Map(
      refreshedPanes.map((pane) => [pane.paneId, pane]),
    );
    const hasUnreconciledDifferentOwner = owners.some((owner) => {
      if (owner.name === registeredAgentName || owner.tabId !== tabId) {
        return false;
      }
      return (
        refreshedByPaneId.get(owner.paneId)?.terminalId !== owner.terminalId
      );
    });
    if (
      sameRestoredTabPaneInventory(panes, refreshedPanes) &&
      !hasUnreconciledDifferentOwner
    ) {
      const liveHarnessPaneIds = new Set(
        processInfos
          .filter(paneHasLiveHarnessProcess)
          .map((processInfo) => processInfo.paneId),
      );
      return { panes, owners, liveHarnessPaneIds, processInfos };
    }
    if (attempt === RESTORED_TAB_RACE_RECHECK_ATTEMPTS) {
      throw new RegisteredAgentRestoredTabCollisionError(
        registeredAgentName,
        `restored tab "${tabId}" pane/owner inventory remained unstable after ${RESTORED_TAB_RACE_RECHECK_ATTEMPTS} inspections`,
      );
    }
    initialPanes = refreshedPanes;
    await deps.sleep(RESTORED_TAB_RACE_RECHECK_MS);
  }
  throw new Error("restored tab inspection exhausted without a snapshot");
}

function exactOwners(
  snapshot: RestoredTabSnapshot,
  registeredAgentName: string,
): HerdrNameOwner[] {
  return snapshot.owners.filter((owner) => owner.name === registeredAgentName);
}

export function classifyRestoredOwnerSnapshot(
  registeredAgentName: string,
  tabId: string,
  snapshot: RestoredTabSnapshot,
  recordedCwd?: string,
): RestoredOwnerSnapshotState {
  const owners = exactOwners(snapshot, registeredAgentName);
  if (owners.length > 1) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `${owners.length} raw owners still claim the registered name`,
    );
  }

  const owner = owners[0];
  if (owner === undefined) {
    if (snapshot.liveHarnessPaneIds.size > 0) {
      const pane = snapshot.panes[0];
      const processInfo = snapshot.processInfos.find(
        (candidate) => candidate.paneId === pane?.paneId,
      );
      const harnessProcesses =
        processInfo?.foregroundProcesses.filter(isLiveHarnessProcess);
      const expectedCwd = recordedCwd;
      if (
        snapshot.panes.length === 1 &&
        snapshot.liveHarnessPaneIds.size === 1 &&
        snapshot.owners.every((candidate) => candidate.tabId !== tabId) &&
        pane !== undefined &&
        expectedCwd !== undefined &&
        pane.cwd !== undefined &&
        pathsResolveEqual(pane.cwd, expectedCwd) &&
        harnessProcesses !== undefined &&
        harnessProcesses.length > 0 &&
        harnessProcesses.every(
          (process) =>
            process.cwd !== undefined &&
            pathsResolveEqual(process.cwd, expectedCwd),
        )
      ) {
        return { kind: "unowned-live", pane };
      }
      throw new RegisteredAgentRestoredTabCollisionError(
        registeredAgentName,
        `restored tab "${tabId}" contains a genuine Claude/Codex harness without the exact registered-name owner`,
      );
    }
    return { kind: "unowned" };
  }
  if (owner.tabId !== tabId) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `raw name ownership belongs to pane "${owner.paneId}" in tab "${owner.tabId}", not restored tab "${tabId}"`,
    );
  }

  const ownerPanes = snapshot.panes.filter(
    (pane) => pane.paneId === owner.paneId,
  );
  if (ownerPanes.length > 1) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `exact owner pane "${owner.paneId}" appears ${ownerPanes.length} times in restored tab inventory`,
    );
  }
  const ownerPane = ownerPanes[0];
  if (ownerPane !== undefined && ownerPane.terminalId !== owner.terminalId) {
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `exact owner pane "${owner.paneId}" has terminal "${ownerPane.terminalId}", not owner terminal "${owner.terminalId}"`,
    );
  }

  if (snapshot.liveHarnessPaneIds.size > 0) {
    if (
      ownerPane !== undefined &&
      snapshot.liveHarnessPaneIds.size === 1 &&
      snapshot.liveHarnessPaneIds.has(owner.paneId)
    ) {
      const expectedCwd = recordedCwd;
      const ownerProcessInfo = snapshot.processInfos.find(
        (candidate) => candidate.paneId === owner.paneId,
      );
      const harnessProcesses =
        ownerProcessInfo?.foregroundProcesses.filter(isLiveHarnessProcess);
      if (
        expectedCwd !== undefined &&
        (ownerPane.cwd === undefined ||
          !pathsResolveEqual(ownerPane.cwd, expectedCwd) ||
          harnessProcesses === undefined ||
          harnessProcesses.length === 0 ||
          harnessProcesses.some(
            (process) =>
              process.cwd === undefined ||
              !pathsResolveEqual(process.cwd, expectedCwd),
          ))
      ) {
        throw new RegisteredAgentRestoredTabCollisionError(
          registeredAgentName,
          `exact live owner pane "${owner.paneId}" does not match recorded cwd "${recordedCwd}"`,
        );
      }
      return {
        kind: "already-live",
        result: {
          kind: "already-live",
          tabId,
          paneId: owner.paneId,
        },
      };
    }
    throw new RegisteredAgentRestoredTabCollisionError(
      registeredAgentName,
      `restored tab "${tabId}" contains a genuine Claude/Codex harness outside the exact registered-name owner`,
    );
  }

  return ownerPane === undefined
    ? { kind: "owner-unavailable", owner }
    : { kind: "owner-shell-only", owner };
}

@Injectable()
export class RestoredTabInspectionService {
  exactLabelTabs = exactLabelTabs;
  inspectRestoredTab = inspectRestoredTab;
  classifyRestoredOwnerSnapshot = classifyRestoredOwnerSnapshot;
}
