import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { THRONE_CLI_PATH, THRONE_ROOT } from "../support.mjs";
import { piEntryPath, pollUntil, runCommand } from "../../pi-evidence/support.mjs";
import { closeRealCourt, killPiIn, lastMessageIsAToolResult, openRealCourt, piProcessesIn } from "./real-court.mjs";

const OLD_DATA_HOME = path.join(THRONE_ROOT, "test", "fixtures", "capability-removal-evidence", "data-home");
const RECONCILIATION_PROBE = path.join(THRONE_ROOT, "scripts", "capability-removal-evidence", "spawn-record-court.ts");
const READY_TEXT = "deepseek-flash";
const COMMAND_MARKER = /RUN<<([A-Za-z0-9+/=]+)>>/;
const CAPABILITY_WORD = /capabilit/i;
const NOTICE_WORDS = "capability requirements were removed";
const OLD_REQUIRES = "non-coding>=4";
const REPORT_WORDS = "delivered";
const VERDICT_LINE = "- H PASS: the slice carries its line";
const FLOW_FILES = ["scripts/capability-removal-evidence/lines/h.mjs", "scripts/capability-removal-evidence/lines/real-court.mjs", "scripts/capability-removal-evidence/spawn-record-court.ts", "src/create-agent/request.ts", "src/complete-agent/complete-agent.ts"];
const PI_ENVIRONMENT = { PI_BIN: piEntryPath(), PI_OFFLINE: "1" };

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.filter((message) => message.role === "user").at(-1);
  return user === undefined ? "" : JSON.stringify(user.content ?? "");
}

function runsTheTypedCommand(body) {
  const asked = lastUserText(body).match(COMMAND_MARKER);
  if (asked === null || lastMessageIsAToolResult(body)) return { text: "done" };
  const command = Buffer.from(asked[1], "base64").toString("utf8");
  return { toolCalls: [{ id: `run-${createHash("sha256").update(command).digest("hex").slice(0, 8)}`, name: "bash", arguments: JSON.stringify({ command }) }] };
}

