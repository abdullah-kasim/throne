import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ownedHerdrClientPath } from "../src/herdr/herdr-client.ts";
import {
  launchHerdrSuiteSession,
  resolveHerdrSuiteSocketPath,
  runSuiteInsideHerdrSession,
} from "./herdr-suite-session.mjs";

const execFileAsync = promisify(execFile);

async function pathIsAbsent(targetPath: string): Promise<boolean> {
  return stat(targetPath).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;
      throw error;
    },
  );
}

test("an isolated temporary herdr session answers and tears down after a suite failure", async () => {
  const configHome = await mkdtemp(path.join(os.tmpdir(), "herdr-suite-"));
  const runId = `l-${randomBytes(4).toString("hex")}`;
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  let sessionHandle:
    Awaited<ReturnType<typeof launchHerdrSuiteSession>> | undefined;

  try {
    sessionHandle = await launchHerdrSuiteSession(runId, env);
    const { stdout } = await execFileAsync(
      ownedHerdrClientPath(),
      ["--session", sessionHandle.sessionName, "status", "server", "--json"],
      { env },
    );
    assert.equal(JSON.parse(stdout).running, true);
    throw new Error("simulated suite failure after using the isolated session");
  } catch (error) {
    assert.match(
      error instanceof Error ? error.message : String(error),
      /simulated suite failure/,
    );
  } finally {
    await sessionHandle?.cleanup();
  }

  assert.equal(
    await pathIsAbsent(
      resolveHerdrSuiteSocketPath(configHome, sessionHandle!.sessionName),
    ),
    true,
  );
  await rm(configHome, { recursive: true, force: true });
});

test("a failed suite command tears down its isolated herdr session", async () => {
  const configHome = await mkdtemp(path.join(os.tmpdir(), "herdr-suite-"));
  const runId = `f-${randomBytes(4).toString("hex")}`;
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };

  try {
    const status = await runSuiteInsideHerdrSession(
      runId,
      [process.execPath, "--eval", "process.exit(23)"],
      env,
    );

    assert.equal(status, 23);
    assert.equal(
      await pathIsAbsent(
        resolveHerdrSuiteSocketPath(configHome, `throne-suite-${runId}`),
      ),
      true,
    );
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});
