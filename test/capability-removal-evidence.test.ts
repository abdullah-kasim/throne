import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { keptHelperAnswers } from "../scripts/capability-removal-evidence/kept-helpers.ts";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EVIDENCE_TOOL = path.join(REPO_ROOT, "scripts", "capability-removal-evidence", "run.mjs");
const BEFORE_FOLDER = path.join(REPO_ROOT, "test", "fixtures", "capability-removal-evidence", "before");
const outFolders: string[] = [];

after(async () => {
  await Promise.all(outFolders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function recordedBefore(lineId: string): Promise<{ recorded_from: string; answers: unknown[] }> {
  return JSON.parse(await readFile(path.join(BEFORE_FOLDER, `${lineId}.json`), "utf8"));
}

async function evidenceLog(argumentsList: string[]): Promise<{ run_seconds: number; lines: Array<Record<string, unknown>> }> {
  const out = await mkdtemp(path.join(os.tmpdir(), "capability-removal-evidence-test-"));
  outFolders.push(out);
  await runFile(process.execPath, [EVIDENCE_TOOL, ...argumentsList, "--out", out], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 }).catch(() => undefined);
  return JSON.parse(await readFile(path.join(out, "capability-removal-evidence.json"), "utf8"));
}

test("the effort levels a model accepts and its same-tier name on another harness answer as they did before capability grades were removed", async () => {
  const before = await recordedBefore("C4.1");
  assert.deepEqual(JSON.parse(JSON.stringify(keptHelperAnswers())), before.answers);
});

test("every role still launches, an out-of-pool model and an out-of-range effort are still refused, as recorded before the removal", async () => {
  const log = await evidenceLog(["--line", "C1.2", "--line", "C1.3", "--line", "C1.4"]);
  for (const line of log.lines) {
    assert.equal(line.verdict, "PASS", `${line.line}: ${line.observed} ${line.error ?? ""}`);
    assert.equal(line.error, null);
    assert.equal(typeof line.seconds, "number");
  }
  assert.equal(typeof log.run_seconds, "number");
});

test("the skills, docs, AGENTS.md and CLAUDE.md name no capability floor, grade, score or non-coding requirement except in dated history notes", async () => {
  const log = await evidenceLog(["--line", "C5.1"]);
  assert.equal(log.lines[0]?.verdict, "PASS", String(log.lines[0]?.observed));
});
