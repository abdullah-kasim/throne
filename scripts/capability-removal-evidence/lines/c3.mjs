import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { COMMITTED_DEFAULT_CONFIG, THRONE_ROOT, sameAnswers } from "../support.mjs";
import { createAgentArguments } from "./c1.mjs";
import { pollUntil } from "../../pi-evidence/support.mjs";
import { closeRealCourt, killPiIn, launchRealPiAgent, openRealCourt, piProcessesIn } from "./real-court.mjs";

const OLD_DATA_HOME = path.join(THRONE_ROOT, "test", "fixtures", "capability-removal-evidence", "data-home");
const SPAWN_RECORD_FILES = ["scripts/capability-removal-evidence/lines/real-court.mjs", "src/agentdata/spawn-data-contracts.ts", "src/create-agent/agent-record.ts", "src/throne-startup/throne-startup-reconciliation.service.ts", "scripts/capability-removal-evidence/spawn-record-court.ts"];
const WITHOUT_THE_FIELD = "-nofield";
const OLD_FORMAT_AGENT = "shadow-capevidence-oldrecord";
const OLD_CAPABILITY_FIELD_SOURCE = path.join(OLD_DATA_HOME, "data", "shadow-oldgrades-01z-critique", "spawn.json");
const FIRST_MESSAGE = "remember the word kiwi";
const SECOND_MESSAGE = "which word did I ask you to remember";

async function oldAgentNames() {
  return readdir(path.join(OLD_DATA_HOME, "data"));
}

async function spawnFilesOf(dataHome, names) {
  return Promise.all(names.map((name) => readFile(path.join(dataHome, "data", name, "spawn.json"), "utf8")));
}

async function newRecordHasNoField(workspace) {
  await workspace.useConfig(COMMITTED_DEFAULT_CONFIG);
  const name = "shadow-fresh-record";
  const outcome = await workspace.probe("create-agent-court.ts", [...createAgentArguments("Shadow", "opus", name), "--cwd", workspace.agentCwd]);
  await workspace.saveText("C3.1-spawn.json", `${JSON.stringify(outcome.spawn, null, 2)}\n`);
  if (outcome.spawn === null) return { verdict: "FAIL", observed: `no spawn.json was written: ${outcome.stderr}` };
  return "capability" in outcome.spawn
    ? { verdict: "FAIL", observed: "the new spawn.json carries a capability field" }
    : { verdict: "PASS", observed: `the new spawn.json has ${Object.keys(outcome.spawn).length} fields and no capability field` };
}

async function copyOldDataHome(workspace) {
  await cp(OLD_DATA_HOME, workspace.dataHome, { recursive: true });
  await workspace.useConfig(COMMITTED_DEFAULT_CONFIG);
  const names = await oldAgentNames();
  await Promise.all(names.map((name) => writeFile(path.join(workspace.dataHome, "data", name, "identity.md"), `# ${name}\n`)));
  return names;
}

async function oldRecordsLoadTheSame(workspace) {
  const names = await copyOldDataHome(workspace);
  for (const name of names) {
    const folder = path.join(workspace.dataHome, "data", name);
    const record = JSON.parse(await readFile(path.join(folder, "spawn.json"), "utf8"));
    delete record.capability;
    await cp(folder, `${folder}${WITHOUT_THE_FIELD}`, { recursive: true });
    await writeFile(path.join(`${folder}${WITHOUT_THE_FIELD}`, "spawn.json"), `${JSON.stringify(record, null, 2)}\n`);
  }
  const court = await workspace.probe("spawn-record-court.ts", [...names, ...names.map((name) => `${name}${WITHOUT_THE_FIELD}`)]);
  await workspace.saveText("C3.2-readers.json", `${JSON.stringify(court, null, 2)}\n`);
  const byName = new Map(court.records.map((record) => [record.name, record]));
  return names.flatMap((name) => {
    const old = byName.get(name);
    const stripped = byName.get(`${name}${WITHOUT_THE_FIELD}`);
    if (!old.loaded) return [`${name} did not load`];
    if (old.resume === null) return [`${name} did not resume`];
    return sameAnswers(old.resume, stripped.resume) ? [] : [`${name} resumes differently from the same record without the field`];
  });
}

