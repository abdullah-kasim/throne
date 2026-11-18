import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { THRONE_CLI_PATH, pause, pollUntil, readJson, runStandInPi } from "../support.mjs";
import { installPiStateExtensions } from "../../../src/herdr/pi-state-install.ts";
import { ownedHerdrClientPath } from "../../../src/herdr/herdr-client.ts";

const AGENT_NAME = "shadow-pievidence-state";
const SLOW_TASK = "state evidence: work slowly";
const BLOCKED_TASK = "state evidence: end blocked";
const REAPABLE_TASK = "state evidence: claim reapable";
const BLOCKED_ANSWER = '{"blocked":true} BLOCKED_BY_own-background-run (x)';
const PLAIN_ANSWER = "state evidence turn finished";

function lastUserText(body) {
  const users = (body.messages ?? []).filter((message) => message.role === "user");
  const last = users[users.length - 1];
  if (last === undefined) return "";
  return typeof last.content === "string" ? last.content : (last.content ?? []).map((part) => part.text ?? "").join("");
}

function toolResultsSinceLastUser(body) {
  const messages = body.messages ?? [];
  let count = 0;
  for (const message of messages) {
    if (message.role === "user") count = 0;
    if (message.role === "tool") count += 1;
  }
  return count;
}

function bashCall(command) {
  return { toolCalls: [{ id: `call-${randomUUID()}`, name: "bash", arguments: JSON.stringify({ command }) }] };
}

function plannedReply(body) {
  const task = lastUserText(body);
  const answered = toolResultsSinceLastUser(body);
  if (task.includes(SLOW_TASK) && answered === 0) return bashCall("sleep 6");
  if (task.includes(REAPABLE_TASK) && answered === 0) return bashCall(`${THRONE_CLI_PATH} my-state reapable completed`);
  if (task.includes(BLOCKED_TASK)) return { text: BLOCKED_ANSWER };
  return { text: PLAIN_ANSWER };
}

async function herdrRecordingShim(workspace) {
  const log = path.join(workspace.lineDirectory, "herdr-calls.log");
  const shim = path.join(workspace.scratch, "herdr-recording-shim");
  await writeFile(shim, `#!/usr/bin/env bash\nprintf '%s <- %s\\n' "$*" "$(tr '\\0' ' ' < /proc/$PPID/cmdline | cut -c1-200)" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(ownedHerdrClientPath(process.env))} "$@"\n`);
  await chmod(shim, 0o755);
  await writeFile(log, "");
  return { shim, log };
}

async function renameOnceHerdrSeesTheAgent(herdr, paneId) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await herdr.call("agent", "rename", paneId, AGENT_NAME);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await pause(500);
    }
  }
}

