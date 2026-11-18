import { chmod, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchAccountOption } from "../../../src/account/agent-account.ts";
import { readAccountsConfig } from "../../../src/account/accounts-config.ts";
import { providerKeyReadiness } from "../../../src/account/provider-accounts.ts";
import { STAND_IN_KEY, piProcessOfPane, runCommand } from "../support.mjs";

const DUMMY_KEY = "dummy-deepseek-key-for-evidence";

async function addDeepseek(workspace) {
  await workspace.herdr();
  const sourceKeyFile = path.join(workspace.scratch, "deepseek-api-key");
  await writeFile(sourceKeyFile, `${DUMMY_KEY}\n`, { mode: 0o600 });
  const added = await workspace.throneCli(["account", "add", "deepseek", "--provider", "deepseek", "--key-file", sourceKeyFile]);
  await workspace.saveText("account-add.txt", `exit ${added.code}\n${added.stdout}${added.stderr}`);
  return added;
}

async function listOutput(workspace, name) {
  const listed = await workspace.throneCli(["account", "list"]);
  const text = `exit ${listed.code}\n${listed.stdout}${listed.stderr}`;
  await workspace.saveText(name, text);
  return { ...listed, text };
}

function configPathOf(workspace) {
  return path.join(workspace.dataHome, "config", "accounts.json");
}

function keyFileOf(workspace) {
  return path.join(workspace.dataHome, "accounts", "pi", "deepseek", "api-key");
}

async function addedAndListed(workspace) {
  const added = await addDeepseek(workspace);
  const listed = await listOutput(workspace, "account-list.txt");
  const wanted = ["deepseek — provider deepseek", "harness: pi", "usage: pay per token", "live agents: none"];
  const missing = wanted.filter((part) => !listed.stdout.includes(part));
  const keyShown = (added.stdout + added.stderr + listed.text).includes(DUMMY_KEY);
  const observed = `add exit ${added.code}, list exit ${listed.code}; missing parts: ${missing.length === 0 ? "none" : missing.join(" | ")}; key in output: ${keyShown}`;
  const passed = added.code === 0 && listed.code === 0 && missing.length === 0 && !keyShown;
  return { verdict: passed ? "PASS" : "FAIL", observed, error: passed ? null : listed.stderr || added.stderr || null };
}

async function piPanes(workspace) {
  const herdr = await workspace.herdr();
  return JSON.parse(await herdr.call("pane", "list")).result.panes.filter((pane) => pane.agent === "pi");
}

async function launchRefused(workspace, name) {
  const standIn = await workspace.standIn();
  const result = await workspace.createPiAgent(name, "pi/flash", standIn.baseUrl);
  const recorded = (await workspace.spawnRecord(name)) !== null;
  const panes = (await piPanes(workspace)).length;
  return { code: result.code, said: result.stderr.trim(), recorded, panes };
}

async function keyStaysOutOfLaunch(workspace) {
  const startedAt = Math.floor(Date.now() / 1000);
  const name = "shadow-pievidence-key";
  const { herdr, paneId, record, result } = await workspace.launchPiAgent(name, "pi/flash");
  if (paneId === undefined) return { verdict: "FAIL", observed: `create-agent exit ${result.code}`, error: result.stderr.trim() };
  await herdr.waitForPi(paneId, "deepseek-flash");
  const piProcess = await piProcessOfPane(herdr, paneId);
  const visible = await herdr.call("pane", "read", paneId, "--source", "visible");
  await workspace.saveText("pane-visible.txt", visible);
  const journal = await runCommand("journalctl", ["--user", "--since", `@${startedAt}`, "--no-pager"]);
  const key = STAND_IN_KEY;
  const inCmdline = piProcess?.cmdline.includes(key) ?? true;
  const inEnvironment = piProcess?.environment.DEEPSEEK_API_KEY === key;
  const inSpawn = JSON.stringify(record).includes(key);
  const inPane = visible.includes(key);
  const inJournal = journal.stdout.includes(key);
  const inLaunchOutput = (result.stdout + result.stderr).includes(key);
  const observed =
    `pid ${piProcess?.pid}: key in /proc cmdline ${inCmdline}, in DEEPSEEK_API_KEY of its environment ${inEnvironment}; ` +
    `in spawn.json ${inSpawn}; in visible pane text ${inPane}; in the user journal since launch ${inJournal} (journal read exit ${journal.code}); in create-agent output ${inLaunchOutput}`;
  const passed = piProcess !== null && !inCmdline && inEnvironment && !inSpawn && !inPane && !inJournal && !inLaunchOutput && journal.code === 0;
  return { verdict: passed ? "PASS" : "FAIL", observed };
}

