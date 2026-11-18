import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { THRONE_ROOT, pollUntil, runStandInPi } from "../support.mjs";
import { THRONE_DATA_DIR } from "../../../src/shared-policy/throne-home.ts";
import { installPiStateExtensions } from "../../../src/herdr/pi-state-install.ts";
import { claudeHookInstallers, readHookList } from "../../../src/install-services/claude-hooks.ts";

const FINISHED = "hook evidence turn finished";

function toolResultTexts(body) {
  const messages = body.messages ?? [];
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  return messages.slice(lastUser + 1).filter((message) => message.role === "tool").map((message) =>
    typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join(""));
}

function toolCall(name, input) {
  return { toolCalls: [{ id: `call-${randomUUID()}`, name, arguments: JSON.stringify(input) }] };
}

function scriptedPlan(calls) {
  const seen = [];
  const plannedReply = (body) => {
    const results = toolResultTexts(body);
    if (results.length > seen.length) seen.push(...results.slice(seen.length));
    const next = calls[results.length];
    return next === undefined ? { text: FINISHED } : toolCall(next.name, next.input);
  };
  return { plannedReply, seen };
}

async function launchHookPi(workspace, calls) {
  const plan = scriptedPlan(calls);
  const provider = await workspace.standIn({ plannedReply: plan.plannedReply });
  const agentDirectory = await workspace.piAgentDirectory(provider.baseUrl);
  await installPiStateExtensions(agentDirectory);
  const herdr = await workspace.herdr();
  const paneId = await herdr.openPane(workspace.repository);
  await runStandInPi(workspace, herdr, paneId, agentDirectory, {
    THRONE_AGENT_NAME: "shadow-pievidence-hooks",
  });
  const ready = await herdr.waitForPi(paneId, "deepseek-flash");
  if (!ready.found) throw new Error(`pi never drew its footer naming deepseek-flash: ${ready.cause}`);
  const runTurn = async (task) => {
    await herdr.typeAndSubmit(paneId, task);
    await herdr.waitForPaneText(paneId, (text) => text.includes(FINISHED), 60_000);
    await herdr.savePane(paneId, "pane-after-turn.txt");
    await workspace.saveText("tool-results.json", `${JSON.stringify(plan.seen, null, 2)}\n`);
    return plan.seen;
  };
  const bridgeLog = async () => readFile(path.join(path.dirname(agentDirectory), "pi-hook-bridge.log"), "utf8").catch(() => "");
  return { provider, runTurn, bridgeLog, agentDirectory };
}

async function withHookPi(workspace, calls, judge) {
  const pi = await launchHookPi(workspace, calls);
  try {
    return await judge(await pi.runTurn("hook evidence: run the planned calls"), pi);
  } finally {
    await pi.provider.close();
  }
}

async function scratchGuardOnPi(workspace) {
  const marker = `hook-scratch-${randomUUID()}`;
  const homeScratch = path.join(os.homedir(), "tmp", marker);
  await mkdir(homeScratch, { recursive: true });
  return withHookPi(workspace, [
    { name: "bash", input: { command: `touch /tmp/${marker}` } },
    { name: "bash", input: { command: `rm -rf ${homeScratch.replace(os.homedir(), "~")} && echo removed-${marker}` } },
  ], async ([sharedTmp, homeTmp]) => {
    const blocked = /under the shared \/tmp/.test(sharedTmp ?? "") && !/removed-/.test(sharedTmp ?? "");
    const allowed = (homeTmp ?? "").includes(`removed-${marker}`);
    return { verdict: blocked && allowed ? "PASS" : "FAIL", observed: `bash touch /tmp: "${(sharedTmp ?? "").slice(0, 160)}"; rm -rf ~/tmp/x: "${(homeTmp ?? "").slice(0, 80)}"` };
  });
}

