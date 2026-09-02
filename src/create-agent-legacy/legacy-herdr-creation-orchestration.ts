import { Injectable } from "@nestjs/common";
import { createTab, closeTab, closePane } from "./legacy-herdr-tab.service.ts";
import { waitForShellReady } from "../herdr/herdr-readiness.ts";
import { startInTab } from "../herdr/herdr-launch.ts";
import { HerdrCommandError } from "../herdr/herdr-client.ts";
import {
  annotateStartFailure,
  collectStartCallerContext,
} from "../herdr/herdr-launch-context.ts";
import {
  AgentStartIndeterminateError,
  AgentStartPaneBusyError,
} from "../herdr/herdr-errors.ts";
import { isIndeterminateAgentStartError } from "../herdr/herdr-launch-command.ts";
import { PaneReadinessTimeoutError } from "../herdr/herdr-readiness.ts";
import type {
  StartOptions,
  AgentStartEvidence,
  StartCallerContext,
  ShellReadyEvidence,
} from "../herdr/herdr-create.contracts.ts";
import type { ResumeRegisteredAgentInRestoredTabDeps } from "../herdr/herdr-create.contracts.ts";
import { sleep } from "../herdr/herdr-screen.service.ts";
import { isTransientPaneBusyStartError } from "../herdr/herdr-launch-context.ts";
import {
  AGENT_START_BUSY_MAX_ATTEMPTS,
  AGENT_START_BUSY_RETRY_DELAY_MS,
} from "../herdr/herdr-agent-recovery.ts";
import {
  listTabs,
  listPanes,
  listNameOwners,
  getPaneProcessInfo,
  renameAgent,
} from "./legacy-herdr-runtime.service.ts";

export async function startAgent(
  name: string,
  opts: StartOptions,
  deps: {
    createTab: typeof createTab;
    waitForShellReady: typeof waitForShellReady;
    startInTab: typeof startInTab;
    closeTab: typeof closeTab;
    closePane: typeof closePane;
    sleep?: (milliseconds: number) => Promise<void>;
    collectStartCallerContext?: typeof collectStartCallerContext;
  } = {
    createTab,
    waitForShellReady,
    startInTab,
    closeTab,
    closePane,
  },
): Promise<AgentStartEvidence> {
  const pause = deps.sleep ?? sleep;
  const callerContext =
    deps.collectStartCallerContext ?? collectStartCallerContext;
  const { tabId, rootPaneId } = await deps.createTab(name, opts.cwd);

  let shell: ShellReadyEvidence;
  try {
    shell = await deps.waitForShellReady(rootPaneId);
  } catch (error) {
    await deps.closeTab(tabId).catch(() => undefined);
    annotateStartFailure(error, {
      phase:
        error instanceof PaneReadinessTimeoutError
          ? error.phase
          : "tab-created",
      ownership: "determinate",
      tabId,
      rootPaneId,
      startAttempts: 0,
      context: await callerContext(),
    });
    throw error;
  }

  let agentPaneId: string | undefined;
  let startAttempts = 0;
  for (;;) {
    startAttempts += 1;
    try {
      agentPaneId = await deps.startInTab(name, rootPaneId, opts);
      break;
    } catch (error) {
      if (isIndeterminateAgentStartError(error)) {
        const indeterminate = new AgentStartIndeterminateError(
          name,
          tabId,
          rootPaneId,
          error,
        );
        annotateStartFailure(indeterminate, {
          phase: shell.phase,
          ownership: "indeterminate",
          tabId,
          rootPaneId,
          startAttempts,
          context: await callerContext(),
        });
        throw indeterminate;
      }
      if (
        isTransientPaneBusyStartError(error) &&
        startAttempts < AGENT_START_BUSY_MAX_ATTEMPTS
      ) {
        await pause(AGENT_START_BUSY_RETRY_DELAY_MS);
        try {
          shell = await deps.waitForShellReady(rootPaneId);
        } catch (readinessError) {
          await deps.closeTab(tabId).catch(() => undefined);
          annotateStartFailure(readinessError, {
            phase:
              readinessError instanceof PaneReadinessTimeoutError
                ? readinessError.phase
                : "sentinel-executed",
            ownership: "determinate",
            tabId,
            rootPaneId,
            startAttempts,
            context: await callerContext(),
          });
          throw readinessError;
        }
        continue;
      }
      await deps.closeTab(tabId).catch(() => undefined);
      const failure = isTransientPaneBusyStartError(error)
        ? new AgentStartPaneBusyError(
            name,
            tabId,
            rootPaneId,
            startAttempts,
            error,
          )
        : error;
      annotateStartFailure(failure, {
        phase: shell.phase,
        ownership: "determinate",
        tabId,
        rootPaneId,
        startAttempts,
        context: await callerContext(),
      });
      throw failure;
    }
  }

  if (agentPaneId !== undefined && agentPaneId !== rootPaneId) {
    try {
      await deps.closePane(rootPaneId);
    } catch {}
  }

  return {
    phase: "agent-start-accepted",
    tabId,
    rootPaneId,
    agentPaneId,
    startAttempts,
    shell,
  };
}

export const REAL_RESUME_REGISTERED_AGENT_DEPS: ResumeRegisteredAgentInRestoredTabDeps =
  {
    listTabs,
    listPanes,
    listNameOwners,
    getPaneProcessInfo,
    renameAgent,
    startInTab,
    startAgent,
    closePane,
    sleep,
  };

@Injectable()
export class HerdrCreationOrchestrationService {
  startAgent = startAgent;
}
