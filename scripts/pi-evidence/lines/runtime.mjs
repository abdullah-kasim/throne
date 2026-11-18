import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { THRONE_ROOT, pollUntil, runCommand } from "../support.mjs";
import { PI_PROVIDER_STAND_IN_MARKER } from "../../../test/support/pi-provider-stand-in/pi-provider-stand-in.mjs";
import { lines as launchLines } from "./launch.mjs";
import { isPiCodingAgentProcess } from "../../../src/harness-routing/harness.ts";

const NODE_LAUNCH_PATTERN = String.raw`(spawn|execFile|execFileSync|spawnSync|exec)\(\s*['"]node['"]|^#!/usr/bin/env node|exec node `;

const THRONE_LAUNCH_PATHS = ["src", "bin", "extensions", "scripts/pi-evidence", ":(exclude)scripts/pi-evidence/lines/runtime.mjs"];

export function findNodeLaunches(repositoryRoot) {
  return runCommand("git", ["-C", repositoryRoot, "grep", "-nE", NODE_LAUNCH_PATTERN, "--", ...THRONE_LAUNCH_PATHS]);
}

async function throneLaunchesNothingOnNode(workspace) {
  const grep = await findNodeLaunches(THRONE_ROOT);
  await workspace.saveText("git-grep-node-launches.txt", `exit ${grep.code}\n${grep.stdout}${grep.stderr}`);
  const launch = launchLines.find((line) => line.id === "P1.1");
  const launched = await launch.run(workspace);
  const herdr = await workspace.herdr();
  const panes = JSON.parse(await herdr.call("pane", "list")).result.panes;
  const processInfo = await herdr.processInfo(panes[panes.length - 1].pane_id);
  await workspace.saveText("pi-pane-process-info.json", `${JSON.stringify(processInfo, null, 2)}\n`);
  const processes = processInfo.foreground_processes ?? [];
  const recognisedAsPi = processes.some((entry) => isPiCodingAgentProcess({ name: entry.name, argv: entry.argv ?? [] }));
  const names = processes.map((entry) => path.basename(String(entry.name ?? "")));
  const nodeSeen = names.includes("node") || processes.some((entry) => path.basename(String((entry.argv ?? [])[0] ?? "")) === "node");
  const bunSeen = names.includes("bun");
  const grepClean = grep.stdout.trim() === "";
  return {
    verdict: grepClean && bunSeen && !nodeSeen && recognisedAsPi && launched.verdict !== "FAIL" ? "PASS" : "FAIL",
    observed: `git grep for node launches: ${grepClean ? "nothing" : grep.stdout.trim()}; pi pane processes: ${names.join(", ") || "none"}; node seen: ${nodeSeen}; recognised as pi: ${recognisedAsPi}`,
  };
}

async function standInAbsentFromDist(workspace) {
  const grep = await runCommand("grep", ["-rl", PI_PROVIDER_STAND_IN_MARKER, path.join(THRONE_ROOT, "dist")]);
  await workspace.saveText("grep-dist-for-stand-in.txt", `exit ${grep.code}\n${grep.stdout}${grep.stderr}`);
  const absent = grep.code === 1 && grep.stdout.trim() === "";
  return {
    verdict: absent ? "PASS" : "FAIL",
    observed: absent ? `grep -rl ${PI_PROVIDER_STAND_IN_MARKER} dist/ found nothing` : `found in: ${grep.stdout.trim() || grep.stderr.trim()}`,
  };
}

const NATIVE_SHADOWS = [
  { name: "shadow-pievidence-claude", harness: "claude", model: "haiku" },
  { name: "shadow-pievidence-codex", harness: "codex", model: "gpt-5.4-mini" },
];
const SIGN_IN_SCREEN = /Sign in with ChatGPT|Select login method|Please run \/login/;
const ANSWER_TIMEOUT_MILLISECONDS = 180_000;

export function answeredWith(paneText, word) {
  return paneText.split(word).length - 1 >= 2;
}

export function nativeShadowsVerdict(outcomes) {
  const answered = (outcome) => outcome.createCode === 0 && outcome.paneFound && outcome.openingAnswered && outcome.sendCode === 0 && outcome.answered;
  if (outcomes.every(answered)) return "PASS";
  if (outcomes.every((outcome) => answered(outcome) || (outcome.createCode === 0 && outcome.signInShown))) return "NOT VERIFIED";
  return "FAIL";
}

async function writeNativeShadowConfig(workspace) {
  const example = await readFile(path.join(THRONE_ROOT, "config.user.example.ts"), "utf8");
  const pool = NATIVE_SHADOWS.map((shadow) => `{ harness: '${shadow.harness}', model: '${shadow.model}' }`).concat("{ harness: 'claude', model: 'opus' }").join(", ");
  await workspace.writeUserConfig(
    example
      .replace(
        "activePlanPresetName: 'OpusOnly',",
        `activePlanPresetName: 'Evidence',\n    customPlanPresets: { Evidence: { alpha: [${pool}], shadow: [${pool}], shadowSlice99: [${pool}] } },`,
      )
      .replace(/  ntfy: \{[^}]*\},\n/, ""),
  );
  const supervisor = path.join(workspace.dataHome, "data", "alpha-pievidence-01");
  await mkdir(supervisor, { recursive: true });
  await writeFile(
    path.join(supervisor, "spawn.json"),
    `${JSON.stringify({ harness: "claude", model: "opus", effort: 3, cwd: workspace.repository, objective_code: "pievidence" })}\n`,
  );
}

