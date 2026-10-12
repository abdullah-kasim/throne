import path from "node:path";
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
import { findRestoredAgentTab } from "../herdr/restored-agent-tab.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { REGENT_TAB_LABEL } from "./regent-liveness.ts";

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
  return buildResumeArgv(
    {
      harness: parseHarness(spec.harness),
      model: spec.model,
      effort: spec.effort,
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
