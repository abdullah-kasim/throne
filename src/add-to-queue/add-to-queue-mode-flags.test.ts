import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { run } from "./add-to-queue-runtime.ts";

const scratchDirectory = await mkdtemp(path.join(tmpdir(), "add-to-queue-mode-flags-"));
after(() => rm(scratchDirectory, { recursive: true, force: true }));

async function fileRow(
  queueFile: string,
  objectiveCode: string,
  modeFlag: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const launchFacts = [
    "--base-commit", "fedcba9876543210fedcba9876543210fedcba98",
    "--target-branch", "main",
    "--target-repo", path.join(scratchDirectory, "target"),
    "--alpha-name", `alpha-${objectiveCode}-01`,
  ];
  let stdout = "";
  let stderr = "";
  const writeStdout = process.stdout.write.bind(process.stdout);
  const writeStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => ((stdout += chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => ((stderr += chunk), true)) as typeof process.stderr.write;
  try {
    const exitCode = await run(
      ["--objective-code", objectiveCode, ...launchFacts, modeFlag, "INTENT: carry the mode"],
      {
        openStore: () => openRegentQueueStore(queueFile),
        currentAgentName: async () => "stager-mode",
        readRole: async () => ({ status: IdentityLineReadStatus.Found, value: "Stager" }),
        resolveLaunchDefaults: () => {
          throw new Error("every launch fact was given");
        },
        now: () => 1_800_000_000_000,
      },
    );
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
  }
}

function filedRow(queueFile: string, objectiveCode: string) {
  const store = openRegentQueueStore(queueFile);
  try {
    return findQueueItemByObjectiveCode(store, objectiveCode);
  } finally {
    store.close();
  }
}

for (const removedFlag of ["--shadowless", "--sliceless"]) {
  test(`filing a row with ${removedFlag} is refused because the Lord removed it`, async () => {
    const queueFile = path.join(scratchDirectory, `refused${removedFlag}.sqlite3`);
    const outcome = await fileRow(queueFile, "refused", removedFlag);
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.stderr, new RegExp(`${removedFlag} was removed by the Lord on 2026-11-04`));
    assert.match(outcome.stderr, /"Actually let's drop shadowless and sliceless\."/);
    assert.match(outcome.stderr, /--single-slice/);
    assert.equal(filedRow(queueFile, "refused"), undefined);
  });
}

test("a row filed with --single-slice is stored as single-slice and says so", async () => {
  const queueFile = path.join(scratchDirectory, "single.sqlite3");
  const outcome = await fileRow(queueFile, "single", "--single-slice");
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.match(outcome.stdout, /; SINGLE-SLICE, Lord-authorized\)\.$/m);
  assert.equal(filedRow(queueFile, "single")?.singleSlice, true);
});
