import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { NOT_OURS_EMPTY } from "../../scripts/spec-behaviour-evidence-fixture.mjs";
import { makeSpecFixture, type SpecFixture } from "../feature-map/spec-fixture.test-support.ts";
import { runSpecLock } from "./run-spec-lock.ts";

interface Writer {
  readonly exitCode: Promise<number>;
  readonly output: () => string;
  release(): void;
}

function startWriter(fixture: SpecFixture, name: string, processId: number): Writer {
  let output = "";
  let release = (): void => undefined;
  const exitCode = runSpecLock(["--repository", fixture.repositories[NOT_OURS_EMPTY] as string, "--ttl", "1m"], {
    environment: { THRONE_DATA_HOME: fixture.dataHome },
    processId,
    now: () => new Date("2026-01-01T00:00:00Z"),
    currentAgentName: async () => name,
    waitForRelease: () => new Promise<void>((resolve) => (release = resolve)),
    writeStdout: (text) => void (output += text),
    writeStderr: (text) => void (output += text),
  });
  return { exitCode, output: () => output, release: () => release() };
}

async function lockedFolderOf(writer: Writer): Promise<string> {
  while (!writer.output().includes("locked by")) await new Promise((resolve) => setTimeout(resolve, 10));
  return /folder: (.+)\n/.exec(writer.output())?.[1] as string;
}

test("a second writer to the same external spec is refused naming the holder, and neither loses its change", async (t) => {
  const fixture = await makeSpecFixture();
  t.after(() => fixture.remove());

  const first = startWriter(fixture, "shadow-bakery-01", 101);
  const folder = await lockedFolderOf(first);
  await writeFile(path.join(folder, "first.md"), "first writer\n");
  const refused = startWriter(fixture, "shadow-bakery-02", 202);
  assert.equal(await refused.exitCode, 1);
  assert.match(refused.output(), /locked by shadow-bakery-01 \(process 101\) until 2026-01-01T00:01:00\.000Z/);
  first.release();
  assert.equal(await first.exitCode, 0);

  const second = startWriter(fixture, "shadow-bakery-02", 202);
  assert.equal(await lockedFolderOf(second), folder);
  await writeFile(path.join(folder, "second.md"), "second writer\n");
  second.release();
  assert.equal(await second.exitCode, 0);

  assert.deepEqual(
    [await readFile(path.join(folder, "first.md"), "utf8"), await readFile(path.join(folder, "second.md"), "utf8")],
    ["first writer\n", "second writer\n"],
  );
  assert.ok(folder.startsWith(path.join(fixture.dataHome, "specs")));
  const status = await promisify(execFile)("git", ["status", "--porcelain", "--ignored"], { cwd: fixture.repositories[NOT_OURS_EMPTY] });
  assert.equal(status.stdout, "");
});

test("the spec lock refuses a call that names no repository", async () => {
  let output = "";
  const exitCode = await runSpecLock(["--ttl", "1m"], {
    environment: {},
    processId: 1,
    now: () => new Date(),
    currentAgentName: async () => "nobody",
    waitForRelease: async () => undefined,
    writeStdout: (text) => void (output += text),
    writeStderr: (text) => void (output += text),
  });
  assert.equal(exitCode, 2);
  assert.match(output, /name the repository/);
});
