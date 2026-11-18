import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { THRONE_CLI_PATH, deepseekKeyForRealProvider, pause, pollUntil, runCommand } from "../support.mjs";
import { isPiCodingAgentProcess } from "../../../src/harness-routing/harness.ts";
import { parseAgentList } from "../../../src/herdr/herdr-inventory.service.ts";
import { court } from "./delivery.mjs";
import { startTypingBackend } from "./runtime.mjs";

export const FLOWS_RUN_ONE_AT_A_TIME = "Flows run one at a time because they share one DeepSeek account and its token budget, and F6 removes that account.";

const SUPERVISOR = "alpha-pievidence-01";
const TASK_TIMEOUT_MILLISECONDS = 600_000;
const DUPLICATE_WINDOW_MILLISECONDS = 15_000;
const GIT_COMMIT = "/usr/bin/git -c user.name=pi-evidence -c user.email=pi-evidence@localhost -c commit.gpgsign=false";

function newWord(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function sendCommand(recipient, text) {
  return `${THRONE_CLI_PATH} send-agent ${recipient} "${text}"`;
}

function shadowTasking(name, word) {
  return [
    `You are ${name}. Work in the current folder, a git repository, and do exactly these steps with your tools:`,
    "1. Write add.mjs exporting a function add(a, b) that returns a + b.",
    '2. Write add.test.mjs that imports { test, expect } from "bun:test" and checks that add(2, 3) is 5.',
    "3. Run: bun test",
    `4. Run: /usr/bin/git add add.mjs add.test.mjs && ${GIT_COMMIT} commit -m "Add add"`,
    `5. Run exactly once: ${sendCommand(SUPERVISOR, `DONE ${word}`)}`,
    `6. Run: ${THRONE_CLI_PATH} my-state reapable completed`,
    "Then stop.",
  ].join("\n");
}

function texts(standIn) {
  const last = standIn.turns[standIn.turns.length - 1];
  return last === undefined ? [] : last.texts;
}

async function sessionRecords(workspace, name) {
  const records = [];
  for (const folder of [path.join(workspace.dataHome, "data", name), path.join(workspace.dataHome, "data", ".reaped", name)]) {
    const entries = await readdir(folder, { recursive: true }).catch(() => []);
    for (const entry of entries.filter((file) => file.endsWith(".jsonl"))) {
      const text = await readFile(path.join(folder, entry), "utf8");
      for (const row of text.split("\n").filter(Boolean)) {
        try {
          records.push(JSON.parse(row));
        } catch {
          continue;
        }
      }
    }
  }
  return records;
}

export function tokensSpent(records) {
  const spent = { input: 0, output: 0, cacheRead: 0, total: 0 };
  for (const record of records) {
    const usage = record?.message?.usage ?? record?.usage;
    if (usage === undefined || usage === null || typeof usage !== "object") continue;
    const input = Number(usage.input ?? 0);
    const output = Number(usage.output ?? 0);
    const cacheRead = Number(usage.cacheRead ?? 0);
    spent.input += input;
    spent.output += output;
    spent.cacheRead += cacheRead;
    spent.total += Number(usage.totalTokens ?? input + output + cacheRead);
  }
  return spent;
}

function addTokens(...all) {
  return all.reduce((sum, one) => ({
    input: sum.input + one.input,
    output: sum.output + one.output,
    cacheRead: sum.cacheRead + one.cacheRead,
    total: sum.total + one.total,
  }), { input: 0, output: 0, cacheRead: 0, total: 0 });
}

async function tokensOf(workspace, ...names) {
  const spent = [];
  for (const name of names) spent.push(tokensSpent(await sessionRecords(workspace, name)));
  return addTokens(...spent);
}

async function sessionText(workspace, name) {
  return JSON.stringify(await sessionRecords(workspace, name));
}

function userTurnsHolding(records, word, unlessHolding) {
  return records.filter((record) => record?.message?.role === "user")
    .map((record) => JSON.stringify(record.message.content))
    .filter((text) => text.includes(word) && !text.includes(unlessHolding)).length;
}

async function paneOf(herdr, name) {
  const agents = parseAgentList(await herdr.call("agent", "list"));
  return agents.find((agent) => agent.name === name)?.paneId;
}

async function piProcessesIn(herdr, paneId) {
  if (paneId === undefined) return [];
  const info = await herdr.processInfo(paneId).catch(() => ({}));
  return (info.foreground_processes ?? []).filter((entry) => isPiCodingAgentProcess({ name: entry.name, argv: entry.argv ?? [] }));
}

async function realCourt(workspace) {
  const key = await deepseekKeyForRealProvider();
  workspace.supervisorHarness = "pi";
  const keyFile = await workspace.addDeepseekAccount(key);
  await workspace.writePiAdmittingConfig();
  const herdr = await workspace.herdr();
  const room = await court(workspace);
  const supervisor = await room.startAgent(SUPERVISOR);
  let backend = await startTypingBackend(workspace, herdr);
  let restarts = 0;
  return {
    key,
    keyFile,
    herdr,
    supervisor,
    received(word) {
      return texts(supervisor.standIn).filter((text) => text.includes(word)).length;
    },
    async restartBackend() {
      await backend.stop(`backend-output-${restarts}.txt`);
      restarts += 1;
      backend = await startTypingBackend(workspace, herdr);
    },
    async stop() {
      await backend.stop(`backend-output-${restarts}.txt`);
      await room.finish([supervisor]);
    },
  };
}

async function waitForReceived(real, word) {
  await pollUntil(async () => real.received(word), (count) => count >= 1, TASK_TIMEOUT_MILLISECONDS, 3000);
  await pause(DUPLICATE_WINDOW_MILLISECONDS);
  return real.received(word);
}

async function reap(workspace, name, worktree, base) {
  await writeFile(path.join(workspace.dataHome, "data", name, "REPORT.md"), "done\n").catch(() => undefined);
  if (worktree !== undefined) {
    await runCommand("/usr/bin/git", ["-C", workspace.repository, "merge", "-q", "--ff-only", name]);
    await writeFile(
      path.join(workspace.dataHome, "data", name, "tree-base.json"),
      `${JSON.stringify({ name, base: "master", branch: name, commit: base, repo: workspace.repository, repoRoot: workspace.repository, projectDir: ".", notedAt: new Date().toISOString() })}\n`,
    ).catch(() => undefined);
  }
  const completed = await workspace.throneCliFromLiveRoot(["complete-agent", name]);
  await workspace.saveText(`complete-agent-${name}.txt`, `exit ${completed.code}\n${completed.stdout}${completed.stderr}`);
  return completed.code;
}

async function stateOf(workspace, name) {
  for (const folder of [path.join(workspace.dataHome, "data", name), path.join(workspace.dataHome, "data", ".reaped", name)]) {
    try {
      return JSON.parse(await readFile(path.join(folder, "state.json"), "utf8"));
    } catch {
      continue;
    }
  }
  return null;
}

async function nothingLeft(workspace, herdr, name, paneId, worktree, piBefore) {
  const panes = async () => parseAgentList(await herdr.call("agent", "list"));
  const paneClosed = (await pollUntil(panes, (agents) => !agents.some((agent) => agent.name === name || agent.paneId === paneId), 15_000)).found;
  const worktreeGone = worktree === undefined || !existsSync(worktree);
  const archived = existsSync(path.join(workspace.dataHome, "data", ".reaped", name)) && !existsSync(path.join(workspace.dataHome, "data", name));
  const left = piBefore.filter((entry) => existsSync(`/proc/${entry.pid}`)).length;
  return { clean: paneClosed && worktreeGone && archived && left === 0, said: `pane closed: ${paneClosed}, worktree removed: ${worktreeGone}, ledger archived: ${archived}, pi processes left: ${left}` };
}

function keyPlaces(real, workspace) {
  return async (name, paneId, piBefore) => {
    const found = [];
    for (const entry of piBefore) {
      const cmdline = await readFile(`/proc/${entry.pid}/cmdline`, "utf8").catch(() => "");
      if (cmdline.includes(real.key)) found.push("cmdline");
    }
    const spawn = await readFile(path.join(workspace.dataHome, "data", name, "spawn.json"), "utf8").catch(() => "");
    if (spawn.includes(real.key)) found.push("spawn.json");
    if (paneId !== undefined && (await real.herdr.readPane(paneId).catch(() => "")).includes(real.key)) found.push("pane text");
    return found;
  };
}

async function backendOutputHoldsKey(workspace, key) {
  for (const file of workspace.evidence().files.filter((file) => path.basename(file).startsWith("backend-output"))) {
    if ((await readFile(file, "utf8").catch(() => "")).includes(key)) return true;
  }
  return false;
}

async function shadowDoesATask(workspace, real, name, model) {
  const word = newWord("F");
  const worktree = path.join(workspace.dataHome, "worktrees", "repository", name);
  await mkdir(path.dirname(worktree), { recursive: true });
  await runCommand("git", ["-C", workspace.repository, "worktree", "add", "-q", "-b", name, worktree]);
  const base = (await runCommand("git", ["-C", workspace.repository, "rev-parse", "HEAD"])).stdout.trim();
  const created = await workspace.createPiAgent(name, model, undefined, worktree, { prompt: shadowTasking(name, word) });
  const paneId = await paneOf(real.herdr, name);
  const piBefore = await piProcessesIn(real.herdr, paneId);
  const keyFoundIn = await keyPlaces(real, workspace)(name, paneId, piBefore);
  const doneCount = paneId === undefined ? 0 : await waitForReceived(real, word);
  if (paneId !== undefined) await real.herdr.savePane(paneId, `pane-${name}.txt`);
  const commits = (await runCommand("git", ["-C", worktree, "log", "--format=%s", `${base}..HEAD`])).stdout.trim();
  const tested = await runCommand("bun", ["test"], { cwd: worktree, timeout: 60_000 });
  await workspace.saveText(`bun-test-${name}.txt`, `exit ${tested.code}\n${tested.stdout}${tested.stderr}`);
  const claimed = (await stateOf(workspace, name))?.state;
  const tokens = await tokensOf(workspace, name);
  const completeCode = await reap(workspace, name, worktree, base);
  await real.restartBackend();
  const left = await nothingLeft(workspace, real.herdr, name, paneId, worktree, piBefore);
  const landed = (await runCommand("git", ["-C", workspace.repository, "log", "--format=%s", "HEAD"])).stdout.includes("Add add");
  const passed = created.code === 0 && paneId !== undefined && commits !== "" && tested.code === 0 && doneCount === 1 && completeCode === 0 && left.clean && landed;
  const said =
    `${name} on ${model}: create-agent exit ${created.code}; commits: ${commits.replace(/\n/g, ", ") || "none"}; bun test exit ${tested.code}; ` +
    `DONE messages the supervisor received: ${doneCount}; state it claimed: ${claimed ?? "none"}; complete-agent exit ${completeCode}; ` +
    `after the backend restart: ${left.said}, commit on the target branch: ${landed}`;
  return { passed, said, tokens, keyFoundIn };
}

function shadowFlow(name, model) {
  return async (workspace) => {
    const real = await realCourt(workspace);
    try {
      const outcome = await shadowDoesATask(workspace, real, name, model);
      return { verdict: outcome.passed ? "PASS" : "FAIL", observed: outcome.said, tokens: outcome.tokens };
    } finally {
      await real.stop();
    }
  };
}

async function alphaSpawnsAShadow(workspace) {
  const real = await realCourt(workspace);
  const alpha = "alpha-pievidence-f3";
  const shadow = "shadow-pievidence-f3";
  const report = newWord("REPORT");
  const relay = newWord("RELAYED");
  const shadowTask = `Run exactly once: ${sendCommand(alpha, report)} and then stop.`;
  const alphaTask = [
    `You are ${alpha}. Do exactly these steps with your tools:`,
    `1. Run: cd ${workspace.liveRoot} && ${THRONE_CLI_PATH} create-agent --model pi/flash --role Shadow --name ${shadow} --supervisor ${alpha} --non-campaign --cwd ${workspace.repository} --prompt '${shadowTask}'`,
    "2. End your turn and wait. Your Shadow will send you a message holding a word starting with REPORT.",
    `3. When it arrives, run exactly once: ${sendCommand(SUPERVISOR, `${relay} <the REPORT word you received>`)}`,
  ].join("\n");
  try {
    const created = await workspace.createPiAgent(alpha, "pi/flash", undefined, workspace.repository, { role: "Alpha", supervisor: "Regent", prompt: alphaTask });
    const relayed = await waitForReceived(real, relay);
    const alphaPane = await paneOf(real.herdr, alpha);
    const shadowPane = await paneOf(real.herdr, shadow);
    const piBefore = [...(await piProcessesIn(real.herdr, alphaPane)), ...(await piProcessesIn(real.herdr, shadowPane))];
    for (const [name, paneId] of [[alpha, alphaPane], [shadow, shadowPane]]) if (paneId !== undefined) await real.herdr.savePane(paneId, `pane-${name}.txt`);
    const supervisorTexts = texts(real.supervisor.standIn).join("\n");
    const relayCarriedReport = supervisorTexts.includes(`${relay} ${report}`);
    const shadowSaw = await sessionText(workspace, shadow);
    const alphaSaw = await sessionText(workspace, alpha);
    const alphaGotReport = alphaSaw.split(report).length - 1 >= 1;
    const wrongDeliveries = [shadowSaw.includes(relay) && `${shadow} saw ${relay}`, supervisorTexts.includes(`${report}`) && !relayCarriedReport && `the supervisor got ${report} unrelayed`].filter(Boolean);
    const tokens = await tokensOf(workspace, alpha, shadow);
    for (const [name, paneId] of [[shadow, shadowPane], [alpha, alphaPane]]) {
      await workspace.throneCliFromLiveRoot(["my-state", "reapable", "completed"], { THRONE_AGENT_NAME: name, HERDR_PANE_ID: paneId ?? "" });
    }
    const shadowReaped = await reap(workspace, shadow, undefined, undefined);
    const alphaReaped = await reap(workspace, alpha, undefined, undefined);
    await real.restartBackend();
    const shadowLeft = await nothingLeft(workspace, real.herdr, shadow, shadowPane, undefined, piBefore);
    const alphaLeft = await nothingLeft(workspace, real.herdr, alpha, alphaPane, undefined, piBefore);
    const passed = created.code === 0 && shadowPane !== undefined && alphaGotReport && relayed === 1 && relayCarriedReport && wrongDeliveries.length === 0 && shadowReaped === 0 && alphaReaped === 0 && shadowLeft.clean && alphaLeft.clean;
    return {
      verdict: passed ? "PASS" : "FAIL",
      tokens,
      observed:
        `pi Alpha create-agent exit ${created.code}; Shadow it spawned seen in herdr: ${shadowPane !== undefined}; Alpha's session holds the Shadow's report: ${alphaGotReport}; ` +
        `relays the supervisor received: ${relayed}, carrying the report word: ${relayCarriedReport}; messages at the wrong agent: ${wrongDeliveries.join(", ") || "none"}; ` +
        `complete-agent exits: Shadow ${shadowReaped}, Alpha ${alphaReaped}; after the backend restart: Shadow ${shadowLeft.said}; Alpha ${alphaLeft.said}`,
    };
  } finally {
    await real.stop();
  }
}

async function waitingAgentIsWokenOnce(workspace) {
  const real = await realCourt(workspace);
  const name = "shadow-pievidence-f4";
  const finished = newWord("RUN-FINISHED");
  const resumed = newWord("RESUMED");
  const background = `nohup setsid bash -c 'sleep 60; ${sendCommand(name, finished)} --sender-name pievidence-runner' >/dev/null 2>&1 &`;
  const task = [
    `You are ${name}. Do exactly these steps with your tools:`,
    `1. Run this background command exactly as written: ${background}`,
    `2. Run: ${THRONE_CLI_PATH} my-state waiting-on-own-run "sleep run"`,
    '3. End your turn with exactly this text and nothing after it: {"blocked":true} BLOCKED_BY_own-background-run (sleep run)',
    `When a message holding ${finished} arrives later, run exactly once: ${sendCommand(SUPERVISOR, resumed)}`,
  ].join("\n");
  try {
    const created = await workspace.createPiAgent(name, "pi/flash", undefined, workspace.repository, { prompt: task });
    const paneId = await paneOf(real.herdr, name);
    const piBefore = await piProcessesIn(real.herdr, paneId);
    const waiting = await pollUntil(() => stateOf(workspace, name), (state) => state?.state === "waiting-on-own-run", 120_000, 1000);
    const resumedCount = await waitForReceived(real, resumed);
    const wokenTimes = userTurnsHolding(await sessionRecords(workspace, name), finished, resumed);
    const after = await stateOf(workspace, name);
    if (paneId !== undefined) await real.herdr.savePane(paneId, `pane-${name}.txt`);
    const tokens = await tokensOf(workspace, name);
    await workspace.throneCliFromLiveRoot(["my-state", "reapable", "completed"], { THRONE_AGENT_NAME: name, HERDR_PANE_ID: paneId ?? "" });
    const reaped = await reap(workspace, name, undefined, undefined);
    await real.restartBackend();
    const left = await nothingLeft(workspace, real.herdr, name, paneId, undefined, piBefore);
    const passed = created.code === 0 && waiting.found && resumedCount === 1 && wokenTimes === 1 && after?.state === "working" && reaped === 0 && left.clean;
    return {
      verdict: passed ? "PASS" : "FAIL",
      tokens,
      observed:
        `create-agent exit ${created.code}; state.json read waiting-on-own-run while the command ran: ${waiting.found}; ` +
        `resumed reports the supervisor received: ${resumedCount}; wake messages holding ${finished} it received: ${wokenTimes}; state.json after it resumed: ${after?.state ?? "none"}; ` +
        `complete-agent exit ${reaped}; after the backend restart: ${left.said}`,
    };
  } finally {
    await real.stop();
  }
}

function fileHash(filePath) {
  return readFile(filePath).then((bytes) => createHash("sha256").update(bytes).digest("hex"), () => "absent");
}

async function scratchClaudeConfig(workspace) {
  const configDirectory = path.join(workspace.scratch, "claude-config");
  const home = path.join(workspace.scratch, "home");
  await mkdir(configDirectory, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const file of ["settings.json", ".credentials.json"]) {
    await cp(path.join(os.homedir(), ".claude", file), path.join(configDirectory, file), { dereference: true }).catch(() => undefined);
  }
  const settings = JSON.parse(await readFile(path.join(os.homedir(), ".claude.json"), "utf8").catch(() => "{}"));
  settings.projects = settings.projects ?? {};
  for (const folder of [workspace.repository, await realpath(workspace.repository)]) {
    settings.projects[folder] = { ...(settings.projects[folder] ?? {}), hasTrustDialogAccepted: true };
  }
  await writeFile(path.join(configDirectory, ".claude.json"), JSON.stringify(settings));
  await symlink(configDirectory, path.join(home, ".claude"));
  await symlink(path.join(os.homedir(), ".local"), path.join(home, ".local"));
  workspace.sessionEnvironment = { CLAUDE_CONFIG_DIR: configDirectory, DISABLE_AUTOUPDATER: "1" };
  workspace.claudeTranscriptHome = home;
  return { CLAUDE_CONFIG_DIR: configDirectory, DISABLE_AUTOUPDATER: "1" };
}

async function claudeAndPiShadowsGetOnlyTheirOwn(workspace) {
  const guarded = [path.join(os.homedir(), ".claude", "settings.json")];
  const before = await Promise.all(guarded.map(fileHash));
  const claudeEnvironment = await scratchClaudeConfig(workspace);
  const real = await realCourt(workspace);
  const claude = "shadow-pievidence-f5claude";
  const pi = "shadow-pievidence-f5pi";
  const claudeWord = newWord("CLAUDEWORD");
  const piWord = newWord("PIWORD");
  try {
    await workspace.writeUserConfig(
      (await readFile(path.join(workspace.dataHome, "config", "config.user.ts"), "utf8")).replaceAll("{ harness: 'pi', model: 'pro' }, { harness: 'claude', model: 'opus' }", "{ harness: 'pi', model: 'pro' }, { harness: 'claude', model: 'haiku' }, { harness: 'claude', model: 'opus' }"),
    );
    const claudeCreated = await workspace.throneCliFromLiveRoot(
      ["create-agent", "--model", "haiku", "--role", "Shadow", "--name", claude, "--supervisor", SUPERVISOR, "--non-campaign", "--cwd", workspace.repository, "--prompt", "reply with only the word READY"],
      claudeEnvironment,
    );
    await workspace.saveText(`create-agent-${claude}.txt`, `exit ${claudeCreated.code}\n${claudeCreated.stdout}\n${claudeCreated.stderr}`);
    const piCreated = await workspace.createPiAgent(pi, "pi/flash", undefined, workspace.repository, { prompt: "reply with only the word READY" });
    const claudePane = await paneOf(real.herdr, claude);
    const piPane = await paneOf(real.herdr, pi);
    const piBefore = await piProcessesIn(real.herdr, piPane);
    await pause(30_000);
    for (const [name, word] of [[claude, claudeWord], [pi, piWord]]) {
      const sent = await workspace.throneCliFromLiveRoot(["send-agent", name, `reply with only the word ${word}`, "--sender-name", SUPERVISOR], { HOME: workspace.claudeTranscriptHome, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config") });
      await workspace.saveText(`send-agent-${name}.txt`, `exit ${sent.code}\n${sent.stdout}\n${sent.stderr}`);
    }
    const claudeAnswered = claudePane === undefined ? { found: false } : await pollUntil(() => real.herdr.readPane(claudePane), (text) => text.split(claudeWord).length - 1 >= 2, 180_000, 2000);
    const piAnswered = await pollUntil(() => sessionText(workspace, pi), (text) => text.split(piWord).length - 1 >= 2, 180_000, 2000);
    const claudeText = claudePane === undefined ? "" : await real.herdr.savePane(claudePane, `pane-${claude}.txt`);
    if (piPane !== undefined) await real.herdr.savePane(piPane, `pane-${pi}.txt`);
    const piText = await sessionText(workspace, pi);
    const crossed = [claudeText.includes(piWord) && `${claude} got ${piWord}`, piText.includes(claudeWord) && `${pi} got ${claudeWord}`].filter(Boolean);
    const tokens = await tokensOf(workspace, pi);
    await workspace.throneCliFromLiveRoot(["my-state", "reapable", "completed"], { THRONE_AGENT_NAME: pi, HERDR_PANE_ID: piPane ?? "" });
    await workspace.throneCliFromLiveRoot(["my-state", "reapable", "completed"], { THRONE_AGENT_NAME: claude, HERDR_PANE_ID: claudePane ?? "" });
    const piReaped = await reap(workspace, pi, undefined, undefined);
    const claudeReaped = await reap(workspace, claude, undefined, undefined);
    await real.restartBackend();
    const piLeft = await nothingLeft(workspace, real.herdr, pi, piPane, undefined, piBefore);
    const after = await Promise.all(guarded.map(fileHash));
    const configUntouched = before.every((hash, index) => hash === after[index]);
    const passed = claudeCreated.code === 0 && piCreated.code === 0 && claudeAnswered.found && piAnswered.found && crossed.length === 0 && piReaped === 0 && claudeReaped === 0 && piLeft.clean && configUntouched;
    return {
      verdict: passed ? "PASS" : "FAIL",
      tokens,
      observed:
        `create-agent exits: claude/haiku ${claudeCreated.code}, pi/flash ${piCreated.code}; Claude answered its word: ${claudeAnswered.found}; pi answered its word: ${piAnswered.found}; ` +
        `crossed messages: ${crossed.join(", ") || "none"}; complete-agent exits: pi ${piReaped}, claude ${claudeReaped}; after the backend restart: pi ${piLeft.said}; ` +
        `real ~/.claude/settings.json unchanged: ${configUntouched}`,
    };
  } finally {
    await real.stop();
  }
}

async function launchRefusedWithoutTheAccount(workspace) {
  const real = await realCourt(workspace);
  try {
    const hidden = `${real.keyFile}.removed`;
    await rename(real.keyFile, hidden);
    const refused = await workspace.createPiAgent("shadow-pievidence-f6refused", "pi/flash", undefined, workspace.repository, { prompt: "say hello" });
    const refusal = `${refused.stdout}${refused.stderr}`;
    const namesAccount = /deepseek/i.test(refusal) && /account|key/i.test(refusal);
    const nothingLaunched = (await paneOf(real.herdr, "shadow-pievidence-f6refused")) === undefined;
    await rename(hidden, real.keyFile);
    const restored = await shadowDoesATask(workspace, real, "shadow-pievidence-f6", "pi/flash");
    const backendLeak = await backendOutputHoldsKey(workspace, real.key);
    const keyFoundIn = [...restored.keyFoundIn, ...(backendLeak ? ["backend journal"] : []), ...(refusal.includes(real.key) ? ["refusal text"] : [])];
    const passed = refused.code !== 0 && namesAccount && nothingLaunched && restored.passed && keyFoundIn.length === 0;
    return {
      verdict: passed ? "PASS" : "FAIL",
      tokens: restored.tokens,
      observed:
        `account removed: create-agent exit ${refused.code}, message names the account: ${namesAccount} ("${refusal.trim().split("\n").at(-1)?.slice(0, 160) ?? ""}"), nothing launched: ${nothingLaunched}; ` +
        `account restored: ${restored.said}; key found in: ${keyFoundIn.join(", ") || "none of cmdline, spawn.json, pane text, backend journal"}`,
    };
  } finally {
    await real.stop();
  }
}

export const lines = [
  { id: "F1", needsPane: true, realProvider: true, run: shadowFlow("shadow-pievidence-f1", "pi/flash") },
  { id: "F2", needsPane: true, realProvider: true, run: shadowFlow("shadow-pievidence-f2", "pi/pro") },
  { id: "F3", needsPane: true, realProvider: true, run: alphaSpawnsAShadow },
  { id: "F4", needsPane: true, realProvider: true, run: waitingAgentIsWokenOnce },
  { id: "F5", needsPane: true, realProvider: true, run: claudeAndPiShadowsGetOnlyTheirOwn },
  { id: "F6", needsPane: true, realProvider: true, run: launchRefusedWithoutTheAccount },
];
