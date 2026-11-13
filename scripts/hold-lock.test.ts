import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isHeldByAnother, tryTakeLock } from "../src/shared-policy/lock-rows/lock-rows.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const holdLockScript = path.join(repositoryRoot, "scripts", "hold-lock.mjs");
const children: ChildProcess[] = [];
const scratchFolders: string[] = [];

test.after(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(scratchFolders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function scratchFolder(prefix: string): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), prefix));
  scratchFolders.push(folder);
  return folder;
}

function start(command: string, commandArgs: string[], environment: NodeJS.ProcessEnv) {
  const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...environment } });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const firstLine = new Promise<string>((resolve) => {
    const check = () => (stdout.includes("\n") ? resolve(stdout.split("\n")[0]!) : setTimeout(check, 20));
    check();
  });
  return { child, exited, firstLine, stderr: () => stderr };
}

test("a lock held through hold-lock frees when its holder is killed", async () => {
  const throneHome = await scratchFolder("hold-lock-");
  const run = start(
    process.execPath,
    [holdLockScript, "shared-thing", "--", process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
    { THRONE_DATA_HOME: throneHome },
  );
  const commandProcessId = Number(await run.firstLine);
  test.after(() => {
    try {
      process.kill(commandProcessId, "SIGKILL");
    } catch {
      return;
    }
  });

  run.child.kill("SIGKILL");
  await run.exited;
  assert.equal(isHeldByAnother(throneHome, "shared-thing"), true);

  process.kill(commandProcessId, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.notEqual(tryTakeLock(throneHome, "shared-thing"), null);
});

test("hold-lock exits with the code of the command it ran", async () => {
  const throneHome = await scratchFolder("hold-lock-");
  const run = start(process.execPath, [holdLockScript, "shared-thing", "--", process.execPath, "-e", "process.exit(5)"], {
    THRONE_DATA_HOME: throneHome,
  });
  assert.equal(await run.exited, 5);
  assert.equal(isHeldByAnother(throneHome, "shared-thing"), false);
});

async function checkoutWithoutBuild(): Promise<{ checkout: string; buildLog: string; fakeBin: string }> {
  const checkout = await scratchFolder("throne-cli-first-use-");
  await mkdir(path.join(checkout, "bin"));
  await copyFile(path.join(repositoryRoot, "bin", "throne-cli"), path.join(checkout, "bin", "throne-cli"));
  await writeFile(path.join(checkout, "bin", "throne-runtime"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  await symlink(path.join(repositoryRoot, "scripts"), path.join(checkout, "scripts"));
  await mkdir(path.join(checkout, "node_modules"));
  const buildLog = path.join(checkout, "build.log");
  const fakeBin = path.join(checkout, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(
    path.join(fakeBin, "npm"),
    [
      "#!/bin/sh",
      `echo start >> "${buildLog}"`,
      "sleep 1",
      'mkdir -p dist/src && echo "console.log(\'built\')" > dist/src/tools.js',
      `echo end >> "${buildLog}"`,
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  return { checkout, buildLog, fakeBin };
}

test("two first-use builds of one checkout do not run at once", async () => {
  const throneHome = await scratchFolder("hold-lock-");
  const { checkout, buildLog, fakeBin } = await checkoutWithoutBuild();
  const environment = { THRONE_DATA_HOME: throneHome, PATH: `${fakeBin}:${process.env.PATH}` };
  const first = start(path.join(checkout, "bin", "throne-cli"), ["anything"], environment);
  const second = start(path.join(checkout, "bin", "throne-cli"), ["anything"], environment);

  assert.equal(await first.exited, 0, first.stderr());
  assert.equal(await second.exited, 0, second.stderr());
  assert.deepEqual((await readFile(buildLog, "utf8")).trim().split("\n"), ["start", "end"]);
});