function commandTask(command) {
  return `RUN<<${Buffer.from(command).toString("base64")}>>`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function openFlowCourt(workspace, configText) {
  const court = await openRealCourt(workspace);
  const standIn = await court.standIn({ plannedReply: runsTheTypedCommand });
  const herdr = await court.herdr();
  await herdr.call("workspace", "create", "--cwd", court.repository, "--no-focus");
  await court.addDeepseekAccount();
  if (configText === undefined) await court.writePiAdmittingConfig();
  else await court.writeUserConfig(configText);
  const outputs = [];
  const flow = {
    court,
    standIn,
    herdr,
    outputs,
    async throne(argumentsList) {
      const result = await court.throneCliFromLiveRoot(argumentsList, { ...PI_ENVIRONMENT, THRONE_PI_PROVIDER_BASE_URL: standIn.baseUrl });
      outputs.push({ command: argumentsList.join(" "), ...result });
      await workspace.saveText(`step-${String(outputs.length).padStart(2, "0")}.txt`, `$ throne ${argumentsList.join(" ")}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);
      return result;
    },
    async piPanes() {
      return JSON.parse(await herdr.call("pane", "list")).result.panes.filter((pane) => pane.agent === "pi").map((pane) => pane.pane_id);
    },
    async launch(name, role, supervisor, extra = [], modelArguments = ["--model", "pi/flash"]) {
      const before = new Set(await flow.piPanes());
      const created = await flow.throne(["create-agent", ...modelArguments, "--role", role, "--name", name, "--supervisor", supervisor, "--non-campaign", "--cwd", court.repository, ...extra]);
      const paneId = (await flow.piPanes()).find((id) => !before.has(id));
      const ready = paneId === undefined ? { found: false, cause: "no new pi pane" } : await herdr.waitForPi(paneId, READY_TEXT);
      if (created.code !== 0 || !ready.found) throw new Error(`${name} did not start: create-agent exit ${created.code}: ${ready.cause ?? ""} ${created.stderr}`);
      return { name, paneId, created };
    },
    async runIn(agent, command, done) {
      const requestsBefore = standIn.requests.length;
      const script = path.join(court.scratch, `step-${standIn.requests.length}-${createHash("sha256").update(command).digest("hex").slice(0, 8)}.sh`);
      await writeFile(script, `${command}\n`);
      await herdr.typeAndSubmit(agent.paneId, commandTask(`bash ${script}`));
      const finished = await pollUntil(done, Boolean, 60_000, 500);
      if (!finished.found) throw new Error(`${agent.name} never finished "${command}" (${standIn.requests.length - requestsBefore} provider requests)`);
    },
    agentFolder(name) {
      return path.join(court.dataHome, "data", name);
    },
    async deliverReport(agent) {
      const report = path.join(flow.agentFolder(agent.name), "REPORT.md");
      const state = path.join(flow.agentFolder(agent.name), "state.json");
      await flow.runIn(agent, `printf '%s\\n' '# ${agent.name} ${REPORT_WORDS}' > ${shellQuote(report)} && ${shellQuote(THRONE_CLI_PATH)} my-state reapable completed --agent ${agent.name}`, () => readFile(state, "utf8").then((text) => text.includes("reapable"), () => false));
    },
    async restartBackend() {
      const result = await runCommand(process.execPath, [RECONCILIATION_PROBE], { env: court.throneEnvironment(), cwd: THRONE_ROOT });
      await workspace.saveText("backend-restart.json", `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
      if (result.code !== 0) throw new Error(`the backend's start-up reconciliation exited ${result.code}: ${result.stderr}`);
      return JSON.parse(result.stdout).reconciliation;
    },
  };
  return flow;
}

function reconciliationProblems(reconciliation, expectedActions) {
  const problems = [];
  const failed = reconciliation.outcomes.filter((outcome) => !outcome.ok);
  if (failed.length > 0 || reconciliation.warnings.length > 0) problems.push(`restart reported errors: ${JSON.stringify({ failed, warnings: reconciliation.warnings })}`);
  if (expectedActions !== undefined && JSON.stringify([...reconciliation.actions].sort()) !== JSON.stringify([...expectedActions].sort())) problems.push(`restart chose ${JSON.stringify(reconciliation.actions)}, expected ${JSON.stringify(expectedActions)}`);
  return problems;
}

async function filesUnder(folder) {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

async function fingerprints(folder) {
  const files = (await filesUnder(folder)).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [path.relative(folder, file), createHash("sha256").update(await readFile(file)).digest("hex")])));
}

async function capabilityMentions(dataHome) {
  const found = [];
  for (const file of await filesUnder(path.join(dataHome, "data"))) {
    if (!file.endsWith(".json") && !file.endsWith(".md")) continue;
    const text = await readFile(file, "utf8").catch(() => "");
    if (CAPABILITY_WORD.test(text)) found.push(path.relative(dataHome, file));
  }
  return found;
}

function gateFileText(requiresLine) {
  return ["---", "deps: [01, 02]", "gate: critique", "max_rounds: 1", ...(requiresLine ? [`requires: ${OLD_REQUIRES}`] : []), "---", "", "# 03z — Critique slices 01 and 02", "", "## Execution log", ""].join("\n");
}

function sliceText(id) {
  return ["---", "deps: []", "---", "", `# ${id} — Write line ${id}`, "", "## Execution log", ""].join("\n");
}

