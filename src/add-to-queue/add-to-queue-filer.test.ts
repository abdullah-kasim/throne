import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { run } from "./add-to-queue-runtime.ts";

const scratchDirectory = await mkdtemp(path.join(tmpdir(), "add-to-queue-filer-"));
after(() => rm(scratchDirectory, { recursive: true, force: true }));

test("a filed row records the Stager that filed it", async () => {
  const queueFile = path.join(scratchDirectory, "queue.sqlite3");
  const launchFacts = [
    "--base-commit", "fedcba9876543210fedcba9876543210fedcba98",
    "--target-branch", "trunk",
    "--target-repo", path.join(scratchDirectory, "target"),
    "--alpha-name", "alpha-filed-recorder",
  ];
  const exitCode = await run(["--objective-code", "filed", ...launchFacts, "INTENT: record the filer"], {
    openStore: () => openRegentQueueStore(queueFile),
    currentAgentName: async () => "stager-recorder",
    readRole: async () => ({ status: IdentityLineReadStatus.Found, value: "Stager" }),
    resolveLaunchDefaults: () => {
      throw new Error("every launch fact was given");
    },
    now: () => 1_800_000_000_000,
  });
  assert.equal(exitCode, 0);
  const store = openRegentQueueStore(queueFile);
  try {
    assert.equal(findQueueItemByObjectiveCode(store, "filed")?.filedBy, "stager-recorder");
  } finally {
    store.close();
  }
});
