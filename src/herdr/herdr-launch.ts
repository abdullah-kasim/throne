import { runHerdr } from "./herdr-client.ts";
import { HerdrCommandError } from "./herdr-client.ts";
import { launcherHarnessKind } from "./herdr-launch-command.ts";
import type { StartInTabDeps, StartOptions } from "./herdr-create.contracts.ts";
import {
  REAL_START_IN_TAB_DEPS,
  translatedLaunchContext,
  launchScriptText,
  waitForDetectedAgentInPane,
  spawnerOwnsStagedArtifacts,
  removeStagedArtifacts,
  HarnessLaunchIssuedError,
  shellQuote,
  hideFromBashHistory,
} from "./herdr-launch-command.ts";
import { renameAgent } from "./herdr-runtime.service.ts";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export async function startInTab(
  name: string,
  paneId: string,
  opts: StartOptions,
  deps: StartInTabDeps = REAL_START_IN_TAB_DEPS,
): Promise<string> {
  const expectedKind = launcherHarnessKind(opts);
  const launch = translatedLaunchContext(opts);
  let launchDir: string | undefined;
  const stagedArtifactPaths = [...(launch.stagedArtifactPaths ?? [])];
  let launchIssued = false;
  try {
    const launchRoot = path.join(os.homedir(), "tmp");
    mkdirSync(launchRoot, { recursive: true, mode: 0o700 });
    launchDir = mkdtempSync(path.join(launchRoot, "throne-herdr-launch-"));
    stagedArtifactPaths.unshift(launchDir);
    chmodSync(launchDir, 0o700);
    const scriptPath = path.join(launchDir, "launch");
    writeFileSync(scriptPath, launchScriptText(launch, stagedArtifactPaths), {
      encoding: "utf8",
      mode: 0o700,
    });
    chmodSync(scriptPath, 0o700);
    launchIssued = true;
    await deps.runHerdr([
      "pane",
      "send-text",
      paneId,
      hideFromBashHistory(`bash ${shellQuote(scriptPath)}`),
    ]);
    await deps.runHerdr(["pane", "send-keys", paneId, "Enter"]);
    await waitForDetectedAgentInPane(paneId, expectedKind, deps);
    await renameAgent(paneId, opts.tabLabel ?? name, { runHerdr: deps.runHerdr });
    return paneId;
  } catch (error) {
    if (
      error instanceof HerdrCommandError &&
      error.code === "agent_name_taken"
    ) {
      throw error;
    }
    if (launchIssued) {
      throw new HarnessLaunchIssuedError(error);
    }
    throw error;
  } finally {
    if (spawnerOwnsStagedArtifacts(launchIssued)) {
      removeStagedArtifacts(stagedArtifactPaths);
    }
  }
}

export const SHELL_READY_TIMEOUT_MS = 15_000;
export const SHELL_READY_PROBE_WINDOW_MS = 750;
export const SHELL_READY_CAPTURE_LINES = 200;
export const START_EVIDENCE_PHASES = [
  "tab-created",
  "pane-output-observed",
  "sentinel-executed",
  "agent-start-accepted",
] as const;
export const SHELL_READY_PROBE_COMMAND_MARKER =
  "printf '%s%s\\n' THRONE_SHELL_READY_";
