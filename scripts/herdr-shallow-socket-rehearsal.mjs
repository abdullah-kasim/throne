#!/usr/bin/env node
import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ownedHerdrClientPath } from "../src/herdr/herdr-client.ts";
import {
  assertHerdrSuiteSocketPathFits,
  launchHerdrSuiteSession,
  resolveHerdrSuiteSessionName,
} from "./herdr-suite-session.mjs";
import {
  createSuiteRunId,
  resolveSuiteRunPaths,
} from "./run-suite-container.mjs";

const execFileAsync = promisify(execFile);

function readNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readCreatedWorkspaceId(response) {
  if (
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) {
    throw new Error("workspace create response must be a JSON object");
  }
  const result = response.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("workspace create response is missing object result");
  }
  const workspace = result.workspace;
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    Array.isArray(workspace)
  ) {
    throw new Error(
      "workspace create response is missing object result.workspace",
    );
  }
  const workspaceId = readNonEmptyString(workspace.workspace_id);
  if (!workspaceId) {
    throw new Error(
      "workspace create response is missing non-empty result.workspace.workspace_id",
    );
  }
  const nestedIds = [result.root_pane, result.tab]
    .map((entry) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? readNonEmptyString(entry.workspace_id)
        : undefined,
    )
    .filter((entry) => entry !== undefined);
  if (nestedIds.some((nestedId) => nestedId !== workspaceId)) {
    throw new Error(
      `workspace create response has ambiguous nested workspace IDs: ${JSON.stringify([workspaceId, ...nestedIds])}`,
    );
  }
  return workspaceId;
}

function parseJsonOutput(commandName, stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${commandName} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readCreatedTabId(response) {
  const tabId =
    readNonEmptyString(response?.result?.tab?.tab_id) ??
    readNonEmptyString(response?.result?.root_pane?.tab_id);
  if (!tabId) {
    throw new Error("tab create response is missing a nested tab ID");
  }
  return tabId;
}

async function runHerdrJson(executablePath, sessionName, env, args) {
  const { stdout } = await execFileAsync(
    executablePath,
    ["--session", sessionName, ...args],
    { cwd: process.cwd(), env },
  );
  return parseJsonOutput(`herdr ${args.join(" ")}`, stdout);
}

async function pathIsAbsent(targetPath) {
  return stat(targetPath).then(
    () => false,
    (error) => {
      if (error?.code === "ENOENT") return true;
      throw error;
    },
  );
}

function assertIsolatedFixtureState(sessionName, suitePaths) {
  if (!sessionName.startsWith("throne-suite-")) {
    throw new Error(
      `isolated rehearsal requires a temporary suite session, received ${JSON.stringify(sessionName)}`,
    );
  }
  if (!path.basename(suitePaths.configHome).startsWith("throne-herdr-")) {
    throw new Error(
      `isolated rehearsal requires a fixture-owned config root, received ${suitePaths.configHome}`,
    );
  }
  return {
    sessionNameIsTemporary: true,
    configHome: suitePaths.configHome,
    liveCourtStateAccessed: false,
  };
}

export async function runShallowSocketRehearsal(runId = createSuiteRunId()) {
  const suitePaths = resolveSuiteRunPaths(runId);
  const sessionName = resolveHerdrSuiteSessionName(runId);
  const env = { ...process.env, XDG_CONFIG_HOME: suitePaths.configHome };
  const isolation = assertIsolatedFixtureState(sessionName, suitePaths);
  const measurement = assertHerdrSuiteSocketPathFits(
    suitePaths.configHome,
    sessionName,
  );
  const sessionDirectory = path.dirname(measurement.socketPath);
  const executablePath = ownedHerdrClientPath();
  const workspaceLabel = `rehearsal-${runId}`;
  const tabLabel = `rehearsal-tab-${runId}`;
  let sessionHandle;
  let workspaceId;
  let tabId;
  let lifecycleError;
  try {
    sessionHandle = await launchHerdrSuiteSession(runId, env);
    const status = await runHerdrJson(executablePath, sessionName, env, [
      "status",
      "--json",
    ]);
    if (
      status?.server?.running !== true ||
      status?.server?.session !== sessionName
    ) {
      throw new Error(`unexpected Herdr status: ${JSON.stringify(status)}`);
    }
    const workspaceCreate = await runHerdrJson(
      executablePath,
      sessionName,
      env,
      [
        "workspace",
        "create",
        "--cwd",
        process.cwd(),
        "--label",
        workspaceLabel,
        "--no-focus",
      ],
    );
    workspaceId = readCreatedWorkspaceId(workspaceCreate);
    const tabCreate = await runHerdrJson(executablePath, sessionName, env, [
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      process.cwd(),
      "--label",
      tabLabel,
      "--no-focus",
    ]);
    tabId = readCreatedTabId(tabCreate);
    const tabsAfterCreate = await runHerdrJson(
      executablePath,
      sessionName,
      env,
      ["tab", "list", "--workspace", workspaceId],
    );
    if (!JSON.stringify(tabsAfterCreate).includes(tabId)) {
      throw new Error(`created tab ${tabId} is absent from tab list`);
    }
    await runHerdrJson(executablePath, sessionName, env, [
      "tab",
      "close",
      tabId,
    ]);
    const tabsAfterClose = await runHerdrJson(
      executablePath,
      sessionName,
      env,
      ["tab", "list", "--workspace", workspaceId],
    );
    if (JSON.stringify(tabsAfterClose).includes(tabId)) {
      throw new Error(`closed tab ${tabId} remains in tab list`);
    }
  } catch (error) {
    lifecycleError = error;
  } finally {
    await sessionHandle?.cleanup().catch((error) => {
      lifecycleError ??= error;
    });
    await rm(suitePaths.configHome, { recursive: true, force: true });
    await rm(suitePaths.runRoot, { recursive: true, force: true });
  }
  const cleanup = {
    socketAbsent: await pathIsAbsent(measurement.socketPath),
    sessionDirectoryAbsent: await pathIsAbsent(sessionDirectory),
    configRootAbsent: await pathIsAbsent(suitePaths.configHome),
    runRootAbsent: await pathIsAbsent(suitePaths.runRoot),
  };
  if (Object.values(cleanup).some((absent) => !absent)) {
    throw new Error(`rehearsal cleanup incomplete: ${JSON.stringify(cleanup)}`);
  }
  if (lifecycleError) throw lifecycleError;
  return {
    runId,
    sessionName,
    configRoot: suitePaths.configHome,
    socketPath: measurement.socketPath,
    pathBytesWithNul: measurement.encodedBytes,
    workspaceId,
    tabId,
    cleanup,
    isolation,
  };
}

const isDirectlyExecuted =
  import.meta.url === `file://${fileURLToPath(new URL(import.meta.url))}` &&
  path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isDirectlyExecuted) {
  const result = await runShallowSocketRehearsal(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
