import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ReapReason } from "../agent-timings/reap-reason.ts";
import { completionReportPathForAgent } from "../agentdata/ledger-data.service.ts";
import {
  openRegentQueueStore,
  RegentQueueItemStatus,
  type RegentQueueItemRow,
} from "../regent-queue/regent-queue.store.ts";
import { writeQueueReapOutcome } from "./queue-reap-writeback.ts";

const AGENT_NAME = "alpha-outcome-fixture-01";
const DELIVERY_COMMIT = "d3l1v3r3dc0mm17";

interface ReapScenario {
  readonly reason: ReapReason;
  readonly report?: string;
  readonly deliveryCommit?: string;
}

interface ReapResult {
  readonly row: RegentQueueItemRow;
  readonly printed: string;
}

function reportWithOutcome(outcomeLines: readonly string[]): string {
  return [
    "# Campaign report",
    "",
    "## Implementation accounting",
    "",
    "- **Outcome:** not the outcome block",
    "",
    "## Outcome",
    "",
    ...outcomeLines,
    "",
    "## Real E2E run",
    "",
    "- **PR:** https://example.invalid/not-this-one",
    "",
  ].join("\n");
}

async function reapLaunchedAlpha(scenario: ReapScenario): Promise<ReapResult> {
  const dataHome = await mkdtemp(path.join(tmpdir(), "queue-reap-outcome-"));
  try {
    const ledgerBaseDir = path.join(dataHome, "data");
    const databasePath = path.join(dataHome, "regent-queue.sqlite3");
    const seeding = openRegentQueueStore(databasePath);
    const item = seeding.insertItem({
      objectiveCode: "outcomefixture",
      body: "INTENT: record the outcome",
    });
    seeding.transitionStatus(item.id, RegentQueueItemStatus.InFlight, {
      agentName: AGENT_NAME,
    });
    seeding.close();
    if (scenario.report !== undefined) {
      const reportPath = completionReportPathForAgent(AGENT_NAME, ledgerBaseDir);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, scenario.report);
    }
    let printed = "";
    await writeQueueReapOutcome(AGENT_NAME, scenario.reason, {
      openStore: () => openRegentQueueStore(databasePath),
      ledgerBaseDir,
      findDeliveryCommitHash: async () => scenario.deliveryCommit,
      writeStdout: (text) => {
        printed += text;
      },
    });
    const reading = openRegentQueueStore(databasePath);
    const row = reading.readItem(item.id);
    reading.close();
    assert.ok(row);
    return { row, printed };
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
}

function recordedOutcome(row: RegentQueueItemRow) {
  return {
    status: row.status,
    outcome: row.outcome ?? null,
    outcomeSummary: row.outcomeSummary ?? null,
    prUrl: row.prUrl ?? null,
    resultCommit: row.resultCommit ?? null,
  };
}

test("an Alpha reaped as completed records the delivered outcome its report states", async () => {
  const { row } = await reapLaunchedAlpha({
    reason: "completed",
    deliveryCommit: DELIVERY_COMMIT,
    report: reportWithOutcome([
      "- **Outcome:** delivered",
      "- **Outcome summary:** The outcome record landed on main.",
      "- **Result commit:** 0a1b2c3d",
    ]),
  });
  assert.deepEqual(recordedOutcome(row), {
    status: RegentQueueItemStatus.Complete,
    outcome: "delivered",
    outcomeSummary: "The outcome record landed on main.",
    prUrl: null,
    resultCommit: "0a1b2c3d",
  });
});

