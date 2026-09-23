import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SLICELESS_LINE } from "../agentdata/identity-data.service.ts";
import { openRegentQueueAmendments } from "../regent-queue/regent-queue-amendments.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { RECONCILED_THROUGH_LABEL } from "./amendment-notices.ts";
import { decideReconciliation, readReconciledThrough } from "./amendment-reconciliation.ts";
import {
  CheckReconciledExitCode,
  run,
  type CheckReconciledDependencies,
} from "./check-reconciled-runtime.ts";

const ALPHA = "alpha-flying-01";

interface Court {
  readonly dataDir: string;
  readonly queueFile: string;
  readonly errors: string[];
  readonly outputs: string[];
  readonly dependencies: CheckReconciledDependencies;
}

async function withCourt(runInside: (court: Court) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "check-reconciled-"));
  const dataDir = path.join(root, "data");
  const queueFile = path.join(dataDir, "regent-queue.sqlite3");
  await mkdir(dataDir, { recursive: true });
  const errors: string[] = [];
  const outputs: string[] = [];
  try {
    await runInside({
      dataDir,
      queueFile,
      errors,
      outputs,
      dependencies: {
        dataDir,
        openAmendments: () => openRegentQueueAmendments(queueFile),
        out: (message) => outputs.push(message),
        err: (message) => errors.push(message),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function launchedAlpha(court: Court, objectiveCode: string | undefined, options: { sliceless?: boolean } = {}): Promise<string> {
  const ledger = path.join(court.dataDir, ALPHA);
  await mkdir(ledger, { recursive: true });
  const spawn = { harness: "claude", model: "opus", effort: 3, cwd: "/tmp", ...(objectiveCode === undefined ? {} : { objective_code: objectiveCode }) };
  await writeFile(path.join(ledger, "spawn.json"), JSON.stringify(spawn));
  await writeFile(
    path.join(ledger, "identity.md"),
    `# Identity — ${ALPHA}\n\n- **Role:** Alpha\n${options.sliceless === true ? `${SLICELESS_LINE}\n` : ""}`,
  );
  return ledger;
}

async function planBundle(ledger: string, bundleName: string, overview: string): Promise<void> {
  await mkdir(path.join(ledger, bundleName), { recursive: true });
  await writeFile(path.join(ledger, bundleName, "00_overview.md"), overview);
}

function amend(court: Court, objectiveCode: string, times: number): void {
  const store = openRegentQueueStore(court.queueFile);
  store.insertItem({ objectiveCode, body: `INTENT: ${objectiveCode}` });
  store.close();
  const amendments = openRegentQueueAmendments(court.queueFile);
  for (let count = 0; count < times; count += 1) {
    amendments.record({ objectiveCode, text: `change ${count + 1}`, wordsOf: "Lord", relayedBy: "stager-test" });
  }
  amendments.close();
}

test("the reconciled-through line is read from the last occurrence, ignoring look-alikes", () => {
  const text = [
    "**Amendments reconciled through:** Source turn 4",
    `${RECONCILED_THROUGH_LABEL} 1`,
    "prose mentioning **Queue amendments reconciled through:** 9 inline",
    `${RECONCILED_THROUGH_LABEL} 3`,
  ].join("\n");
  assert.equal(readReconciledThrough(text), 3);
  assert.equal(readReconciledThrough("no line here"), undefined);
});

test("reconciliation passes with no amendments, and otherwise needs a line at or above the highest number", () => {
  const base = { objectiveCode: "x", evidenceFile: "/p/00_overview.md" };
  assert.deepEqual(decideReconciliation({ ...base, highestAmendment: 0, reconciledThrough: undefined }), { reconciled: true });
  assert.deepEqual(decideReconciliation({ ...base, highestAmendment: 2, reconciledThrough: 2 }), { reconciled: true });
  assert.deepEqual(decideReconciliation({ ...base, highestAmendment: 2, reconciledThrough: 5 }), { reconciled: true });
  const missing = decideReconciliation({ ...base, highestAmendment: 2, reconciledThrough: undefined });
  assert.equal(missing.reconciled, false);
  const behind = decideReconciliation({ ...base, highestAmendment: 4, reconciledThrough: 2 });
  assert.equal(behind.reconciled, false);
  assert.match(behind.reconciled ? "" : behind.reason, /AMENDMENTS 3-4 are unreconciled/);
});

test("the 2026-09-17 shape: amendments recorded after the plan was stamped are caught", async () => {
  await withCourt(async (court) => {
    const ledger = await launchedAlpha(court, "sitetoken");
    await planBundle(ledger, "todo-2026-09-17-1122-topic", `# overview\n\n${RECONCILED_THROUGH_LABEL} 2\n`);
    amend(court, "sitetoken", 4);
    const exitCode = await run(["--agent", ALPHA], court.dependencies);
    assert.equal(exitCode, CheckReconciledExitCode.NotReconciled);
    assert.match(court.errors.join(""), /AMENDMENT 4/);
    assert.match(court.errors.join(""), /AMENDMENTS 3-4 are unreconciled/);
  });
});

test("a plan stamped through the highest amendment passes", async () => {
  await withCourt(async (court) => {
    const ledger = await launchedAlpha(court, "sitetoken");
    await planBundle(ledger, "todo-2026-09-17-1122-topic", `# overview\n\n${RECONCILED_THROUGH_LABEL} 2\n`);
    amend(court, "sitetoken", 2);
    assert.equal(await run(["--agent", ALPHA], court.dependencies), CheckReconciledExitCode.Reconciled, court.errors.join(""));
  });
});

test("only the newest plan bundle counts", async () => {
  await withCourt(async (court) => {
    const ledger = await launchedAlpha(court, "sitetoken");
    await planBundle(ledger, "todo-2026-09-17-1000-old", `${RECONCILED_THROUGH_LABEL} 1\n`);
    await planBundle(ledger, "todo-2026-09-17-1200-new", "# overview with no stamp\n");
    amend(court, "sitetoken", 1);
    assert.equal(await run(["--agent", ALPHA], court.dependencies), CheckReconciledExitCode.NotReconciled);
    assert.match(court.errors.join(""), /todo-2026-09-17-1200-new/);
  });
});

test("a sliceless Alpha is checked against its verify.md, not a plan bundle", async () => {
  await withCourt(async (court) => {
    const ledger = await launchedAlpha(court, "quick", { sliceless: true });
    await planBundle(ledger, "todo-2026-09-17-1200-stale", `${RECONCILED_THROUGH_LABEL} 9\n`);
    amend(court, "quick", 1);
    assert.equal(await run(["--agent", ALPHA], court.dependencies), CheckReconciledExitCode.NotReconciled);
    assert.match(court.errors.join(""), /sliceless\/quick\/verify\.md/);
    await mkdir(path.join(ledger, "sliceless", "quick"), { recursive: true });
    await writeFile(path.join(ledger, "sliceless", "quick", "verify.md"), `${RECONCILED_THROUGH_LABEL} 1\n**Verify outcome:** PASS\n`);
    assert.equal(await run(["--agent", ALPHA], court.dependencies), CheckReconciledExitCode.Reconciled);
  });
});

test("a row with no amendments passes even before any plan exists", async () => {
  await withCourt(async (court) => {
    await launchedAlpha(court, "quiet");
    amend(court, "quiet", 0);
    assert.equal(await run(["--agent", ALPHA], court.dependencies), CheckReconciledExitCode.Reconciled);
  });
});

test("amendments with no plan bundle at all are not reconciled", async () => {
  await withCourt(async (court) => {
    await launchedAlpha(court, "early");
    amend(court, "early", 1);
    assert.equal(await run(["--agent", ALPHA], court.dependencies), CheckReconciledExitCode.NotReconciled);
    assert.match(court.errors.join(""), /no plan bundle/);
  });
});

test("an agent with no queue objective code has nothing to reconcile", async () => {
  await withCourt(async (court) => {
    await launchedAlpha(court, undefined);
    assert.equal(await run(["--agent", ALPHA], court.dependencies), CheckReconciledExitCode.Reconciled);
    assert.match(court.outputs.join(""), /no queue objective code/);
  });
});

test("a malformed invocation is refused", async () => {
  await withCourt(async (court) => {
    for (const args of [[], ["--agent"], ["--agent", " "], ["--name", ALPHA], ["--agent", ALPHA, "extra"]]) {
      assert.equal(await run(args, court.dependencies), CheckReconciledExitCode.InvalidInvocation, JSON.stringify(args));
    }
  });
});