async function wholeCampaign(workspace, oldWay) {
  const flow = await openFlowCourt(workspace);
  const code = oldWay ? "hflowold" : "hflow";
  const alphaName = `alpha-${code}-01`;
  const problems = [];
  try {
    const alpha = await flow.launch(alphaName, "Alpha", "Regent");
    const bundle = path.join(flow.agentFolder(alphaName), "todo-2026-11-15-1200-small-campaign");
    const gatePath = path.join(bundle, "03z_critique.md");
    const writeBundle = [`mkdir -p ${shellQuote(bundle)}`, ...["01", "02"].map((id) => `printf '%s' ${shellQuote(sliceText(id))} > ${shellQuote(path.join(bundle, `${id}_line.md`))}`), `printf '%s' ${shellQuote(gateFileText(oldWay))} > ${shellQuote(gatePath)}`].join(" && ");
    await flow.runIn(alpha, writeBundle, () => readFile(gatePath, "utf8").then(Boolean, () => false));
    const shadows = [];
    for (const id of ["01", "02"]) shadows.push(await flow.launch(`shadow-${code}-${id}-line`, "Shadow", alphaName));
    const gate = await readFile(gatePath, "utf8");
    const requiresValue = gate.match(/^requires: (.+)$/m)?.[1];
    const critic = await flow.launch(`shadow-${code}-03z-critique`, "Shadow", alphaName, requiresValue === undefined ? [] : ["--requires", requiresValue]);
    const notices = critic.created.stdout.split(NOTICE_WORDS).length - 1;
    if (oldWay && notices !== 1) problems.push(`the critic's create-agent printed the --requires notice ${notices} times`);
    for (const shadow of shadows) await flow.deliverReport(shadow);
    await flow.runIn(critic, `printf '%s\\n' ${shellQuote(VERDICT_LINE)} >> ${shellQuote(gatePath)}`, () => readFile(gatePath, "utf8").then((text) => text.includes(VERDICT_LINE)));
    await workspace.saveText("gate-file-after.md", await readFile(gatePath, "utf8"));
    await flow.deliverReport(critic);
    await flow.deliverReport(alpha);
    const everyone = [...shadows, critic, alpha];
    const listed = await flow.throne(["agent-statuses"]);
    const unlisted = everyone.filter((agent) => !listed.stdout.includes(agent.name)).map((agent) => agent.name);
    if (unlisted.length > 0) problems.push(`agent-statuses did not list ${unlisted.join(", ")}`);
    for (const agent of everyone) {
      const reaped = await flow.throne(["complete-agent", agent.name]);
      if (reaped.code !== 0) problems.push(`complete-agent ${agent.name} exit ${reaped.code}: ${reaped.stderr.trim().split("\n").at(-1)}`);
    }
    const panesLeft = await flow.piPanes();
    if (panesLeft.length > 0) problems.push(`${panesLeft.length} pi panes are left after the reaps`);
    problems.push(...reconciliationProblems(await flow.restartBackend(), []));
    const recheck = await flow.throne(["agent-statuses"]);
    const stillLive = everyone.filter((agent) => recheck.stdout.split("\n").some((row) => row.includes(agent.name) && /\bLIVE\b/.test(row))).map((agent) => agent.name);
    if (recheck.code !== 0 || stillLive.length > 0) problems.push(`re-check after the restart: agent-statuses exit ${recheck.code}, still live ${stillLive.join(", ") || "none"}`);
    const mentioned = flow.outputs.flatMap((step) => `${step.stdout}\n${step.stderr}`.split("\n").filter((row) => CAPABILITY_WORD.test(row) && !(oldWay && row.includes(NOTICE_WORDS))).map((row) => `${step.command}: ${row.trim()}`));
    if (mentioned.length > 0) problems.push(`a step names a capability: ${mentioned.join(" | ")}`);
    const recorded = await capabilityMentions(flow.court.dataHome);
    if (recorded.length > 0) problems.push(`a record mentions a capability: ${recorded.join(", ")}`);
    return problems.length > 0
      ? { verdict: "FAIL", observed: problems.join("; ") }
      : { verdict: "PASS", observed: `${oldWay ? `the gate file says requires: ${OLD_REQUIRES} and the critic was created with --requires and one notice line; ` : ""}an Alpha wrote a two-slice bundle with one critic gate, two Shadows and a critic were created, the critic graded, everyone delivered and was reaped by complete-agent, and after the backend restart nothing was resumed or live; no step named, checked or recorded a capability${oldWay ? " beyond the notice" : ""}` };
  } finally {
    await closeRealCourt(flow.court);
  }
}

