import path from "node:path";
import { PIY_PATH, STAND_IN_KEY, deepseekKeyForRealProvider, piEntryPath, pollUntil, piProcessOfPane, runCommand, shellQuote } from "../support.mjs";
import { STAND_IN_FINAL_ANSWER } from "../../../test/support/pi-provider-stand-in/pi-provider-stand-in.mjs";
import { resolvePiModel, writePiAgentDirectory } from "../../../src/pi-models/pi-models.ts";

const VERSIONED_LIST = ["deepseek-v4-flash", "deepseek-v5-flash", "deepseek-v4-pro"].map((id) => ({ id, object: "model", owned_by: "deepseek" }));
const ONE_LINE_PROMPT = "Reply with exactly one word: ready";

function cacheDirectory(workspace) {
  return path.join(workspace.dataHome, "cache");
}

async function saveResolved(workspace, name, resolved) {
  await workspace.saveText(name, `${JSON.stringify(resolved, null, 2)}\n`);
}

async function launchThroughCreateAgent(workspace, name, standIn, model = "pi/flash") {
  await workspace.addDeepseekAccount();
  const result = await workspace.createPiAgent(name, model, standIn.baseUrl);
  const record = await workspace.spawnRecord(name);
  await workspace.saveText(`spawn-${name}.json`, `${JSON.stringify(record, null, 2)}\n`);
  const herdr = await workspace.herdr();
  const paneId = JSON.parse(await herdr.call("pane", "list")).result.panes.filter((pane) => pane.agent === "pi").at(-1)?.pane_id;
  const ready =
    paneId === undefined || record?.pi_model_id === undefined
      ? { found: false, cause: `create-agent exit ${result.code}: ${result.stderr.trim()}` }
      : await herdr.waitForPi(paneId, record.pi_model_id);
  if (paneId !== undefined) await herdr.savePane(paneId, `pane-${name}.txt`);
  return { result, record, herdr, paneId, ready };
}

function launchOutput(launch) {
  return launch.result.stdout.split("\n").find((line) => line.startsWith("create-agent: ")) ?? "";
}

async function flashAndProResolveToTheNewest(workspace) {
  const standIn = await workspace.standIn({ models: VERSIONED_LIST });
  const pro = await resolvePiModel({ family: "pro", key: STAND_IN_KEY, cacheDirectory: path.join(workspace.scratch, "pro-cache"), baseUrl: standIn.baseUrl });
  const flash = await launchThroughCreateAgent(workspace, "shadow-pievidence-newest", standIn);
  await saveResolved(workspace, "resolved.json", { flash: flash.record, pro });
  const passed = flash.record?.pi_model_id === "deepseek-v5-flash" && pro.id === "deepseek-v4-pro" && flash.ready.found;
  return {
    verdict: passed ? "PASS" : "FAIL",
    observed: `list ${VERSIONED_LIST.map((model) => model.id).join(", ")}: create-agent pi/flash recorded ${flash.record?.pi_model_id} and pi drew it: ${flash.ready.found}; pro -> ${pro.id}`,
    ...(flash.ready.found ? {} : { error: flash.ready.cause }),
  };
}

async function unreachableListUsesTheCache(workspace) {
  const standIn = await workspace.standIn({ models: VERSIONED_LIST });
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await resolvePiModel({ family: "flash", key: STAND_IN_KEY, cacheDirectory: cacheDirectory(workspace), baseUrl: standIn.baseUrl, now: twoDaysAgo });
  standIn.setModelListAvailable(false);
  const launch = await launchThroughCreateAgent(workspace, "shadow-pievidence-cached", standIn);
  const said = launchOutput(launch);
  const passed = launch.result.code === 0 && launch.record?.pi_model_id === "deepseek-v5-flash" && /could not be reached/.test(said) && said.includes("deepseek-v5-flash") && launch.ready.found;
  return {
    verdict: passed ? "PASS" : "FAIL",
    observed: `create-agent exit ${launch.result.code}, launch output "${said}"; recorded ${launch.record?.pi_model_id}; pi drew it: ${launch.ready.found}`,
  };
}

async function unreachableListWithNoCacheUsesThePin(workspace) {
  const standIn = await workspace.standIn({ models: VERSIONED_LIST });
  standIn.setModelListAvailable(false);
  const launch = await launchThroughCreateAgent(workspace, "shadow-pievidence-pinned", standIn);
  const said = launchOutput(launch);
  const passed = launch.result.code === 0 && launch.record?.pi_model_id === "deepseek-flash" && /nothing is cached; using the registry's pinned deepseek-flash/.test(said) && launch.ready.found;
  return {
    verdict: passed ? "PASS" : "FAIL",
    observed: `create-agent exit ${launch.result.code}, launch output "${said}"; recorded ${launch.record?.pi_model_id}; pi drew it: ${launch.ready.found}`,
  };
}