async function keyFilePlaceAndMode(workspace) {
  const added = await addDeepseek(workspace);
  const keyFile = keyFileOf(workspace);
  const mode = (await stat(keyFile)).mode & 0o777;
  const copied = (await readFile(keyFile, "utf8")).trim() === DUMMY_KEY;
  const ready = await providerKeyReadiness("deepseek", configPathOf(workspace));
  await chmod(keyFile, 0o644);
  const widened = await providerKeyReadiness("deepseek", configPathOf(workspace));
  await workspace.saveText("readiness.json", `${JSON.stringify({ ready, widened }, null, 2)}\n`);
  const underHome = keyFile.startsWith(path.join(workspace.dataHome, "accounts"));
  const refusedNamingFile = !widened.ready && widened.refusal.includes(keyFile) && widened.refusal.includes("wider than 600");
  const observed = `add exit ${added.code}; key file ${keyFile} under the throne home: ${underHome}, mode ${mode.toString(8)}, copied intact: ${copied}; ready at 600: ${ready.ready}; at 644 refused naming the file: ${refusedNamingFile}. The launch calls this decision from slice 07.`;
  const launch = await launchRefused(workspace, "shadow-pievidence-wide");
  await workspace.saveText("launch-at-644.json", `${JSON.stringify(launch, null, 2)}\n`);
  const launchRefusedNamingFile = launch.code !== 0 && launch.said.includes(keyFile) && launch.said.includes("wider than 600") && !launch.recorded && launch.panes === 0;
  const passed = added.code === 0 && underHome && mode === 0o600 && copied && ready.ready && refusedNamingFile && launchRefusedNamingFile;
  return {
    verdict: passed ? "PASS" : "FAIL",
    observed: `${observed} A real create-agent pi/flash at 644: exit ${launch.code}, names the file: ${launch.said.includes(keyFile)}, spawn.json written: ${launch.recorded}, pi panes: ${launch.panes}`,
  };
}

async function claudeRowsUnchanged(workspace) {
  await workspace.herdr();
  const before = await listOutput(workspace, "account-list-before.txt");
  const launchBefore = await launchAccountOption("shadow-claude", undefined, () => readAccountsConfig(configPathOf(workspace)), async () => "shadow");
  const added = await addDeepseek(workspace);
  const after = await listOutput(workspace, "account-list-after.txt");
  const launchAfter = await launchAccountOption("shadow-claude", undefined, () => readAccountsConfig(configPathOf(workspace)), async () => "shadow");
  const claudeRowsAfter = after.stdout.split("\n").slice(0, before.stdout.split("\n").length - 1).join("\n") + "\n";
  const rowsSame = claudeRowsAfter === before.stdout;
  const launchSame = JSON.stringify(launchBefore) === JSON.stringify(launchAfter);
  const observed = `before had no accounts.json; add exit ${added.code}; claude lines identical after: ${rowsSame}; a Claude Shadow's launch account option before ${JSON.stringify(launchBefore)} after ${JSON.stringify(launchAfter)}`;
  const passed = added.code === 0 && before.code === 0 && after.code === 0 && rowsSame && launchSame;
  return { verdict: passed ? "PASS" : "FAIL", observed };
}

async function missingAccountOrKey(workspace) {
  const noAccount = await launchRefused(workspace, "shadow-pievidence-noaccount");
  await addDeepseek(workspace);
  const keyFile = keyFileOf(workspace);
  await writeFile(keyFile, "");
  const empty = await launchRefused(workspace, "shadow-pievidence-emptykey");
  await unlink(keyFile);
  const missing = await launchRefused(workspace, "shadow-pievidence-nokey");
  await workspace.saveText("refusals.json", `${JSON.stringify({ noAccount, empty, missing }, null, 2)}\n`);
  const nothingLaunched = [noAccount, empty, missing].every((launch) => launch.code !== 0 && !launch.recorded && launch.panes === 0);
  const named =
    noAccount.said.includes("no deepseek provider account") &&
    empty.said.includes(keyFile) && empty.said.includes("is empty") &&
    missing.said.includes(keyFile) && missing.said.includes("is missing");
  const describe = (launch) => `exit ${launch.code}, spawn.json ${launch.recorded}, pi panes ${launch.panes}: "${launch.said.slice(0, 220)}"`;
  const observed = `real create-agent pi/flash — no account: ${describe(noAccount)}; empty key: ${describe(empty)}; missing key: ${describe(missing)}`;
  return { verdict: named && nothingLaunched ? "PASS" : "FAIL", observed };
}

export const lines = [
  { id: "P3.1", run: addedAndListed },
  { id: "P3.2", needsPane: true, run: keyStaysOutOfLaunch },
  { id: "P3.3", run: keyFilePlaceAndMode },
  { id: "P3.4", run: claudeRowsUnchanged },
  { id: "P3.5", run: missingAccountOrKey },
];