async function olderAgentsUnderTheNewBuild(workspace) {
  const flow = await openFlowCourt(workspace);
  const problems = [];
  try {
    await cp(path.join(OLD_DATA_HOME, "data"), path.join(flow.court.dataHome, "data"), { recursive: true });
    const oldNames = await readdir(path.join(OLD_DATA_HOME, "data"));
    await Promise.all(oldNames.map((name) => writeFile(path.join(flow.agentFolder(name), "identity.md"), `# ${name}\n`)));
    const completedName = "shadow-oldgrades-01-core";
    const untouched = oldNames.filter((name) => name !== completedName);
    const before = Object.fromEntries(await Promise.all(untouched.map(async (name) => [name, await fingerprints(flow.agentFolder(name))])));
    const { capability } = JSON.parse(await readFile(path.join(OLD_DATA_HOME, "data", "shadow-oldgrades-01z-critique", "spawn.json"), "utf8"));
    const restartedName = "shadow-oldgrades-01-resumed";
    const restarted = await flow.launch(restartedName, "Shadow", "alpha-oldgrades-01");
    await flow.runIn(restarted, "echo remember kiwi", () => flow.standIn.requests.some((body) => lastMessageIsAToolResult(body)));
    const spawnPath = path.join(flow.agentFolder(restartedName), "spawn.json");
    await writeFile(spawnPath, `${JSON.stringify({ ...JSON.parse(await readFile(spawnPath, "utf8")), capability }, null, 2)}\n`);
    const started = await flow.restartBackend();
    problems.push(...reconciliationProblems(started).map((problem) => `start-up: ${problem}`));
    const listed = await flow.throne(["agent-statuses"]);
    const unlisted = [...oldNames, restartedName].filter((name) => !listed.stdout.includes(name));
    if (listed.code !== 0 || unlisted.length > 0) problems.push(`agent-statuses exit ${listed.code} did not list ${unlisted.join(", ") || "nothing missing"}`);
    const killed = await killPiIn(flow.herdr, restarted.paneId);
    if (killed.killed === 0 || killed.left !== 0) problems.push(`kill left ${killed.left} of ${killed.killed} pi processes`);
    const options = await flow.court.courtResumeOptions(restartedName, flow.standIn.baseUrl);
    if (options === null) problems.push("the court's resume launched nothing for the restarted agent");
    else {
      await flow.court.runCourtResume(restarted.paneId, options);
      const back = await flow.herdr.waitForPaneText(restarted.paneId, (text) => text.includes(READY_TEXT) && text.includes("RUN<<"));
      const requestsBefore = flow.standIn.requests.length;
      await flow.herdr.typeAndSubmit(restarted.paneId, "which word did I ask you to remember");
      const answered = await pollUntil(() => flow.standIn.requests.slice(requestsBefore), (bodies) => bodies.some((body) => JSON.stringify(body).includes("remember kiwi")), 30_000, 500);
      const running = (await piProcessesIn(flow.herdr, restarted.paneId)).length > 0;
      await workspace.saveText("H3-pane-after-resume.txt", await flow.herdr.readPane(restarted.paneId));
      if (!back.found || !answered.found || !running) problems.push(`resume: earlier conversation shown ${back.found}, history sent ${answered.found}, pi running ${running}`);
    }
    await writeFile(path.join(flow.agentFolder(completedName), "REPORT.md"), `# ${completedName} ${REPORT_WORDS}\n`);
    const reaped = await flow.throne(["complete-agent", completedName]);
    if (reaped.code !== 0) problems.push(`complete-agent ${completedName} exit ${reaped.code}: ${reaped.stderr.trim().split("\n").at(-1)}`);
    const restartedAgain = await flow.restartBackend();
    problems.push(...reconciliationProblems(restartedAgain).map((problem) => `after the reap: ${problem}`));
    const recheck = await flow.throne(["agent-statuses"]);
    const missing = [...untouched, restartedName].filter((name) => !recheck.stdout.includes(name));
    if (recheck.code !== 0 || missing.length > 0) problems.push(`re-check after the restart: agent-statuses exit ${recheck.code}, missing ${missing.join(", ") || "none"}`);
    const after = Object.fromEntries(await Promise.all(untouched.map(async (name) => [name, await fingerprints(flow.agentFolder(name))])));
    await workspace.saveText("H3-untouched-files.json", `${JSON.stringify({ before, after }, null, 2)}\n`);
    const changed = untouched.filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
    if (changed.length > 0) problems.push(`files changed for untouched agents ${changed.join(", ")}`);
    return problems.length > 0
      ? { verdict: "FAIL", observed: problems.join("; ") }
      : { verdict: "PASS", observed: `${oldNames.length} agents recorded before the removal plus a pi agent whose spawn.json carries the old capability field started under the new build with no error; agent-statuses listed every one; the pi agent was killed and resumed with its conversation; ${completedName} was completed and reaped; after a second restart the untouched agents ${untouched.join(", ")} kept byte-identical files` };
  } finally {
    await closeRealCourt(flow.court);
  }
}

