import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { criticReply } from "../scripts/capability-removal-evidence/lines/c2.mjs";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const THRONE_CLI = path.join(REPO_ROOT, "bin", "throne-cli");
const folders: string[] = [];

after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function scratchFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "capability-removal-live-fixes-"));
  folders.push(folder);
  return folder;
}

test("the built create-agent --help names --requires as accepted and ignored since 2026-11-15, with no court running", async () => {
  const dataHome = await scratchFolder();
  const { stdout } = await runFile(THRONE_CLI, ["create-agent", "--help"], {
    cwd: dataHome,
    env: { ...process.env, THRONE_DATA_HOME: dataHome, THRONE_HERDR_SESSION_NAME_OVERRIDE: "capability-removal-live-fixes-no-court" },
  });
  const requiresPart = stdout.split("[").find((part) => part.startsWith("--requires")) ?? "";
  assert.match(requiresPart, /accepted and ignored: capability requirements were removed on 2026-11-15/);
});

test("the stand-in critic appends its verdict to the gate file once when given the grading task, and stops after the tool answers", () => {
  const reply = criticReply("/gate.md");
  const asked = { role: "user", content: "GRADE-ONE-LINE C9.9: one plus one is two" };
  const first = reply({ messages: [asked] });
  assert.equal(first.toolCalls?.[0]?.name, "bash");
  assert.match(JSON.parse(first.toolCalls[0].arguments).command, /C9\.9 PASS.*>> '\/gate\.md'/);
  assert.deepEqual(reply({ messages: [asked, { role: "tool", content: "" }] }), { text: "graded" });
  assert.deepEqual(reply({ messages: [{ role: "user", content: "hello" }] }), { text: "graded" });
});
