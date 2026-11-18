import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pause, pollUntil, runCommand } from "../support.mjs";
import { STAND_IN_FINAL_ANSWER } from "../../../test/support/pi-provider-stand-in/pi-provider-stand-in.mjs";
import { isPiCodingAgentProcess } from "../../../src/harness-routing/harness.ts";
import { court } from "./delivery.mjs";

const AGENT_NAME = "shadow-pievidence-lifecycle";
const FIRST_MESSAGE = "remember the word kiwi";
const SECOND_MESSAGE = "which word did I ask you to remember";

async function piProcessesIn(herdr, paneId) {
  const info = await herdr.processInfo(paneId);
  return (info.foreground_processes ?? []).filter((entry) => isPiCodingAgentProcess({ name: entry.name, argv: entry.argv ?? [] }));
}


async function restartKeepsTheSession(workspace) {
  const { standIn, herdr, paneId, result, record } = await workspace.launchPiAgent(AGENT_NAME, "pi/flash");
  if (paneId === undefined) return { verdict: "FAIL", observed: `create-agent exit ${result.code}`, error: result.stderr.trim() };
  const ready = await herdr.waitForPi(paneId, "deepseek-flash");
  if (!ready.found) return { verdict: "FAIL", observed: "pi never started on the stand-in", error: ready.cause };
  const sessionId = record?.session_id;
  await herdr.typeAndSubmit(paneId, FIRST_MESSAGE);
  const firstDone = await herdr.waitForPaneText(paneId, (text) => standIn.requests.length > 0 && text.includes(STAND_IN_FINAL_ANSWER));
  await herdr.savePane(paneId, "pane-before-kill.txt");
  const before = await piProcessesIn(herdr, paneId);
  for (const entry of before) await runCommand("kill", ["-9", String(entry.pid)]);
  const afterKill = (await pollUntil(() => piProcessesIn(herdr, paneId), (found) => found.length === 0, 15_000)).value;
  const options = await workspace.courtResumeOptions(AGENT_NAME, standIn.baseUrl);
  if (options === null) return { verdict: "FAIL", observed: "the court's resume launched nothing" };
  const argv = await workspace.runCourtResume(paneId, options);
  const back = await herdr.waitForPaneText(paneId, (text) => text.includes("deepseek-flash") && text.includes(FIRST_MESSAGE));
  const requestsBefore = standIn.requests.length;
  await herdr.typeAndSubmit(paneId, SECOND_MESSAGE);
  await herdr.waitForPaneText(paneId, () => standIn.requests.slice(requestsBefore).some((body) => JSON.stringify(body).includes(SECOND_MESSAGE)));
  await herdr.savePane(paneId, "pane-after-resume.txt");
  const resumedRequest = standIn.requests.slice(requestsBefore).find((body) => JSON.stringify(body).includes(SECOND_MESSAGE));
  const historyKept = resumedRequest !== undefined && JSON.stringify(resumedRequest).includes(FIRST_MESSAGE);
  const samePane = (await piProcessesIn(herdr, paneId)).length > 0;
  const resumedById = argv[argv.indexOf("--session") + 1] === sessionId;
  const pass = firstDone.found && before.length > 0 && afterKill.length === 0 && back.found && historyKept && samePane && resumedById;
  return {
    verdict: pass ? "PASS" : "FAIL",
    observed:
      `first turn finished: ${firstDone.found}; pi processes killed: ${before.length}, left after kill: ${afterKill.length}; ` +
      `court resume argv: ${argv.slice(1).join(" ")}; relaunched in the same pane: ${samePane}; ` +
      `earlier message shown after resume: ${back.found}; earlier message sent with the next turn: ${historyKept}`,
  };
}

