import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run as runMergeGitTree } from "../merge-git-tree/merge-git-tree-runtime.ts";
import { openRegentQueueAmendments } from "../regent-queue/regent-queue-amendments.ts";
import { REGENT_QUEUE_DATABASE_FILE_NAME } from "../regent-queue/regent-queue-database.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { RECONCILED_THROUGH_LABEL } from "./amendment-notices.ts";
import { refuseUnreconciledQueueAmendments } from "./merge-refusal.ts";

async function withDataDir(runInside: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "merge-refusal-"));
  try {
    await runInside(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function ledgerFor(dataDir: string, name: string, role: string, objectiveCode: string, reconciledThrough?: number): Promise<void> {
  const ledger = path.join(dataDir, name);
  const plan = path.join(ledger, "todo-2026-09-17-1200-topic");
  await mkdir(plan, { recursive: true });
  await writeFile(path.join(ledger, "identity.md"), `# Identity — ${name}\n\n- **Role:** ${role}\n`);
  await writeFile(
    path.join(ledger, "spawn.json"),
    JSON.stringify({ harness: "claude", model: "opus", effort: 3, cwd: "/tmp", objective_code: objectiveCode }),
  );
  await writeFile(
    path.join(plan, "00_overview.md"),
    reconciledThrough === undefined ? "# overview\n" : `# overview\n\n${RECONCILED_THROUGH_LABEL} ${reconciledThrough}\n`,
  );
}

function amend(dataDir: string, objectiveCode: string, times: number): void {
  const queueFile = path.join(dataDir, REGENT_QUEUE_DATABASE_FILE_NAME);
  const store = openRegentQueueStore(queueFile);
  store.insertItem({ objectiveCode, body: `INTENT: ${objectiveCode}` });
  store.close();
  const amendments = openRegentQueueAmendments(queueFile);
  for (let count = 0; count < times; count += 1) {
    amendments.record({ objectiveCode, text: `change ${count + 1}`, wordsOf: "Lord", relayedBy: "stager-test" });
  }
  amendments.close();
}

test("an Alpha with an unreconciled amendment is refused, one that reconciled it is not", async () => {
  await withDataDir(async (dataDir) => {
    await ledgerFor(dataDir, "alpha-behind-01", "Alpha", "behind", 1);
    await ledgerFor(dataDir, "alpha-current-01", "Alpha", "current", 2);
    amend(dataDir, "behind", 2);
    amend(dataDir, "current", 2);
    const refusal = await refuseUnreconciledQueueAmendments("alpha-behind-01", dataDir);
    assert.match(refusal ?? "", /"alpha-behind-01" may not land its branch yet/);
    assert.match(refusal ?? "", /AMENDMENTS 2-2 are unreconciled/);
    assert.equal(await refuseUnreconciledQueueAmendments("alpha-current-01", dataDir), undefined);
  });
});

test("a Shadow landing on its Alpha's branch is never checked", async () => {
  await withDataDir(async (dataDir) => {
    await ledgerFor(dataDir, "shadow-behind-01", "Shadow", "behind");
    amend(dataDir, "behind", 3);
    assert.equal(await refuseUnreconciledQueueAmendments("shadow-behind-01", dataDir), undefined);
  });
});

test("an agent with no identity is never checked", async () => {
  await withDataDir(async (dataDir) => {
    assert.equal(await refuseUnreconciledQueueAmendments("nobody-01", dataDir), undefined);
  });
});

test("merge-git-tree refuses before absorbing or merging anything when the refusal fires", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const exitCode = await runMergeGitTree(["alpha-behind-01", "Add the saved search page"], {
    readTreeMergeTarget: async () => ({ repo: "/tmp/repo", branch: "main" }),
    refuseUnreconciledQueueAmendments: async (name) => `"${name}" may not land its branch yet: AMENDMENT 2 is unreconciled.`,
    withTargetDeliveryLock: async (_repo, _holder, _dataDir, operation) => {
      calls.push("lock");
      return operation();
    },
    absorbDeliveryTarget: async () => {
      calls.push("absorb");
      return { status: "clean" } as never;
    },
    mergeBack: async () => {
      calls.push("merge");
      return {} as never;
    },
    out: () => undefined,
    err: (message) => errors.push(message),
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.match(errors.join(""), /AMENDMENT 2 is unreconciled\. Nothing was merged\./);
});
