import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openMessageQueueStore } from "../src/message-queue/message-queue.store.ts";
import { openRegentQueueStore } from "../src/regent-queue/regent-queue.store.ts";
import {
  createScratchThroneState,
  readAmbientQueueRowCounts,
  scratchQueuePaths,
  scratchStateDatabaseNames,
} from "./scratch-throne-state.fixture.ts";

const leakGuardPath = path.join(process.cwd(), "scripts/scratch-throne-state-leak-guard.mjs");
const postGuardRunnerPath = path.join(process.cwd(), "scripts/run-suite-post-guards.mjs");

test("isolated durable throne state opens real Regent and message queues without changing ambient queue rows", async () => {
  const before = readAmbientQueueRowCounts();
  const state = await createScratchThroneState();
  const paths = scratchQueuePaths(state);
  const regent = openRegentQueueStore(paths.regent);
  const message = openMessageQueueStore(paths.message);
  try {
    regent.insertItem({ objectiveCode: "thd", body: "scratch state fixture" });
    message.insertWorkItem({ kind: "scratch-state-fixture", payload: { isolated: true } });
    assert.deepEqual(Object.keys(state.environment).includes("THRONE_DATA_HOME"), true);
    assert.ok(paths.regent.startsWith(state.dataHome));
    assert.ok(paths.message.startsWith(state.dataHome));
    assert.deepEqual(scratchStateDatabaseNames(), ["regent-queue.sqlite3", "message-queue.sqlite3"]);
  } finally {
    regent.close();
    message.close();
    await state.cleanup();
  }
  assert.equal(existsSync(state.dataHome), false);
  assert.deepEqual(readAmbientQueueRowCounts(), before);
});

test("isolated durable throne state tears down after a failing fixture path", async () => {
  const state = await createScratchThroneState();
  await assert.rejects(async () => {
    try {
      throw new Error("fixture failure");
    } finally {
      await state.cleanup();
    }
  }, /fixture failure/);
  assert.equal(existsSync(state.dataHome), false);
});

test("recognizable leaked scratch state makes the suite guard fail loudly with its path", () => {
  const runId = `scratch-state-guard-${process.pid}-${Date.now()}`;
  const residue = path.join(os.homedir(), "tmp", `throne-scratch-state-${runId}`);
  const environment = { ...process.env, THRONE_SUITE_RUN_ID: runId };
  try {
    assert.equal(spawnSync(process.execPath, [leakGuardPath, "pretest"], { env: environment }).status, 0);
    mkdirSync(residue, { recursive: true });
    const result = spawnSync(process.execPath, [leakGuardPath, "posttest"], {
      encoding: "utf8",
      env: environment,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scratch-throne-state-leak-guard/);
    assert.match(result.stderr, new RegExp(residue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(residue, { recursive: true, force: true });
  }
});

test("scratch-state post-guard reports residue after a failing test command while preserving that failure", () => {
  const runId = `scratch-state-failure-${process.pid}-${Date.now()}`;
  const residue = path.join(os.homedir(), "tmp", `throne-scratch-state-${runId}`);
  const environment = { ...process.env, THRONE_SUITE_RUN_ID: runId };
  try {
    assert.equal(spawnSync(process.execPath, [leakGuardPath, "pretest"], { env: environment }).status, 0);
    const result = spawnSync(
      process.execPath,
      [
        postGuardRunnerPath,
        "--guard",
        process.execPath,
        leakGuardPath,
        "posttest",
        "--test",
        process.execPath,
        "-e",
        `require(\"node:fs\").mkdirSync(${JSON.stringify(residue)}, { recursive: true }); process.exit(37);`,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 37);
    assert.match(result.stderr, /scratch-throne-state-leak-guard/);
    assert.match(result.stderr, new RegExp(residue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(residue, { recursive: true, force: true });
  }
});
