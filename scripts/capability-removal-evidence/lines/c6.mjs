import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLineWorkspace as createCourtWorkspace, pollUntil, runCommand } from "../../pi-evidence/support.mjs";
import { THRONE_ROOT } from "../support.mjs";
import { openMessageQueueStore } from "../../../src/message-queue/message-queue.store.ts";
import { enqueueMessageDelivery } from "../../../src/send-agent/message-delivery-enqueue.ts";

const SUPERVISOR = "alpha-capsgoneproof-01";
const SIGN_IN_SCREEN = /sign in with chatgpt|log in with chatgpt|welcome to codex/i;
const LAUNCH_SECONDS = 120;
const ANSWER_SECONDS = 180;
const SHADOW_PAIRS = "{ harness: 'claude', model: 'opus' }, { harness: 'codex', model: 'gpt-5.6-sol' }";

async function admitClaudeAndCodex(workspace) {
  const example = await readFile(path.join(THRONE_ROOT, "config.user.example.ts"), "utf8");
  await workspace.writeUserConfig(
    example
      .replace(
        "activePlanPresetName: 'OpusOnly',",
        `activePlanPresetName: 'Evidence',\n    customPlanPresets: { Evidence: { alpha: [${SHADOW_PAIRS}], shadow: [${SHADOW_PAIRS}], shadowSlice99: [${SHADOW_PAIRS}] } },`,
      )
      .replace(/  ntfy: \{[^}]*\},\n/, ""),
  );
  const supervisor = path.join(workspace.dataHome, "data", SUPERVISOR);
  await mkdir(supervisor, { recursive: true });
  await writeFile(
    path.join(supervisor, "spawn.json"),
    `${JSON.stringify({ harness: "claude", model: "opus", effort: 3, cwd: workspace.repository, objective_code: "capsgoneproof" })}\n`,
  );
}