async function skillWriteGuardOnPi(workspace) {
  const skillFile = path.join(workspace.repository, ".claude", "skills", "demo", "SKILL.md");
  await mkdir(path.dirname(skillFile), { recursive: true });
  const scrubList = await readFile(path.join(THRONE_ROOT, "publish-scrub.sed"), "utf8");
  const privateTerm = scrubList.split("\n").map((line) => line.match(/^# verify: ([A-Za-z]+)$/)?.[1]).find(Boolean);
  return withHookPi(workspace, [
    { name: "write", input: { path: skillFile, content: `# Demo\n\nUse ${privateTerm} here.\n` } },
  ], async ([result]) => ({
    verdict: /skill-write-guard: line \d+ matches a banned pattern/.test(result ?? "") ? "PASS" : "FAIL",
    observed: `write of SKILL.md with a publish-scrub term: "${(result ?? "").slice(0, 200)}"`,
  }));
}

async function memoryReadLogOnPi(workspace) {
  const memoryFile = path.join(workspace.repository, "agent_docs", "MEMORY", `PI_HOOK_${randomUUID().slice(0, 8)}.md`);
  await mkdir(path.dirname(memoryFile), { recursive: true });
  await writeFile(memoryFile, "a pi hook evidence memory\n");
  const readLog = path.join(THRONE_DATA_DIR, "recall", "memory-reads.jsonl");
  return withHookPi(workspace, [{ name: "read", input: { path: memoryFile } }], async () => {
    const found = await pollUntil(async () => (await readFile(readLog, "utf8").catch(() => "")).split("\n").filter((line) => line.includes(memoryFile)), (lines) => lines.length > 0, 10_000, 250);
    await workspace.saveText("memory-read-lines.txt", `${found.value.join("\n")}\n`);
    return { verdict: found.value.length > 0 ? "PASS" : "FAIL", observed: `${found.value.length} line(s) in ${readLog} naming ${path.basename(memoryFile)}: ${found.value[0]?.slice(0, 200) ?? "none"}` };
  });
}

async function webFetchPointerOnPi(workspace) {
  const address = `https://httpbin.org/status/403?hook-probe=${randomUUID().slice(0, 8)}`;
  return withHookPi(workspace, [
    { name: "bash", input: { command: `curl -s -o /dev/null -w '%{http_code}' --max-time 10 '${address}'` } },
  ], async ([result]) => ({
    verdict: /agent-browser open/.test(result ?? "") ? "PASS" : "FAIL",
    observed: `curl to a public 403: "${(result ?? "").slice(0, 220)}"`,
  }));
}

async function newHookReachesBothHarnesses(workspace) {
  const marker = `throwaway-${randomUUID().slice(0, 8)}`;
  const scriptName = `${marker}.py`;
  const scriptPath = path.join(THRONE_ROOT, "claude-hooks", scriptName);
  const listPath = path.join(THRONE_ROOT, "claude-hooks", "hooks.json");
  const original = await readFile(listPath, "utf8");
  await writeFile(scriptPath, `import json\nprint(json.dumps({"hookSpecificOutput": {"additionalContext": "${marker} ran"}}))\n`);
  await writeFile(listPath, `${JSON.stringify([...JSON.parse(original), { script: scriptName, event: "PostToolUse", matcher: "Bash" }], null, 2)}\n`);
  try {
    const settingsPath = path.join(workspace.scratch, "settings.json");
    await writeFile(settingsPath, "{}\n");
    const installer = claudeHookInstallers(readHookList(THRONE_ROOT)).find((candidate) => candidate.name === marker.replaceAll("-", " "));
    const outcome = await installer.install(
      { claudeSettingsPath: () => settingsPath, readClaudeSettings: (file) => readFile(file, "utf8"), writeClaudeSettings: (file, text) => writeFile(file, text) },
      { throneRoot: THRONE_ROOT },
    ).catch((error) => ({ error: String(error) }));
    const settingsText = await readFile(settingsPath, "utf8");
    await workspace.saveText("scratch-settings.json", settingsText);
    return await withHookPi(workspace, [{ name: "bash", input: { command: "echo hello" } }], async ([result]) => {
      const registered = settingsText.includes(scriptName);
      const ran = (result ?? "").includes(`${marker} ran`);
      return { verdict: registered && ran ? "PASS" : "FAIL", observed: `Claude installer: ${JSON.stringify(outcome).slice(0, 120)}, scratch settings name the script: ${registered}; pi bash result: "${(result ?? "").slice(0, 120)}"` };
    });
  } finally {
    await writeFile(listPath, original);
    await rm(scriptPath, { force: true });
  }
}

async function skippedAndUnmappedEntriesOnPi(workspace) {
  return withHookPi(workspace, [{ name: "bash", input: { command: "echo plain" } }], async ([result], pi) => {
    const log = await pi.bridgeLog();
    await workspace.saveText("pi-hook-bridge.log", log);
    const unmapped = /PostToolUseFailure has no pi event/.test(log);
    const marked = readHookList(THRONE_ROOT).filter((entry) => (entry.notOn ?? []).includes("pi")).map((entry) => entry.script);
    const markedRan = marked.some((script) => log.includes(script) || (result ?? "").includes(script.replace(".py", "")));
    return { verdict: unmapped && !markedRan ? "PASS" : "FAIL", observed: `bridge log: "${log.trim().split("\n").slice(0, 3).join(" | ").slice(0, 300)}"; notOn pi scripts seen running: ${markedRan}` };
  });
}

export const lines = [
  { id: "H1", needsPane: true, run: scratchGuardOnPi },
  { id: "H2", needsPane: true, run: skillWriteGuardOnPi },
  { id: "H3", needsPane: true, run: memoryReadLogOnPi },
  { id: "H4", needsPane: true, run: webFetchPointerOnPi },
  { id: "H5", needsPane: true, run: newHookReachesBothHarnesses },
  { id: "H7", needsPane: true, run: skippedAndUnmappedEntriesOnPi },
];
