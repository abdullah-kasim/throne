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
import { REGENT_NAME, REGENT_TAB_LABEL } from "./regent-liveness.ts";

export interface RegentRestoredTabLaunch {
  freshSession: StartOptions;
  regentDir: string;
  writeStderr: (text: string) => void;
}

function readRegentSpawnSpec(regentDir: string): Promise<SpawnSpec | null> {
  return readSpawnSpec(path.basename(regentDir), path.dirname(regentDir));
}

function recordedSessionResumeArgv(spec: SpawnSpec | null): string[] | null {
  if (spec?.session_id === undefined) return null;
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
    spec.session_id,
  );
}

async function resumeRecordedRegentSession(
  launch: RegentRestoredTabLaunch,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<boolean> {
  try {
    const argv = recordedSessionResumeArgv(
      await readRegentSpawnSpec(launch.regentDir),
    );
    if (argv === null) return false;
    await resumeRegisteredAgentInRestoredTabWithDeps(
      REGENT_TAB_LABEL,
      { ...launch.freshSession, argv },
      deps,
    );
    return true;
  } catch (error) {
    launch.writeStderr(
      "resurrectRegent: the recorded session could not be resumed in the " +
        `restored "${REGENT_TAB_LABEL}" tab (${errorText(error)}); starting ` +
        "a fresh session in that tab.\n",
    );
    return false;
  }
}

export async function relaunchRegentInRestoredTab(
  launch: RegentRestoredTabLaunch,
  deps: ResumeRegisteredAgentInRestoredTabDeps,
): Promise<boolean> {
  if ((await findRestoredAgentTab(REGENT_TAB_LABEL, deps)) === null) {
    return false;
  }
  if (!(await resumeRecordedRegentSession(launch, deps))) {
    await resumeRegisteredAgentInRestoredTabWithDeps(
      REGENT_TAB_LABEL,
      launch.freshSession,
      deps,
    );
  }
  return true;
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
