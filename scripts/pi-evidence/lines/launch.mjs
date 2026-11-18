import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PIY_PATH, STAND_IN_KEY, piProcessOfPane } from "../support.mjs";

const APPROVAL_PROMPT_PATTERN = /\b(approve|allow this|permission|trust this|\[y\/n\]|yes, allow)/i;
const TOOL_TASK = "please edit a file and run a command";
const COMMAND_SHOWN = "$ cat stand-in-edit.txt";
const TOOL_TASK_REQUESTS = 3;

export function toolTaskShown(paneText, requestCount) {
  return requestCount >= TOOL_TASK_REQUESTS && paneText.includes(COMMAND_SHOWN);
}

const ROLES_IN_TURN = ["regent", "stager", "alpha", "shadow"];

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function spawnFields(record) {
  if (record === null) return "no spawn.json";
  return `harness ${record.harness}, family ${record.model}, version ${record.pi_model_id}, account ${record.account}, session ${record.session_id}`;
}

async function launchedThroughCreateAgent(workspace, name, model) {
  const launched = await workspace.launchPiAgent(name, model);
  await workspace.saveText("spawn.json", `${JSON.stringify(launched.record, null, 2)}\n`);
  const expectedId = model === "pi/pro" ? "deepseek-v4-pro" : "deepseek-flash";
  const ready =
    launched.paneId === undefined
      ? { found: false, cause: `create-agent exit ${launched.result.code}: ${launched.result.stderr.trim()}` }
      : await launched.herdr.waitForPi(launched.paneId, expectedId);
  if (launched.paneId !== undefined) await launched.herdr.savePane(launched.paneId, "pane-after-start.txt");
  return { ...launched, ready, expectedId };
}

async function launchesAndEditsAFile(workspace) {
  const { standIn, herdr, paneId, record, ready, result } = await launchedThroughCreateAgent(workspace, "shadow-pievidence-flash", "pi/flash");
  if (!ready.found) {
    return { verdict: "FAIL", observed: `create-agent exit ${result.code}; ${spawnFields(record)}; pi never drew deepseek-flash`, error: ready.cause };
  }
  const processInfo = await herdr.processInfo(paneId);
  await workspace.saveText("process-info.json", `${JSON.stringify(processInfo, null, 2)}\n`);
  await herdr.typeAndSubmit(paneId, TOOL_TASK);
  const finished = await herdr.waitForPaneText(paneId, (text) => toolTaskShown(text, standIn.requests.length), 60_000);
  const paneText = await herdr.savePane(paneId, "pane-after-task.txt");
  const editedPath = path.join(workspace.repository, "stand-in-edit.txt");
  const edited = (await pathExists(editedPath)) ? await readFile(editedPath, "utf8") : "";
  const commandRan = standIn.requests.some((body) =>
    (body.messages ?? []).some((message) => message.role === "tool" && JSON.stringify(message.content).includes("written by the pi provider stand-in")),
  ) && paneText.includes(COMMAND_SHOWN);
  const approvalPrompt = APPROVAL_PROMPT_PATTERN.test(paneText);
  const piProcess = await piProcessOfPane(herdr, paneId);
  const viaPiy =
    piProcess !== null &&
    piProcess.environment.DEEPSEEK_API_KEY === STAND_IN_KEY &&
    piProcess.environment.THRONE_PI_KEY_FILE === undefined &&
    piProcess.environment.PI_CODING_AGENT_DIR?.endsWith("shadow-pievidence-flash/pi-agent") === true;
  const recorded =
    record?.harness === "pi" && record.model === "flash" && record.pi_model_id === "deepseek-flash" && record.account === "deepseek";
  const observed =
    `create-agent exit ${result.code}; spawn.json: ${spawnFields(record)}; ` +
    `file edited: ${edited !== ""}; command ran: ${commandRan}; approval prompt seen: ${approvalPrompt}; ` +
    `launched by piy (key read from the account into the environment, agent folder set): ${viaPiy}; provider requests: ${standIn.requests.length}`;
  const passed = result.code === 0 && finished.found && edited.includes("written by the pi provider stand-in") && commandRan && !approvalPrompt && viaPiy && recorded;
  return { verdict: passed ? "PASS" : "FAIL", observed };
}

function launchesOnFamily(name, model, family) {
  return async (workspace) => {
    const { record, ready, result, expectedId } = await launchedThroughCreateAgent(workspace, name, model);
    const passed = result.code === 0 && ready.found && record?.model === family && record.pi_model_id === expectedId;
    return {
      verdict: passed ? "PASS" : "FAIL",
      observed: `create-agent --model ${model} exit ${result.code}; spawn.json: ${spawnFields(record)}; pi drew ${expectedId}: ${ready.found}`,
      ...(ready.found ? {} : { error: ready.cause }),
    };
  };
}

