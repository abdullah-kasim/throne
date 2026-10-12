import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { configuredEditor, DEFAULT_EDITOR, editorCommandOf, launchEditor } from "./editor-launch.ts";

const runFile = promisify(execFile);
const scratch = await mkdtemp(path.join(os.tmpdir(), "forge-open-editor-"));
await writeFile(path.join(scratch, "package.json"), '{"type":"module"}\n');
after(() => rm(scratch, { recursive: true, force: true }));

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    if (content.endsWith("\n")) return content;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${filePath} was never written`);
}

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

test("the editor is the --editor command, then the configured editor, then VISUAL, then code", async () => {
  const configPath = path.join(scratch, "config.user.ts");
  await writeFile(configPath, "export default { editor: 'zed --wait' };\n");
  const configured = await configuredEditor(configPath);
  const visual = { VISUAL: "nvim" };

  assert.equal(editorCommandOf("cursor", configured, visual), "cursor");
  assert.equal(editorCommandOf(undefined, configured, visual), "zed --wait");
  assert.equal(editorCommandOf(undefined, undefined, visual), "nvim");
  assert.equal(editorCommandOf(undefined, undefined, { VISUAL: " " }), DEFAULT_EDITOR);
  assert.equal(DEFAULT_EDITOR, "code");
});

test("the editor is launched detached and not waited for", async () => {
  const editorScript = path.join(scratch, "slow-editor.sh");
  const record = path.join(scratch, "editor-record.txt");
  await writeFile(editorScript, `#!/bin/sh\necho "$$ $*" > "${record}"\nsleep 30\n`);
  await chmod(editorScript, 0o755);
  const worktree = path.join(scratch, "throne-pr-7");

  await launchEditor(worktree, `"${editorScript}" --new-window`);

  const [processId, ...editorArguments] = (await waitForFile(record)).trim().split(" ");
  const editorProcess = Number(processId);
  try {
    assert.deepEqual(editorArguments, ["--new-window", worktree]);
    assert.ok(isRunning(editorProcess), "the editor is still running after the launch returned");
    const processGroup = (await runFile("ps", ["-o", "pgid=", "-p", processId])).stdout.trim();
    assert.equal(processGroup, processId, "the editor leads its own process group");
  } finally {
    process.kill(-editorProcess, "SIGKILL");
  }
});

test("an editor command that cannot be found is refused naming the command", async () => {
  await assert.rejects(launchEditor(scratch, "no-such-editor-anywhere"), /could not launch the editor "no-such-editor-anywhere"/);
});
