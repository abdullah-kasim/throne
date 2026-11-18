import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { environmentWithoutTheLiveCourt, runCommand } from "../pi-evidence/support.mjs";

export { runCommand };

export const THRONE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const THRONE_CLI_PATH = path.join(THRONE_ROOT, "bin", "throne-cli");
export const COMMITTED_DEFAULT_CONFIG = path.join(THRONE_ROOT, "config.user.example.ts");
export const BEFORE_FOLDER = path.join(THRONE_ROOT, "test", "fixtures", "capability-removal-evidence", "before");
const PROBE_FOLDER = path.dirname(fileURLToPath(import.meta.url));
const LIVE_HERDR_SESSION_NAME = "throne";
const RECORDED_TIME = "<time>";
const SPAWN_TIME_FIELDS = ["spawned_at", "spawn_finished_at", "tasked_at"];
const FIELD_THIS_ROW_REMOVES = "capability";
const NTFY_HEALTH_LINE = /^ntfy: .*$/gm;

const MAIN_CHECKOUT_LINE = /^worktree (.+)$/m;

export async function liveUserConfigPath() {
  const listed = await runCommand("git", ["-C", THRONE_ROOT, "worktree", "list", "--porcelain"]);
  const mainCheckout = listed.stdout.match(MAIN_CHECKOUT_LINE)?.[1] ?? THRONE_ROOT;
  return path.join(mainCheckout, "config.user.ts");
}

export function beforePath(lineId) {
  return path.join(BEFORE_FOLDER, `${lineId}.json`);
}

export async function readBefore(lineId) {
  try {
    return JSON.parse(await readFile(beforePath(lineId), "utf8"));
  } catch {
    return null;
  }
}

export async function recordBefore(lineId, answers) {
  const head = await runCommand("git", ["-C", THRONE_ROOT, "rev-parse", "HEAD"]);
  await mkdir(BEFORE_FOLDER, { recursive: true });
  await writeFile(beforePath(lineId), `${JSON.stringify({ recorded_from: head.stdout.trim(), answers }, null, 2)}\n`);
}

export function withoutVolatileText(text, scratch) {
  return text.replaceAll(scratch, "<scratch>").replaceAll(THRONE_ROOT, "<throne-root>").replace(NTFY_HEALTH_LINE, "ntfy: <health>");
}

export function comparableSpawnRecord(record) {
  if (record === null) return null;
  const kept = Object.fromEntries(Object.entries(record).filter(([key]) => key !== FIELD_THIS_ROW_REMOVES));
  for (const field of SPAWN_TIME_FIELDS) if (kept[field] !== undefined && kept[field] !== null) kept[field] = RECORDED_TIME;
  return kept;
}

export function sameAnswers(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function firstDifference(observed, before) {
  for (let index = 0; index < Math.max(observed.length, before.length); index++) {
    if (!sameAnswers(observed[index], before[index])) return { index, observed: observed[index] ?? null, before: before[index] ?? null };
  }
  return null;
}

export async function compareWithBefore(lineId, answers, workspace, options) {
  await workspace.saveText(`${lineId}-observed.json`, `${JSON.stringify(answers, null, 2)}\n`);
  if (options.recordBefore) {
    await recordBefore(lineId, answers);
    return { verdict: "NOT VERIFIED", observed: `recorded ${answers.length} answers as the before fixture; run again without --record-before to compare`, before: beforePath(lineId) };
  }
  const before = await readBefore(lineId);
  if (before === null) return { verdict: "NOT VERIFIED", observed: `no before fixture at ${beforePath(lineId)}`, before: null };
  const difference = firstDifference(answers, before.answers);
  return difference === null
    ? { verdict: "PASS", observed: `${answers.length} answers equal the before fixture recorded from ${before.recorded_from}`, before: beforePath(lineId) }
    : { verdict: "FAIL", observed: `answer ${difference.index} differs: ${JSON.stringify(difference)}`, before: beforePath(lineId) };
}

export async function createLineWorkspace(lineDirectory) {
  await mkdir(path.join(os.homedir(), "tmp"), { recursive: true });
  const scratch = await mkdtemp(path.join(os.homedir(), "tmp", "capability-removal-evidence-"));
  const dataHome = path.join(scratch, "throne-home");
  const liveRoot = path.join(scratch, "live-root");
  const agentCwd = path.join(scratch, "agent-cwd");
  await Promise.all([path.join(dataHome, "config"), liveRoot, agentCwd].map((folder) => mkdir(folder, { recursive: true })));
  const herdrSessionName = `capability-removal-evidence-${randomBytes(4).toString("hex")}`;
  if (herdrSessionName === LIVE_HERDR_SESSION_NAME) throw new Error("refusing the live herdr session");
  const savedFiles = [];

  const workspace = {
    scratch,
    dataHome,
    agentCwd,
    environment() {
      return {
        ...environmentWithoutTheLiveCourt(process.env),
        THRONE_DATA_HOME: dataHome,
        THRONE_LIVE_ROOT: liveRoot,
        THRONE_HERDR_SESSION_NAME_OVERRIDE: herdrSessionName,
      };
    },
    async useConfig(sourcePath) {
      await copyFile(sourcePath, path.join(dataHome, "config", "config.user.ts"));
    },
    async writeConfig(text) {
      await writeFile(path.join(dataHome, "config", "config.user.ts"), text);
    },
    async throneCli(argumentsList) {
      const result = await runCommand(THRONE_CLI_PATH, argumentsList, { env: workspace.environment(), cwd: agentCwd });
      return { code: result.code, stdout: withoutVolatileText(result.stdout, scratch), stderr: withoutVolatileText(result.stderr, scratch) };
    },
    async probe(scriptName, argumentsList = []) {
      const result = await runCommand(process.execPath, [path.join(PROBE_FOLDER, scriptName), ...argumentsList], { env: workspace.environment(), cwd: THRONE_ROOT });
      if (result.code !== 0) throw new Error(`${scriptName} exited ${result.code}: ${result.stderr}`);
      return JSON.parse(withoutVolatileText(result.stdout, scratch));
    },
    async createAgent(argumentsList) {
      const outcome = await workspace.probe("create-agent-court.ts", [...argumentsList, "--cwd", agentCwd]);
      return { ...outcome, spawn: comparableSpawnRecord(outcome.spawn) };
    },
    async saveText(name, text) {
      const filePath = path.join(lineDirectory, name);
      await writeFile(filePath, text);
      savedFiles.push(filePath);
      return filePath;
    },
    evidence() {
      return { captures: [...savedFiles] };
    },
    async close() {
      await rm(scratch, { recursive: true, force: true });
    },
  };
  return workspace;
}