async function oneModelShadowPool(workspace) {
  const example = await readFile(path.join(THRONE_ROOT, "config.user.example.ts"), "utf8");
  const pool = "{ harness: 'pi', model: 'flash' }";
  const wide = "{ harness: 'pi', model: 'flash' }, { harness: 'pi', model: 'pro' }, { harness: 'claude', model: 'opus' }";
  const config = example
    .replace("activePlanPresetName: 'OpusOnly',", `activePlanPresetName: 'Evidence',\n    customPlanPresets: { Evidence: { alpha: [${wide}], shadow: [${pool}], shadowSlice99: [${wide}] } },`)
    .replace(/  ntfy: \{[^}]*\},\n/, "");
  const flow = await openFlowCourt(workspace, config);
  const problems = [];
  try {
    const supervisor = flow.agentFolder("alpha-hpool-01");
    await mkdir(supervisor, { recursive: true });
    await writeFile(path.join(supervisor, "spawn.json"), `${JSON.stringify({ harness: "pi", model: "flash", effort: 3, cwd: flow.court.repository, objective_code: "hpool" })}\n`);
    const refusedName = "shadow-hpool-01-other";
    const refused = await flow.throne(["create-agent", "--model", "pi/pro", "--role", "Shadow", "--name", refusedName, "--supervisor", "alpha-hpool-01", "--non-campaign", "--cwd", flow.court.repository]);
    const refusal = `${refused.stdout}\n${refused.stderr}`.split("\n").find((row) => /pool/i.test(row)) ?? "";
    if (refused.code === 0) problems.push("a Shadow on pi/pro was launched though the Shadow pool holds only pi/flash");
    if (refusal === "") problems.push(`the refusal does not give the pool's message: ${refused.stderr.trim()}`);
    if ((await flow.piPanes()).length > 0) problems.push("the refused Shadow left a pi pane");
    const chosenName = "shadow-hpool-01-unnamed";
    const chosen = await flow.launch(chosenName, "Shadow", "alpha-hpool-01", [], []);
    await workspace.saveText("H4-unnamed-create-agent.txt", `${chosen.created.stdout}\n${chosen.created.stderr}`);
    const record = await flow.court.spawnRecord(chosenName);
    if (record?.harness !== "pi" || record?.model !== "flash") problems.push(`the Shadow asked for with no model was recorded as ${record?.harness}/${record?.model}`);
    problems.push(...reconciliationProblems(await flow.restartBackend()).map((problem) => `restart: ${problem}`));
    const recheck = await flow.throne(["agent-statuses"]);
    if (recheck.code !== 0 || !recheck.stdout.includes(chosen.name) || recheck.stdout.includes(refusedName)) problems.push(`re-check after the restart: agent-statuses exit ${recheck.code}, lists the pool's Shadow ${recheck.stdout.includes(chosen.name)}, lists the refused one ${recheck.stdout.includes(refusedName)}`);
    if (problems.length > 0) return { verdict: "FAIL", observed: problems.join("; ") };
    return { verdict: "PASS", observed: `with a Shadow pool of pi/flash only, a Shadow on pi/pro was refused (${refusal.trim()}); a Shadow asked for with no --model launched on the pool's pi/flash, its spawn.json records pi/flash, and it is listed after the backend restart` };
  } finally {
    await closeRealCourt(flow.court);
  }
}

export const lines = [
  { id: "H1", run: (workspace) => wholeCampaign(workspace, false), restsOn: FLOW_FILES },
  { id: "H2", run: (workspace) => wholeCampaign(workspace, true), restsOn: FLOW_FILES },
  { id: "H3", run: olderAgentsUnderTheNewBuild, restsOn: [...FLOW_FILES, "test/fixtures/capability-removal-evidence/data-home"] },
  { id: "H4", run: oneModelShadowPool, restsOn: FLOW_FILES },
];
