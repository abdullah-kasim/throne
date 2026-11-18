import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { readAutoscaleQueue, stageEligibleLaunchBriefs } from "../alpha-autoscale/regent-queue-feed.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { parseUpdateQueueArgs, updateQueueItem } from "../update-queue/update-queue-runtime.ts";
import { run } from "./add-to-queue-runtime.ts";
import { OBJECTIVE_CODE_MAX_LENGTH } from "./objective-code-length.ts";

const scratchDirectory = await mkdtemp(path.join(tmpdir(), "add-to-queue-code-length-"));
after(() => rm(scratchDirectory, { recursive: true, force: true }));

const TARGET_REPO = path.join(scratchDirectory, "target");
const BASE_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

async function fileRow(queueFile: string, objectiveCode: string) {
  const errors: string[] = [];
  const writeError = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = await run([
      "--objective-code", objectiveCode,
      "--base-commit", BASE_COMMIT,
      "--target-branch", "main",
      "--target-repo", TARGET_REPO,
      "--alpha-name", `alpha-${objectiveCode}-01`,
      "INTENT: check the code length",
    ], {
      openStore: () => openRegentQueueStore(queueFile),
      currentAgentName: async () => "stager-length",
      readRole: async () => ({ status: IdentityLineReadStatus.Found, value: "Stager" }),
      resolveLaunchDefaults: () => {
        throw new Error("every launch fact was given");
      },
      now: () => 1_800_000_000_000,
    });
    return { exitCode, errors: errors.join("") };
  } finally {
    process.stderr.write = writeError;
  }
}

test("an objective code exactly as long as the limit is filed", async () => {
  const queueFile = path.join(scratchDirectory, "exact.sqlite3");
  const code = "a".repeat(OBJECTIVE_CODE_MAX_LENGTH);
  const { exitCode } = await fileRow(queueFile, code);
  assert.equal(exitCode, 0);
  const store = openRegentQueueStore(queueFile);
  try {
    assert.equal(findQueueItemByObjectiveCode(store, code)?.objectiveCode, code);
  } finally {
    store.close();
  }
});

test("an objective code one character over the limit is refused, writes nothing, and names the limit", async () => {
  const queueFile = path.join(scratchDirectory, "over.sqlite3");
  const code = "b".repeat(OBJECTIVE_CODE_MAX_LENGTH + 1);
  const { exitCode, errors } = await fileRow(queueFile, code);
  assert.equal(exitCode, 1);
  assert.match(errors, new RegExp(`objective code "${code}" is ${code.length} characters`));
  assert.match(errors, new RegExp(`longest allowed is ${OBJECTIVE_CODE_MAX_LENGTH}`));
  assert.ok(
    errors.includes(
      `add-to-queue: objective code "${code}" is ${code.length} characters; the longest allowed is ${OBJECTIVE_CODE_MAX_LENGTH}, because "shadow-${code}-99a-conform-r2" (33) would not fit Herdr's 32`,
    ),
    errors,
  );
  const store = openRegentQueueStore(queueFile);
  try {
    assert.equal(findQueueItemByObjectiveCode(store, code), undefined);
    assert.equal(store.readAll().state, "positively-empty");
  } finally {
    store.close();
  }
});

test("a row already stored with a longer objective code can still be read, updated and launched", () => {
  const code = "ovenschedulers";
  const store = openRegentQueueStore(path.join(scratchDirectory, "stored.sqlite3"));
  try {
    store.insertItem({
      objectiveCode: code,
      body: "INTENT: keep working",
      launch: { alphaName: `alpha-${code}-01`, targetRepo: TARGET_REPO, targetBranch: "main", baseCommit: BASE_COMMIT },
      deliveryMirror: {
        verdict: "not-started",
        deliveryCommit: null,
        targetRepo: TARGET_REPO,
        targetBranch: "main",
        treeIdentity: null,
        checkedAt: 1,
        reason: "queue item was just created; no agent is assigned yet",
      },
    });
    assert.equal(findQueueItemByObjectiveCode(store, code)?.objectiveCode, code);
    const updated = updateQueueItem(store, parseUpdateQueueArgs(["--objective-code", code, "--priority", "2"]));
    assert.equal(updated.priority, 2);
    assert.deepEqual(stageEligibleLaunchBriefs(store), { state: "staged", count: 1 });
    assert.equal(readAutoscaleQueue(store).state, "candidates");
  } finally {
    store.close();
  }
});