async function completeAndReapAPiShadow(workspace) {
  const name = "shadow-pievidence-reap";
  const worktree = path.join(workspace.dataHome, "worktrees", "repository", name);
  await runCommand("git", ["-C", workspace.repository, "worktree", "add", "-q", "-b", name, worktree]);
  const { herdr, paneId, result } = await workspace.launchPiAgent(name, "pi/flash", undefined, worktree);
  if (paneId === undefined) return { verdict: "FAIL", observed: `create-agent exit ${result.code}`, error: result.stderr.trim() };
  await herdr.waitForPi(paneId, "deepseek-flash");
  const before = await piProcessesIn(herdr, paneId);
  await writeFile(path.join(workspace.dataHome, "data", name, "REPORT.md"), "done\n");
  const base = (await runCommand("git", ["-C", workspace.repository, "rev-parse", "HEAD"])).stdout.trim();
  await runCommand("/usr/bin/git", ["-C", worktree, "-c", "user.name=pi-evidence", "-c", "user.email=pi-evidence@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "slice"]);
  await runCommand("/usr/bin/git", ["-C", workspace.repository, "merge", "-q", "--ff-only", name]);
  await writeFile(
    path.join(workspace.dataHome, "data", name, "tree-base.json"),
    `${JSON.stringify({ name, base: "master", branch: name, commit: base, repo: workspace.repository, repoRoot: workspace.repository, projectDir: ".", notedAt: new Date().toISOString() })}\n`,
  );
  const declared = await workspace.throneCliFromLiveRoot(["my-state", "reapable", "completed"], { THRONE_AGENT_NAME: name, HERDR_PANE_ID: paneId });
  const completed = await workspace.throneCliFromLiveRoot(["complete-agent", name]);
  await workspace.saveText("complete-agent.txt", `my-state exit ${declared.code}\n${declared.stdout}${declared.stderr}\ncomplete-agent exit ${completed.code}\n${completed.stdout}${completed.stderr}`);
  const paneList = async () => JSON.parse(await herdr.call("pane", "list")).result.panes;
  const paneClosed = (await pollUntil(paneList, (panes) => !panes.some((pane) => pane.pane_id === paneId), 15_000)).found;
  const worktreeGone = !existsSync(worktree);
  const archived = existsSync(path.join(workspace.dataHome, "data", ".reaped", name)) && !existsSync(path.join(workspace.dataHome, "data", name));
  const left = before.filter((entry) => existsSync(`/proc/${entry.pid}`));
  const observed =
    `pi processes before: ${before.length}; my-state reapable exit ${declared.code}; complete-agent exit ${completed.code}; ` +
    `pane closed: ${paneClosed}; worktree removed: ${worktreeGone}; ledger archived: ${archived}; pi processes left: ${left.length}`;
  const passed = before.length > 0 && declared.code === 0 && completed.code === 0 && paneClosed && worktreeGone && archived && left.length === 0;
  return { verdict: passed ? "PASS" : "FAIL", observed };
}

async function liveRow(workspace, name, label) {
  const statuses = await workspace.throneCliFromLiveRoot(["agent-statuses"]);
  await workspace.saveText(`agent-statuses-${label}.txt`, `exit ${statuses.code}\n${statuses.stdout}${statuses.stderr}`);
  return statuses.stdout.split("\n").find((line) => line.includes(name) && /\bLIVE\b/.test(line));
}

async function backendRestartKeepsTheAgentLiveAndDelivering(workspace) {
  const name = "shadow-pievidence-restart";
  const word = `MSG-${randomUUID().slice(0, 8)}`;
  const { herdr, paneId, result, standIn } = await workspace.launchPiAgent(name, "pi/flash", {
    plannedReply: async () => ({ text: `answered ${word}` }),
  });
  if (paneId === undefined) return { verdict: "FAIL", observed: `create-agent exit ${result.code}`, error: result.stderr.trim() };
  await herdr.waitForPi(paneId, "deepseek-flash");
  await pause(1500);
  const room = await court(workspace);
  const agent = await room.adoptLaunchedAgent(name, paneId, standIn);
  await room.startBackend();
  const liveBefore = await liveRow(workspace, name, "before-restart");
  await room.killBackend();
  await room.startBackend();
  const liveAfter = await liveRow(workspace, name, "after-restart");
  const id = room.send(agent, `please answer ${word}`);
  const finished = await room.waitForFinished(id, 60_000);
  const reachedPi = () => standIn.requests.some((body) => JSON.stringify(body.messages ?? []).includes(word));
  await herdr.waitForPaneText(paneId, reachedPi);
  const reached = reachedPi();
  await herdr.savePane(paneId, "pane-after-delivery.txt");
  await room.finish([{ ...agent, standIn: Object.assign(standIn, { turns: standIn.requests }) }]);
  const observed =
    `LIVE before the backend restart: ${liveBefore !== undefined}; LIVE after: ${liveAfter !== undefined} (${liveAfter?.trim() ?? "no row"}); ` +
    `message ${id} after the restart: ${finished?.state ?? "unfinished"}; reached pi as a turn: ${reached}`;
  const passed = liveBefore !== undefined && liveAfter !== undefined && finished?.state === "delivered" && reached;
  return { verdict: passed ? "PASS" : "FAIL", observed };
}

export const lines = [
  { id: "P6.1", needsPane: true, run: restartKeepsTheSession },
  { id: "P6.2", needsPane: true, run: completeAndReapAPiShadow },
  { id: "P6.3", needsPane: true, run: backendRestartKeepsTheAgentLiveAndDelivering },
];