async function oldRecordIsListedAndResumes(workspace) {
  const { capability } = JSON.parse(await readFile(OLD_CAPABILITY_FIELD_SOURCE, "utf8"));
  const court = await openRealCourt(workspace);
  try {
    const standIn = await court.standIn();
    const { created, herdr, paneId, ready } = await launchRealPiAgent(court, OLD_FORMAT_AGENT, standIn);
    await workspace.saveText("C3.2-create-agent.txt", `exit ${created.code}\n${created.stdout}\n${created.stderr}`);
    if (!ready.found) return [`the agent never started: create-agent exit ${created.code}: ${ready.cause ?? ""} ${created.stderr}`.trim()];
    await herdr.typeAndSubmit(paneId, FIRST_MESSAGE);
    await herdr.waitForPaneText(paneId, () => standIn.requests.some((body) => JSON.stringify(body).includes(FIRST_MESSAGE)));
    const spawnPath = path.join(court.dataHome, "data", OLD_FORMAT_AGENT, "spawn.json");
    const record = JSON.parse(await readFile(spawnPath, "utf8"));
    await writeFile(spawnPath, `${JSON.stringify({ ...record, capability }, null, 2)}\n`);
    const statuses = await court.throneCli(["agent-statuses"]);
    await workspace.saveText("C3.2-agent-statuses.txt", `exit ${statuses.code}\n${statuses.stdout}\n${statuses.stderr}`);
    const killed = await killPiIn(herdr, paneId);
    const options = await court.courtResumeOptions(OLD_FORMAT_AGENT, standIn.baseUrl);
    await workspace.saveText("C3.2-resume-options.json", `${JSON.stringify(options, null, 2)}\n`);
    if (options === null) return ["the court's resume launched nothing for the old-format record"];
    await court.runCourtResume(paneId, options);
    const back = await herdr.waitForPaneText(paneId, (text) => text.includes("deepseek-flash") && text.includes(FIRST_MESSAGE));
    const requestsBefore = standIn.requests.length;
    await herdr.typeAndSubmit(paneId, SECOND_MESSAGE);
    const resumed = await pollUntil(() => standIn.requests.slice(requestsBefore), (bodies) => bodies.some((body) => JSON.stringify(body).includes(SECOND_MESSAGE)), 30_000, 500);
    await workspace.saveText("C3.2-pane-after-resume.txt", await herdr.readPane(paneId));
    const historyKept = resumed.value.some((body) => JSON.stringify(body).includes(SECOND_MESSAGE) && JSON.stringify(body).includes(FIRST_MESSAGE));
    const running = (await piProcessesIn(herdr, paneId)).length > 0;
    const problems = [];
    if (statuses.code !== 0) problems.push(`agent-statuses exited ${statuses.code}: ${statuses.stderr}`);
    if (!statuses.stdout.includes(OLD_FORMAT_AGENT)) problems.push("agent-statuses did not list the old-format agent");
    if (killed.killed === 0 || killed.left !== 0) problems.push(`kill left ${killed.left} of ${killed.killed} pi processes`);
    if (!back.found || !historyKept || !running) problems.push(`resume: earlier message shown ${back.found}, history sent ${historyKept}, pi running ${running}`);
    return problems;
  } finally {
    await closeRealCourt(court);
  }
}

async function oldRecordStillLoads(workspace) {
  const problems = [...(await oldRecordsLoadTheSame(workspace)), ...(await oldRecordIsListedAndResumes(workspace))];
  return problems.length > 0
    ? { verdict: "FAIL", observed: problems.join("; ") }
    : { verdict: "PASS", observed: `the old fixture records load and resume like their copies without the field; a real pi agent whose spawn.json carries the old capability field is listed by agent-statuses, killed, and resumed in its pane by the court with its earlier conversation` };
}

async function reconciliationLeavesOldRecords(workspace) {
  const names = await copyOldDataHome(workspace);
  const beforeFiles = await spawnFilesOf(workspace.dataHome, names);
  const court = await workspace.probe("spawn-record-court.ts", []);
  const afterFiles = await spawnFilesOf(workspace.dataHome, names);
  await workspace.saveText("C3.3-reconciliation.json", `${JSON.stringify(court.reconciliation, null, 2)}\n`);
  const failed = court.reconciliation.outcomes.filter((outcome) => !outcome.ok);
  if (failed.length > 0 || court.reconciliation.warnings.length > 0) return { verdict: "FAIL", observed: `reconciliation reported errors: ${JSON.stringify({ failed, warnings: court.reconciliation.warnings })}` };
  if (court.reconciliation.actions.length !== names.length) return { verdict: "FAIL", observed: `reconciliation acted on ${court.reconciliation.actions.length} of ${names.length} old agents: ${JSON.stringify(court.reconciliation.outcomes)}` };
  if (!sameAnswers(beforeFiles, afterFiles)) return { verdict: "FAIL", observed: "reconciliation changed an old spawn.json" };
  return { verdict: "PASS", observed: `reconciliation over ${names.length} old agents reported no error, chose ${JSON.stringify(court.reconciliation.actions)}, and changed no spawn.json` };
}

export const lines = [
  { id: "C3.1", run: newRecordHasNoField, restsOn: SPAWN_RECORD_FILES },
  { id: "C3.2", run: oldRecordStillLoads, restsOn: SPAWN_RECORD_FILES },
  { id: "C3.3", run: reconciliationLeavesOldRecords, restsOn: SPAWN_RECORD_FILES },
];
