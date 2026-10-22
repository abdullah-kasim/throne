import path from "node:path";
import { sessionNameAtLaunch } from "../agent-settings/agent-settings-decision.ts";
import { AGENT_ROLES } from "../agent-settings/agent-settings.types.ts";
import {
  readSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { buildResumeArgv } from "../harness-routing/harness.ts";
import { parseHarness } from "../harness-routing/model-registry.ts";
import { resumeRegisteredAgentInRestoredTabWithDeps } from "../herdr/herdr-agent-recovery.ts";
import type {
  ResumeRegisteredAgentInRestoredTabDeps,
  StartOptions,
} from "../herdr/herdr-create.contracts.ts";
import { paneHasLiveHarnessProcess } from "../herdr/herdr-process-detection.ts";
import { exactLabelTabs } from "../herdr/herdr-restored-tab-inspection.ts";
import {
  findRestoredAgentTab,
  type RestoredAgentTabDeps,
} from "../herdr/restored-agent-tab.ts";
import { errorText } from "../shared-policy/error-text.ts";
import {
  launchAccountOption,
  type ReadAccountsConfig,
} from "../account/agent-account.ts";
import { REGENT_NAME, REGENT_TAB_LABEL } from "./regent-liveness.ts";

export interface RegentRestoredTabLaunch {
  freshSession: StartOptions;
  regentDir: string;
  readAccountsConfig: ReadAccountsConfig;
  writeStderr: (text: string) => void;
}

function readRegentSpawnSpec(regentDir: string): Promise<SpawnSpec | null> {
  return readSpawnSpec(path.basename(regentDir), path.dirname(regentDir));
}

function recordedSessionResumeArgv(spec: SpawnSpec, sessionId: string): string[] {
  const harness = parseHarness(spec.harness);
  return buildResumeArgv(
    {
      harness,
      model: spec.model,
      effort: spec.effort,
      sessionName: sessionNameAtLaunch(
        REGENT_NAME,
        AGENT_ROLES.REGENT,
        harness,
      ),
    },
    sessionId,
  );
}

async function recordedSessionResumeOptions(
  spec: SpawnSpec | null,
  launch: RegentRestoredTabLaunch,
): Promise<StartOptions | null> {
  if (spec?.session_id === undefined) return null;
  return {
    cwd: launch.freshSession.cwd,
    argv: recordedSessionResumeArgv(spec, spec.session_id),
    ...(await launchAccountOption(REGENT_NAME, spec.account, launch.readAccountsConfig)),
  };
}

async function resumeRecordedRegentSession(
  launch: RegentRestoredTabLaunch,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<StartOptions | null> {
  try {
    const resumeOptions = await recordedSessionResumeOptions(
      await readRegentSpawnSpec(launch.regentDir),
      launch,
    );
    if (resumeOptions === null) return null;
    await resumeRegisteredAgentInRestoredTabWithDeps(
      REGENT_TAB_LABEL,
      resumeOptions,
      deps,
    );
    return resumeOptions;
  } catch (error) {
    launch.writeStderr(
      "resurrectRegent: the recorded session could not be resumed in the " +
        `restored "${REGENT_TAB_LABEL}" tab (${errorText(error)}); starting ` +
        "a fresh session in that tab.\n",
    );
    return null;
  }
}

export async function relaunchRegentInRestoredTab(
  launch: RegentRestoredTabLaunch,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<StartOptions | null> {
  if ((await findRestoredAgentTab(REGENT_TAB_LABEL, deps)) === null) {
    return null;
  }
  const resumedWith = await resumeRecordedRegentSession(launch, deps);
  if (resumedWith !== null) return resumedWith;
  await resumeRegisteredAgentInRestoredTabWithDeps(
    REGENT_TAB_LABEL,
    launch.freshSession,
    deps,
  );
  return launch.freshSession;
}

export async function paneOfRegentTabStillRunningItsHarness(
  deps: RestoredAgentTabDeps,
): Promise<string | null> {
  const regentTabs = exactLabelTabs(await deps.listTabs(), REGENT_TAB_LABEL);
  if (regentTabs.length !== 1) return null;
  const regentPanes = (await deps.listPanes()).filter(
    (pane) => pane.tabId === regentTabs[0]!.tabId,
  );
  if (regentPanes.length !== 1) return null;
  const { paneId } = regentPanes[0]!;
  return paneHasLiveHarnessProcess(await deps.getPaneProcessInfo(paneId))
    ? paneId
    : null;
}