async function resumeKeepsTheLaunchedVersion(workspace) {
  const name = "shadow-pievidence-resume";
  const standIn = await workspace.standIn({ models: [{ id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" }] });
  const first = await launchThroughCreateAgent(workspace, name, standIn);
  standIn.setModels(VERSIONED_LIST);
  if (first.paneId !== undefined) {
    await first.herdr.typeAndSubmit(first.paneId, "hello");
    await first.herdr.waitForPaneText(first.paneId, (text) => standIn.requests.length > 0 && text.includes(STAND_IN_FINAL_ANSWER));
    const piProcess = await piProcessOfPane(first.herdr, first.paneId);
    if (piProcess !== null) await runCommand("kill", ["-9", String(piProcess.pid)]);
    await pollUntil(() => piProcessOfPane(first.herdr, first.paneId), (found) => found === null, 15_000);
  }
  const options = await workspace.courtResumeOptions(name, standIn.baseUrl);
  const herdr = await workspace.herdr();
  const paneId = first.paneId;
  if (options !== null && paneId !== undefined) await workspace.runCourtResume(paneId, options);
  const piProcess = options === null || paneId === undefined ? null : await waitForPiProcess(herdr, paneId);
  if (paneId !== undefined) await herdr.savePane(paneId, "pane-after-resume.txt");
  const resumedOn = piProcess === null ? undefined : /--model (\S+)/.exec(piProcess.cmdline)?.[1];
  const record = await workspace.spawnRecord(name);
  await workspace.saveText("resumed.json", `${JSON.stringify({ resumedOn, record }, null, 2)}\n`);
  const passed = first.record?.pi_model_id === "deepseek-v4-flash" && options !== null && resumedOn === "deepseek-v4-flash" && record?.pi_model_id === "deepseek-v4-flash";
  return {
    verdict: passed ? "PASS" : "FAIL",
    observed: `launched on ${first.record?.pi_model_id}; list changed to hold deepseek-v5-flash; pi killed; the court's resume (resumeOrphan) argv ${options?.argv.slice(1).join(" ")}; resumed pi runs --model ${resumedOn}; spawn.json still ${record?.pi_model_id}`,
  };
}

async function waitForPiProcess(herdr, paneId) {
  return (await pollUntil(() => piProcessOfPane(herdr, paneId), (found) => found !== null, 20_000, 500)).value;
}

async function realProviderAnswersOnFlashAndPro(workspace) {
  const key = await deepseekKeyForRealProvider();
  const outcomes = [];
  for (const family of ["flash", "pro"]) {
    const resolved = await resolvePiModel({ family, key, cacheDirectory: cacheDirectory(workspace) });
    const agentDirectory = path.join(workspace.ledger, `pi-agent-${family}`);
    await writePiAgentDirectory({ agentDirectory, modelId: resolved.id });
    const printCommand = [PIY_PATH, "--provider", "deepseek", "--model", resolved.id, "--no-session", "-p", ONE_LINE_PROMPT].map(shellQuote).join(" ");
    const result = await runCommand("bash", ["-c", `${printCommand} </dev/null`], {
      cwd: workspace.repository,
      timeout: 120_000,
      env: { ...process.env, DEEPSEEK_API_KEY: key, PI_CODING_AGENT_DIR: agentDirectory, PI_BIN: piEntryPath() },
    });
    const answer = result.stdout.replaceAll(key, "<key>").trim();
    await workspace.saveText(`answer-${family}.txt`, `exit ${result.code}\nmodel ${resolved.id}\n${answer}\n${result.stderr.replaceAll(key, "<key>")}`);
    outcomes.push({ family, resolved, code: result.code, answer });
  }
  const passed = outcomes.every((outcome) => outcome.resolved.source !== "pinned" && outcome.code === 0 && /\bready\b/i.test(outcome.answer));
  return {
    verdict: passed ? "PASS" : "FAIL",
    observed: outcomes.map((outcome) => `${outcome.family} -> ${outcome.resolved.id} (${outcome.resolved.source}${outcome.resolved.displayName === null ? "" : `, ${outcome.resolved.displayName}`}), exit ${outcome.code}, answered "${outcome.answer.slice(0, 80)}"`).join("; "),
  };
}

export const lines = [
  { id: "P2.1", needsPane: true, run: flashAndProResolveToTheNewest },
  { id: "P2.2", needsPane: true, run: unreachableListUsesTheCache },
  { id: "P2.3", needsPane: true, run: unreachableListWithNoCacheUsesThePin },
  { id: "P2.4", needsPane: true, run: resumeKeepsTheLaunchedVersion },
  { id: "P2.5", realProvider: true, run: realProviderAnswersOnFlashAndPro },
];
