import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLineWorkspace, piEntryPath, pollUntil, runCommand } from "../../pi-evidence/support.mjs";
import { isPiCodingAgentProcess } from "../../../src/harness-routing/harness.ts";

const SUPERVISOR = "alpha-capevidence-01";
const READY_TEXT = "deepseek-flash";
const MEMORY_FOLDER_PREFIX = "tmp-pi-evidence-";

export async function openRealCourt(capabilityWorkspace) {
  const paneFolder = path.join(capabilityWorkspace.scratch, "real-court-panes");
  await mkdir(paneFolder, { recursive: true });
  return createLineWorkspace(paneFolder);
}

export async function closeRealCourt(court) {
  await court.close();
  const memories = path.join(os.homedir(), ".memories");
  const folders = await readdir(memories).catch(() => []);
  await Promise.all(folders.filter((name) => name.startsWith(MEMORY_FOLDER_PREFIX)).map((name) => rm(path.join(memories, name), { recursive: true, force: true })));
}

export async function launchRealPiAgent(court, name, standIn, extraArguments = []) {
  const herdr = await court.herdr();
  const workspaces = JSON.parse(await herdr.call("workspace", "list")).result.workspaces ?? [];
  if (workspaces.length === 0) await herdr.call("workspace", "create", "--cwd", court.repository, "--no-focus");
  const supervisor = path.join(court.dataHome, "data", SUPERVISOR);
  await mkdir(supervisor, { recursive: true });
  await writeFile(path.join(supervisor, "spawn.json"), `${JSON.stringify({ harness: "pi", model: "flash", effort: 3, cwd: court.repository, objective_code: "capevidence" })}\n`);
  await court.addDeepseekAccount();
  await court.writePiAdmittingConfig();
  const created = await court.throneCliFromLiveRoot(
    ["create-agent", "--model", "pi/flash", "--role", "Shadow", "--name", name, "--supervisor", SUPERVISOR, "--non-campaign", "--cwd", court.repository, ...extraArguments],
    { PI_BIN: piEntryPath(), PI_OFFLINE: "1", THRONE_PI_PROVIDER_BASE_URL: standIn.baseUrl },
  );
  const panes = JSON.parse(await herdr.call("pane", "list")).result.panes;
  const paneId = panes.filter((pane) => pane.agent === "pi").at(-1)?.pane_id;
  const ready = paneId === undefined ? { found: false, cause: "no pi pane" } : await herdr.waitForPi(paneId, READY_TEXT);
  return { created, herdr, paneId, ready };
}

export async function piProcessesIn(herdr, paneId) {
  const info = await herdr.processInfo(paneId);
  return (info.foreground_processes ?? []).filter((entry) => isPiCodingAgentProcess({ name: entry.name, argv: entry.argv ?? [] }));
}

export async function killPiIn(herdr, paneId) {
  const running = await piProcessesIn(herdr, paneId);
  for (const entry of running) await runCommand("kill", ["-9", String(entry.pid)]);
  const left = (await pollUntil(() => piProcessesIn(herdr, paneId), (found) => found.length === 0, 15_000)).value;
  return { killed: running.length, left: left.length };
}

export function lastMessageIsAToolResult(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.at(-1)?.role === "tool";
}