function startDeliveryBackend(workspace, sessionName) {
  const settings = {
    databasePath: path.join(workspace.dataHome, "message-queue.sqlite3"),
    sessionName,
    refusalLog: path.join(workspace.lineDirectory, "herdr-refusals.log"),
    waitMilliseconds: 60_000,
    typing: true,
  };
  const backend = spawn(process.execPath, [path.join(THRONE_ROOT, "scripts", "pi-evidence", "delivery-backend.mjs"), JSON.stringify(settings)], {
    env: workspace.throneEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  backend.stdout.on("data", (part) => (output += part));
  backend.stderr.on("data", (part) => (output += part));
  return { stop: () => backend.kill("SIGKILL"), output: () => output };
}

async function launchAndMessage(workspace, harness, model) {
  const name = `shadow-capsgoneproof-${harness}`;
  const herdr = await workspace.herdr();
  await herdr.call("workspace", "create", "--cwd", workspace.repository, "--no-focus");
  const launched = await workspace.throneCliFromLiveRoot([
    "create-agent", "--model", model, "--role", "Shadow", "--name", name, "--supervisor", SUPERVISOR, "--non-campaign", "--cwd", workspace.repository,
  ]);
  await workspace.saveText(`create-agent-${harness}.txt`, `exit ${launched.code}\n${launched.stdout}\n${launched.stderr}`);
  if (launched.code !== 0) return { harness, verdict: "FAIL", observed: `create-agent --model ${model} exit ${launched.code}: ${launched.stderr.trim().split("\n").at(-1)}` };
  const pane = await pollUntil(
    async () => JSON.parse(await herdr.call("pane", "list")).result.panes.find((candidate) => candidate.agent === harness),
    Boolean,
    LAUNCH_SECONDS * 1000,
    1000,
  );
  if (!pane.found) return { harness, verdict: "FAIL", observed: `create-agent exit 0 but herdr never showed a ${harness} agent pane` };
  const paneId = pane.value.pane_id;
  const firstScreen = await herdr.savePane(paneId, `pane-${harness}-after-launch.txt`);
  if (SIGN_IN_SCREEN.test(firstScreen)) {
    return { harness, verdict: "NOT VERIFIED", observed: `create-agent exit 0 and ${harness} launched in pane ${paneId}, but it stops on its sign-in screen: this host has no ${harness} sign-in, so no message can be answered` };
  }
  const word = `CAPSGONE-${randomUUID().slice(0, 8)}`;
  const store = openMessageQueueStore(path.join(workspace.dataHome, "message-queue.sqlite3"));
  const id = enqueueMessageDelivery(store, {
    recipientName: name,
    recipientPaneId: paneId,
    senderName: "capability-removal-evidence",
    prompt: `Reply with the single word ${word} reversed letter by letter, and nothing else. Do not run any tool.`,
    clearRecipientBlockedOnDelivery: false,
  }).id;
  const reversed = [...word].reverse().join("");
  const answered = await pollUntil(() => herdr.readPane(paneId), (text) => text.includes(reversed), ANSWER_SECONDS * 1000, 2000);
  const row = store.readWorkItem(id);
  store.close?.();
  await herdr.savePane(paneId, `pane-${harness}-after-message.txt`);
  const passed = row?.state === "delivered" && answered.found;
  return {
    harness,
    verdict: passed ? "PASS" : "FAIL",
    observed: `${harness} (${model}): create-agent exit 0; message ${id} queue state ${row?.state}; answer ${reversed} on screen: ${answered.found}`,
  };
}

async function piLaunchesAndAnswers(workspace, lineDirectory) {
  const result = await runCommand(process.execPath, [path.join(THRONE_ROOT, "scripts", "pi-evidence", "run.mjs"), "--line", "P1.2", "--line", "P4.1", "--out", path.join(lineDirectory, "pi-evidence")], {
    cwd: THRONE_ROOT,
    timeout: 600_000,
  });
  await workspace.saveText("pi-evidence.txt", `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
  const verdicts = result.stdout.split("\n").filter((row) => /^P\d/.test(row)).map((row) => row.split("\t"));
  const passed = result.code === 0 && verdicts.length === 2 && verdicts.every((row) => row[1] === "PASS");
  return { harness: "pi", verdict: passed ? "PASS" : "FAIL", observed: `pi: ${verdicts.map((row) => `${row[0]} ${row[1]}`).join(", ") || `pi-evidence exit ${result.code}`}` };
}

async function fullSuite(workspace) {
  const result = await runCommand("bun", ["run", "test"], { cwd: THRONE_ROOT, timeout: 3_600_000 });
  await workspace.saveText("full-suite.txt", `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
  const summary = `${result.stdout}\n${result.stderr}`.match(/^\s*\d+ pass\s*$/m)?.[0].trim() ?? "no pass count printed";
  return { harness: "suite", verdict: result.code === 0 ? "PASS" : "FAIL", observed: `bun run test exit ${result.code} (${summary})` };
}

async function courtStillWorks(lineWorkspace) {
  const lineDirectory = path.dirname(await lineWorkspace.saveText("started.txt", `${new Date().toISOString()}\n`));
  const workspace = await createCourtWorkspace(lineDirectory);
  const results = [];
  try {
    await admitClaudeAndCodex(workspace);
    const herdr = await workspace.herdr();
    const backend = startDeliveryBackend(workspace, herdr.sessionName);
    try {
      results.push(await launchAndMessage(workspace, "claude", "opus"));
      results.push(await launchAndMessage(workspace, "codex", "gpt-5.6-sol"));
    } finally {
      await workspace.saveText("delivery-backend-output.txt", backend.output());
      backend.stop();
    }
  } finally {
    await workspace.close();
  }
  results.push(await piLaunchesAndAnswers(lineWorkspace, lineDirectory));
  results.push(await fullSuite(lineWorkspace));
  const verdict = results.some((result) => result.verdict === "FAIL") ? "FAIL" : results.some((result) => result.verdict === "NOT VERIFIED") ? "NOT VERIFIED" : "PASS";
  return { verdict, observed: results.map((result) => `[${result.verdict}] ${result.observed}`).join("; ") };
}

export const lines = [{ id: "C6.1", run: courtStillWorks }];
