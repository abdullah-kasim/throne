import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const LAUNCHER_LIBRARY = path.join(import.meta.dirname, "..", "bin", "agent-launcher-lib.sh");
const scratchDirectories: string[] = [];

after(async () => {
  await Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Machine {
  home: string;
  throneRoot: string;
  repairLog: string;
}

async function machine(repairExitCode: number): Promise<Machine> {
  const scratch = await mkdtemp(path.join(tmpdir(), "launch-check-"));
  scratchDirectories.push(scratch);
  const home = path.join(scratch, "home");
  const throneRoot = path.join(scratch, "throne");
  const repairLog = path.join(scratch, "repair.log");
  await mkdir(path.join(home, ".claude", "skills", "share-stuff"), { recursive: true });
  await writeFile(path.join(home, ".claude", "skills", "share-stuff", "SKILL.md"), "");
  await mkdir(path.join(throneRoot, ".git"), { recursive: true });
  await mkdir(path.join(throneRoot, "claude-hooks"), { recursive: true });
  await mkdir(path.join(throneRoot, "bin"), { recursive: true });
  await mkdir(path.join(throneRoot, ".claude"), { recursive: true });
  await mkdir(path.join(throneRoot, ".codex"), { recursive: true });
  await writeFile(path.join(throneRoot, "claude-hooks", "scratch-path-guard.py"), "");
  await writeFile(path.join(throneRoot, "claude-hooks", "skill-write-guard.py"), "");
  await writeFile(path.join(throneRoot, ".claude", "skill-dependencies.tsv"), "share-stuff\tglobal\nloop\tharness\n");
  const repairCommand = path.join(throneRoot, "bin", "throne-cli");
  await writeFile(repairCommand, `#!/bin/bash\necho "$*" >> "${repairLog}"\nexit ${repairExitCode}\n`);
  await chmod(repairCommand, 0o755);
  return { home, throneRoot, repairLog };
}

async function registerEveryHook(target: Machine): Promise<void> {
  const hooks = ["scratch-path-guard.py", "skill-write-guard.py"].map(
    (name) => `python3 \\"${path.join(target.throneRoot, "claude-hooks", name)}\\"`,
  );
  await writeFile(path.join(target.home, ".claude", "settings.json"), `{"hooks": "${hooks.join(" ")}"}\n`);
  await writeFile(
    path.join(target.throneRoot, ".codex", "hooks.json"),
    `{"command": "${target.throneRoot}/bin/throne-cli throne-startup"}\n`,
  );
}

async function launchCheck(target: Machine): Promise<{ stderr: string; repairs: string }> {
  const { stderr } = await run(
    "bash",
    ["-c", `source "${LAUNCHER_LIBRARY}" && throne_launch_check claudey "$1" && echo launched >&2`, "launch-check", target.throneRoot],
    { env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: target.home } },
  );
  const repairs = await readFile(target.repairLog, "utf8").catch(() => "");
  return { stderr, repairs };
}

test("a healthy machine launches silently without starting the repair command", async () => {
  const target = await machine(0);
  await registerEveryHook(target);

  assert.deepEqual(await launchCheck(target), { stderr: "launched\n", repairs: "" });
});

test("a machine missing its hook registrations runs the repair against the launcher's own root", async () => {
  const target = await machine(0);

  const { stderr, repairs } = await launchCheck(target);

  assert.equal(repairs, `ensure-harness-setup --throne-root ${target.throneRoot}\n`);
  assert.match(stderr, /scratch-path-guard\.py is not registered/);
  assert.match(stderr, /codex session start hook is not registered/);
  assert.match(stderr, /launched\n$/);
});

test("a failed repair is reported and the launch still goes ahead", async () => {
  const target = await machine(1);

  const { stderr } = await launchCheck(target);

  assert.match(stderr, /harness hook repair failed; launching anyway/);
  assert.match(stderr, /launched\n$/);
});

test("a missing global skill and a dangling skills link are reported", async () => {
  const target = await machine(0);
  await registerEveryHook(target);
  await rm(path.join(target.home, ".claude", "skills"), { recursive: true });
  await symlink(path.join(target.home, "nowhere"), path.join(target.home, ".claude", "skills"));

  const { stderr, repairs } = await launchCheck(target);

  assert.equal(repairs, "");
  assert.match(stderr, /\.claude\/skills is a link that resolves to nothing/);
  assert.match(stderr, /expects the global skill share-stuff/);
  assert.doesNotMatch(stderr, /\bloop\b/);
});

test("a launcher running from a linked worktree never repairs the live settings", async () => {
  const target = await machine(0);
  await rm(path.join(target.throneRoot, ".git"), { recursive: true });
  await writeFile(path.join(target.throneRoot, ".git"), "gitdir: /elsewhere\n");

  const { stderr, repairs } = await launchCheck(target);

  assert.equal(repairs, "");
  assert.equal(stderr, "launched\n");
});