test("an Alpha reaped as completed records the merged outcome, pull request and squash commit its report states", async () => {
  const { row } = await reapLaunchedAlpha({
    reason: "completed",
    deliveryCommit: DELIVERY_COMMIT,
    report: reportWithOutcome([
      "- **Outcome:** merged",
      "- **Outcome summary:** The pull request was squash-merged.",
      "- **PR:** https://github.com/example/repo/pull/42",
      "- **Result commit:** 9b8c7d6",
    ]),
  });
  assert.deepEqual(recordedOutcome(row), {
    status: RegentQueueItemStatus.Complete,
    outcome: "merged",
    outcomeSummary: "The pull request was squash-merged.",
    prUrl: "https://github.com/example/repo/pull/42",
    resultCommit: "9b8c7d6",
  });
});

test("an Alpha reaped as completed records the refused outcome its report states", async () => {
  const { row } = await reapLaunchedAlpha({
    reason: "completed",
    report: reportWithOutcome([
      "- **Outcome:** refused",
      "- **Outcome summary:** Branch protection refused the merge.",
      "- **PR:** https://github.com/example/repo/pull/77",
    ]),
  });
  assert.deepEqual(recordedOutcome(row), {
    status: RegentQueueItemStatus.Complete,
    outcome: "refused",
    outcomeSummary: "Branch protection refused the merge.",
    prUrl: "https://github.com/example/repo/pull/77",
    resultCommit: null,
  });
});

test("an Alpha reaped as completed records the blocked outcome its report states", async () => {
  const { row } = await reapLaunchedAlpha({
    reason: "completed",
    report: reportWithOutcome([
      "- **Outcome:** blocked",
      "- **Outcome summary:** The target repository was unreachable, so nothing landed.",
    ]),
  });
  assert.deepEqual(recordedOutcome(row), {
    status: RegentQueueItemStatus.Complete,
    outcome: "blocked",
    outcomeSummary: "The target repository was unreachable, so nothing landed.",
    prUrl: null,
    resultCommit: null,
  });
});

test("an Alpha reaped as completed records the abandoned outcome its report states", async () => {
  const { row } = await reapLaunchedAlpha({
    reason: "completed",
    deliveryCommit: DELIVERY_COMMIT,
    report: reportWithOutcome([
      "- **Outcome:** abandoned",
      "- **Outcome summary:** The work was stopped once a sibling row covered it.",
    ]),
  });
  assert.deepEqual(recordedOutcome(row), {
    status: RegentQueueItemStatus.Complete,
    outcome: "abandoned",
    outcomeSummary: "The work was stopped once a sibling row covered it.",
    prUrl: null,
    resultCommit: DELIVERY_COMMIT,
  });
});

test("an Alpha reaped as completed without a stated outcome records delivered with its delivery commit", async () => {
  const { row } = await reapLaunchedAlpha({
    reason: "completed",
    deliveryCommit: DELIVERY_COMMIT,
    report: "# Campaign report\n\n## Implementation accounting\n\nDone.\n",
  });
  assert.deepEqual(recordedOutcome(row), {
    status: RegentQueueItemStatus.Complete,
    outcome: "delivered",
    outcomeSummary: null,
    prUrl: null,
    resultCommit: DELIVERY_COMMIT,
  });
});

test("a forced reap without a stated outcome records abandoned", async () => {
  const { row } = await reapLaunchedAlpha({ reason: "force" });
  assert.deepEqual(recordedOutcome(row), {
    status: RegentQueueItemStatus.Abandoned,
    outcome: "abandoned",
    outcomeSummary: null,
    prUrl: null,
    resultCommit: null,
  });
});

test("an Alpha whose report states no valid outcome leaves the row's outcome not recorded and is still reaped", async () => {
  const { row, printed } = await reapLaunchedAlpha({
    reason: "completed",
    report: reportWithOutcome([
      "- **Outcome:** shipped",
      "- **Outcome summary:** Shipped it.",
    ]),
  });
  assert.deepEqual(recordedOutcome(row), {
    status: RegentQueueItemStatus.Complete,
    outcome: null,
    outcomeSummary: null,
    prUrl: null,
    resultCommit: null,
  });
  assert.match(printed, /states outcome "shipped", which is not one of delivered, merged, refused, blocked, abandoned/);
});