async function refusesNonDeepseekModels(workspace) {
  const results = [];
  for (const model of ["pi/opus", "pi/gpt-5.6-sol"]) {
    const name = `shadow-pievidence-${model.replace(/[^a-z0-9]/g, "")}`;
    const result = await workspace.throneCli([
      "create-agent", "--model", model, "--role", "Shadow", "--name", name, "--supervisor", "alpha-pievidence-01", "--cwd", workspace.repository,
    ]);
    const ledgerWritten = await pathExists(path.join(workspace.dataHome, "data", name));
    await workspace.saveText(`create-agent-${model.replace("/", "-")}.txt`, `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
    results.push({ model, code: result.code, said: /only DeepSeek models run on pi/.test(result.stdout + result.stderr), ledgerWritten });
  }
  const herdr = await workspace.herdr();
  const panes = JSON.parse(await herdr.call("pane", "list")).result.panes;
  const allRefused = results.every((result) => result.code !== 0 && result.said && !result.ledgerWritten) && panes.length === 0;
  return {
    verdict: allRefused ? "PASS" : "FAIL",
    observed: results.map((result) =>
      `${result.model}: exit ${result.code}, message names DeepSeek-only: ${result.said}, ledger written: ${result.ledgerWritten}`,
    ).join("; ") + `; panes in the isolated session: ${panes.length}`,
  };
}

function presetConfig(baseConfigText, role, pair) {
  const harnessPair = `{ harness: '${pair.harness}', model: '${pair.model}' }`;
  const opus = "{ harness: 'claude', model: 'opus' }";
  const pool = (name) => (role === name ? harnessPair : opus);
  return baseConfigText
    .replace(
      "activePlanPresetName: 'OpusOnly',",
      `activePlanPresetName: 'Evidence',\n    customPlanPresets: { Evidence: { alpha: [${pool("alpha")}], shadow: [${pool("shadow")}], shadowSlice99: [${pool("shadow")}] } },\n    stagerPool: [${pool("stager")}],`,
    )
    .replace("regentRoute: { harness: 'claude', model: 'opus' }", `regentRoute: ${pool("regent")}`)
    .replace(/  ntfy: \{[^}]*\},\n/, "");
}

async function checkConfigAdmitsPiWhereClaudeIs(workspace) {
  const example = await readFile(path.join(path.dirname(PIY_PATH), "..", "config.user.example.ts"), "utf8");
  const outcomes = [];
  for (const pair of [{ harness: "pi", model: "flash" }, { harness: "claude", model: "opus" }]) {
    for (const role of ROLES_IN_TURN) {
      await workspace.writeUserConfig(presetConfig(example, role, pair));
      const result = await workspace.throneCli(["check-config"]);
      const label = `${role}-${pair.harness}-${pair.model}`;
      await workspace.saveText(`check-config-${label}.txt`, `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
      const roleLine = new RegExp(`^${role}: ${pair.harness}/${pair.model} `, "im");
      outcomes.push({ label, accepted: /loaded and validated/.test(result.stdout) && roleLine.test(result.stdout) });
    }
  }
  return {
    verdict: outcomes.every((outcome) => outcome.accepted) ? "PASS" : "FAIL",
    observed: outcomes.map((outcome) => `${outcome.label}: ${outcome.accepted ? "accepted" : "refused"}`).join("; "),
  };
}

async function listShowsPiSection(workspace) {
  const example = await readFile(path.join(path.dirname(PIY_PATH), "..", "config.user.example.ts"), "utf8");
  await workspace.writeUserConfig(example);
  const result = await workspace.throneCli(["list-harnesses-and-models"]);
  await workspace.saveText("list-harnesses-and-models.txt", `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
  const section = /^pi:\n((?:  .*\n)*)/m.exec(result.stdout);
  const models = section === null ? [] : section[1].trim().split("\n").map((row) => row.trim().split(/\s+/)[0]);
  const exact = models.length === 2 && models[0] === "flash" && models[1] === "pro";
  return {
    verdict: result.code === 0 && exact ? "PASS" : "FAIL",
    observed: section === null ? "no pi section printed" : `pi section rows: ${section[1].trim().replace(/\n\s*/g, " | ")}`,
  };
}

export const lines = [
  { id: "P1.1", needsPane: true, run: launchesAndEditsAFile },
  { id: "P1.2", needsPane: true, run: launchesOnFamily("shadow-pievidence-bare", "pi", "flash") },
  { id: "P1.3", needsPane: true, run: launchesOnFamily("shadow-pievidence-pro", "pi/pro", "pro") },
  { id: "P1.4", run: refusesNonDeepseekModels },
  { id: "P1.5", run: checkConfigAdmitsPiWhereClaudeIs },
  { id: "P1.6", run: listShowsPiSection },
];