async function launchStatePi(workspace) {
  const provider = await workspace.standIn({ plannedReply });
  const agentDirectory = await workspace.piAgentDirectory(provider.baseUrl);
  const installed = await installPiStateExtensions(agentDirectory);
  const agentFolder = path.join(workspace.dataHome, "data", AGENT_NAME);
  await mkdir(agentFolder, { recursive: true });
  await writeFile(path.join(agentFolder, "identity.md"), `# Identity — ${AGENT_NAME}\n\n- **Role:** Shadow\n- **Supervisor (routine):** alpha-pievidence-01\n`);
  const herdr = await workspace.herdr();
  const recording = await herdrRecordingShim(workspace);
  const paneId = await herdr.openPane(workspace.repository);
  await runStandInPi(workspace, herdr, paneId, agentDirectory, {
    THRONE_AGENT_NAME: AGENT_NAME,
    THRONE_HERDR_CLIENT_PATH: recording.shim,
  });
  const ready = await herdr.waitForPi(paneId, "deepseek-flash");
  if (!ready.found) throw new Error(`pi never drew its footer naming deepseek-flash: ${ready.cause}`);
  await renameOnceHerdrSeesTheAgent(herdr, paneId);
  const pane = JSON.parse(await herdr.call("pane", "list")).result.panes.find((candidate) => candidate.pane_id === paneId);
  await herdr.call("tab", "rename", pane.tab_id, AGENT_NAME);
  const stateFile = path.join(agentFolder, "state.json");
  const prompt = async (text) => {
    await herdr.typeAndSubmit(paneId, text);
  };
  const readState = async () => readJson(stateFile).catch(() => null);
  const waitForState = async (matches, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    let state = null;
    while (Date.now() < deadline) {
      state = await readState();
      if (state !== null && matches(state)) return state;
      await pause(250);
    }
    return state;
  };
  const statuses = async (name) => {
    const result = await workspace.throneCli(["agent-statuses"], { THRONE_HERDR_CLIENT_PATH: recording.shim });
    await workspace.saveText(name, `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  return { provider, installed, herdr, paneId, prompt, readState, waitForState, statuses, recording };
}

function agentRow(text) {
  return text.split("\n").find((row) => row.includes(AGENT_NAME)) ?? "";
}

async function statusesShowWorkingThenIdle(workspace) {
  const pi = await launchStatePi(workspace);
  try {
    await pi.prompt(SLOW_TASK);
    await pi.waitForState((state) => state.state === "working");
    const during = agentRow((await pollUntil(() => pi.statuses("agent-statuses-during-turn.txt"), (text) => /\bworking\b/.test(agentRow(text)), 15_000, 500)).value);
    await pi.herdr.waitForPaneText(pi.paneId, (text) => text.includes(PLAIN_ANSWER));
    const after = agentRow((await pollUntil(() => pi.statuses("agent-statuses-after-turn.txt"), (text) => /\bidle\b/.test(agentRow(text)), 15_000, 500)).value);
    await pi.herdr.savePane(pi.paneId, "pane-after-turn.txt");
    const live = (row) => /\bLIVE\b/i.test(row) && /shadow/i.test(row);
    const passed = live(during) && /\bworking\b/.test(during) && live(after) && /\bidle\b/.test(after);
    return { verdict: passed ? "PASS" : "FAIL", observed: `during turn: "${during.trim()}"; after turn: "${after.trim()}"; herdr integration at ${pi.installed.herdrIntegration}` };
  } finally {
    await pi.provider.close();
  }
}

async function stateFileFollowsTurns(workspace) {
  const pi = await launchStatePi(workspace);
  try {
    await pi.prompt(SLOW_TASK);
    const working = await pi.waitForState((state) => state.state === "working" && state.declaredBy === "turn-start");
    await pi.herdr.waitForPaneText(pi.paneId, (text) => text.includes(PLAIN_ANSWER));
    await pi.waitForState((state) => state.state !== "working");
    await pi.prompt(BLOCKED_TASK);
    const waiting = await pi.waitForState((state) => state.state === "waiting-on-own-run");
    await pi.prompt(REAPABLE_TASK);
    const reapable = await pi.waitForState((state) => state.state === "reapable");
    await pi.herdr.savePane(pi.paneId, "pane-after-turns.txt");
    await workspace.saveText("state-readings.json", `${JSON.stringify({ working, waiting, reapable }, null, 2)}\n`);
    const passed = working?.state === "working" && working?.declaredBy === "turn-start"
      && waiting?.state === "waiting-on-own-run" && waiting?.waitingOn === "x"
      && reapable?.state === "reapable" && reapable?.reapableReason === "completed";
    return {
      verdict: passed ? "PASS" : "FAIL",
      observed: `turn start: ${working?.state} by ${working?.declaredBy}; blocked marker turn end: ${waiting?.state} on ${waiting?.waitingOn}; my-state reapable completed run by pi's bash tool: ${reapable?.state} (${reapable?.reapableReason})`,
    };
  } finally {
    await pi.provider.close();
  }
}

async function noTimedCheckReadsThePane(workspace) {
  const pi = await launchStatePi(workspace);
  try {
    await pi.prompt(SLOW_TASK);
    await pi.waitForState((state) => state.state === "working");
    await writeFile(pi.recording.log, "");
    const sweep = await workspace.throneCli(["no-idling", "--local"], { THRONE_HERDR_CLIENT_PATH: pi.recording.shim });
    await workspace.saveText("no-idling.txt", `exit ${sweep.code}\n${sweep.stdout}\n${sweep.stderr}`);
    await pi.statuses("agent-statuses.txt");
    const calls = (await readFile(pi.recording.log, "utf8")).split("\n").filter((line) => line !== "");
    const piPaneReads = calls.filter((line) => /\b(pane|agent) read\b/.test(line) && line.includes(pi.paneId));
    const historyReads = piPaneReads.filter((line) => !/--source visible\b/.test(line));
    const screenReads = piPaneReads.length - historyReads.length;
    const passed = calls.length > 0 && historyReads.length === 0;
    return {
      verdict: passed ? "PASS" : "FAIL",
      observed: `no-idling sweep exit ${sweep.code} and agent-statuses made ${calls.length} herdr calls; history reads of the pi pane: ${historyReads.length}${historyReads.length > 0 ? ` (${historyReads.join(" | ")})` : ""}; visible-screen reads: ${screenReads} (the name-repair composer check, which reads only the visible screen, never history, and never sets state)`,
    };
  } finally {
    await pi.provider.close();
  }
}

export const lines = [
  { id: "P5.1", needsPane: true, run: statusesShowWorkingThenIdle },
  { id: "P5.2", needsPane: true, run: stateFileFollowsTurns },
  { id: "P5.3", needsPane: true, run: noTimedCheckReadsThePane },
];
