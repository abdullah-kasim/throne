import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PLATFORMS = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
const scratchRoot = await mkdtemp(path.join(tmpdir(), "search-tools-shims-test-"));
let scratchCount = 0;

after(() => rm(scratchRoot, { recursive: true, force: true }));

async function makeScratch(name: string): Promise<string> {
  scratchCount += 1;
  const directory = path.join(scratchRoot, `${scratchCount}-${name}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function makeThroneCopy(): Promise<string> {
  const throneRoot = await makeScratch("throne");
  await mkdir(path.join(throneRoot, "bin"));
  await copyFile(path.join(REPO_ROOT, "bin", "rg"), path.join(throneRoot, "bin", "rg"));
  await chmod(path.join(throneRoot, "bin", "rg"), 0o755);
  await symlink("rg", path.join(throneRoot, "bin", "fd"));
  return throneRoot;
}

async function writeFakeTool(folder: string, name: string, output: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, name), `#!/bin/sh\necho '${output}' "$@"\n`);
  await chmod(path.join(folder, name), 0o755);
}

function runShim(shim: string, searchPath: string, args = ["--version"]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shim, args, { env: { PATH: searchPath } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

for (const name of ["rg", "fd"]) {
  test(`bin/${name} runs the vendored ${name} when install.sh has put one in vendor/bin`, async () => {
    const throneRoot = await makeThroneCopy();
    await writeFakeTool(path.join(throneRoot, "vendor", "bin"), name, "vendored");
    await writeFakeTool(path.join(throneRoot, "system-bin"), name, "system");

    const result = await runShim(path.join(throneRoot, "bin", name), `${path.join(throneRoot, "system-bin")}:/usr/bin:/bin`);

    assert.equal(result.stdout, "vendored --version\n", result.stderr);
  });

  test(`bin/${name} without a vendored ${name} skips its own folder and runs the next ${name} on PATH`, async () => {
    const throneRoot = await makeThroneCopy();
    await writeFakeTool(path.join(throneRoot, "system-bin"), name, "system");
    const searchPath = [path.join(throneRoot, "bin"), path.join(throneRoot, "system-bin"), "/usr/bin", "/bin"].join(":");

    const result = await runShim(path.join(throneRoot, "bin", name), searchPath);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "system --version\n");
  });

  test(`bin/${name} skips another throne's bin/${name} on PATH instead of running it back and forth`, async () => {
    const throneRoot = await makeThroneCopy();
    const otherThroneRoot = await makeThroneCopy();
    await writeFakeTool(path.join(throneRoot, "system-bin"), name, "system");
    const searchPath = [path.join(otherThroneRoot, "bin"), path.join(throneRoot, "system-bin"), "/usr/bin", "/bin"].join(":");

    const result = await runShim(path.join(throneRoot, "bin", name), searchPath);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "system --version\n");
  });

  test(`bin/${name} exits 127 naming install.sh when no ${name} exists anywhere`, async () => {
    const throneRoot = await makeThroneCopy();
    const shellOnlyFolder = await makeScratch("shell-only");
    for (const command of ["bash", "basename", "dirname", "readlink"]) {
      const commandPath = (await runShim("/bin/sh", process.env.PATH ?? "/usr/bin:/bin", ["-c", `command -v ${command}`])).stdout.trim();
      await symlink(commandPath, path.join(shellOnlyFolder, command));
    }

    const result = await runShim(path.join(throneRoot, "bin", name), `${path.join(throneRoot, "bin")}:${shellOnlyFolder}`);

    assert.equal(result.code, 127);
    assert.match(result.stderr, new RegExp(`bin/${name}: no vendored ${name} at .*vendor/bin/${name} and none on PATH; run: .*\\./install\\.sh`));
  });
}

test("vendor-pins.json pins ripgrep and fd with an archive and sha256 for each of the four platforms", async () => {
  const pins = JSON.parse(await readFile(path.join(REPO_ROOT, "vendor-pins.json"), "utf8")) as {
    tools: Record<string, { version?: string; binary?: string; releaseUrl?: string; artifacts?: Record<string, { archive?: string; sha256?: string }> }>;
  };
  for (const [name, binary] of [["ripgrep", "rg"], ["fd", "fd"]]) {
    const pin = pins.tools[name];
    assert.match(pin?.version ?? "", /^\d+\.\d+\.\d+$/, name);
    assert.equal(pin?.binary, binary);
    assert.match(pin?.releaseUrl ?? "", /^https:\/\/github\.com\/.+\/releases\/download\//, name);
    assert.deepEqual(Object.keys(pin?.artifacts ?? {}).sort(), [...PLATFORMS].sort(), name);
    for (const platform of PLATFORMS) {
      const artifact = pin?.artifacts?.[platform];
      assert.match(artifact?.archive ?? "", new RegExp(`${pin?.version?.replace(/\./g, "\\.")}.*\\.tar\\.gz$`), `${name} ${platform}`);
      assert.match(artifact?.sha256 ?? "", /^[0-9a-f]{64}$/, `${name} ${platform}`);
    }
  }
});