function askFor(word) {
  return `reply with only the word ${word}`;
}

async function launchAndAsk(workspace, herdr, shadow) {
  const openingWord = `READY${Math.floor(Math.random() * 1e6)}`;
  const created = await workspace.throneCliFromLiveRoot([
    "create-agent", "--model", shadow.model, "--role", "Shadow", "--name", shadow.name, "--supervisor", "alpha-pievidence-01", "--non-campaign", "--cwd", workspace.repository,
    "--prompt", askFor(openingWord),
  ]);
  await workspace.saveText(`create-agent-${shadow.name}.txt`, `exit ${created.code}\n${created.stdout}\n${created.stderr}`);
  const pane = JSON.parse(await herdr.call("pane", "list")).result.panes.filter((candidate) => candidate.agent === shadow.harness).at(-1);
  const answer = (word) => pane === undefined
    ? Promise.resolve({ found: false })
    : pollUntil(() => herdr.readPane(pane.pane_id), (text) => answeredWith(text, word), ANSWER_TIMEOUT_MILLISECONDS, 2000);
  const openingAnswered = await answer(openingWord);
  const signInShown = pane !== undefined && SIGN_IN_SCREEN.test(await herdr.readPane(pane.pane_id));
  const word = `PONG${Math.floor(Math.random() * 1e6)}`;
  const sent = await workspace.throneCliFromLiveRoot(["send-agent", shadow.name, askFor(word), "--sender-name", "alpha-pievidence-01"]);
  await workspace.saveText(`send-agent-${shadow.name}.txt`, `exit ${sent.code}\n${sent.stdout}\n${sent.stderr}`);
  const answered = sent.code === 0 ? await answer(word) : { found: false };
  if (pane !== undefined) await herdr.savePane(pane.pane_id, `pane-${shadow.name}.txt`);
  return { ...shadow, createCode: created.code, paneFound: pane !== undefined, openingAnswered: openingAnswered.found, signInShown, sendCode: sent.code, answered: answered.found };
}

export async function startTypingBackend(workspace, herdr) {
  const settings = {
    databasePath: path.join(workspace.dataHome, "message-queue.sqlite3"),
    sessionName: herdr.sessionName,
    refusalLog: path.join(workspace.lineDirectory, "herdr-refusals.log"),
    waitMilliseconds: 60_000,
    typing: true,
  };
  let output = "";
  const backend = spawn(process.execPath, [path.join(THRONE_ROOT, "scripts", "pi-evidence", "delivery-backend.mjs"), JSON.stringify(settings)], {
    env: workspace.throneEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.on("data", (part) => (output += part));
  backend.stderr.on("data", (part) => (output += part));
  const ready = await pollUntil(async () => output, (text) => text.includes("backend ready") || backend.exitCode !== null, 30_000);
  if (!ready.value.includes("backend ready")) throw new Error(`the delivery backend did not start: ${output}`);
  return {
    async stop(name = "backend-output.txt") {
      backend.kill("SIGKILL");
      await workspace.saveText(name, output);
    },
  };
}

async function claudeAndCodexShadowsLaunchAndAnswer(workspace) {
  const herdr = await workspace.herdr();
  const backend = await startTypingBackend(workspace, herdr);
  await herdr.call("workspace", "create", "--cwd", workspace.repository, "--no-focus");
  await writeNativeShadowConfig(workspace);
  const outcomes = [];
  try {
    for (const shadow of NATIVE_SHADOWS) outcomes.push(await launchAndAsk(workspace, herdr, shadow));
  } finally {
    await backend.stop();
  }
  return {
    verdict: nativeShadowsVerdict(outcomes),
    observed: `isolated herdr session ${herdr.sessionName}; ` + outcomes.map((outcome) =>
      `${outcome.harness}/${outcome.model}: ${outcome.signInShown ? "not signed in on this host (sign-in screen shown); " : ""}create-agent exit ${outcome.createCode}, pane found: ${outcome.paneFound}, opening prompt answered: ${outcome.openingAnswered}, send-agent exit ${outcome.sendCode}, answered: ${outcome.answered}`,
    ).join("; "),
  };
}

export const lines = [
  { id: "P7.1", needsPane: true, run: throneLaunchesNothingOnNode },
  { id: "P7.2", needsPane: true, realHarnesses: true, run: claudeAndCodexShadowsLaunchAndAnswer },
  { id: "fixture-absent", run: standInAbsentFromDist },
];
