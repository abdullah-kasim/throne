import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  isReapReason,
  REAP_REASON,
  REAP_REASONS,
  type ReapReason,
} from "../agent-timings/reap-reason.ts";
import { appendLaunchLedgerEntry } from "../alpha-launch-queue/launch-ledger.ts";
import { readLaunchLedger } from "../alpha-launch-queue/launch-ledger-reader.ts";
import { reapAgent } from "../reap-agent/lifecycle.ts";
import { parseReapRequest } from "../reap-agent/input.ts";
import {
  resolveQueueReapEvidence,
  writeQueueReapOutcome,
} from "../reap-agent/queue-reap-writeback.ts";
import type { ReapDeps } from "../reap-agent/reap-agent.types.ts";
import { reapDepsWithNothingToTearDown } from "../reap-agent/reap-agent-test-fixtures.ts";
import {
  openRegentQueueStore,
  RegentQueueItemStatus,
  type RegentQueueItemRow,
} from "../regent-queue/regent-queue.store.ts";
import {
  parseUpdateQueueArgs,
  updateQueueItem,
} from "../update-queue/update-queue-runtime.ts";
import { AlphaAutoscaleHostedWorker } from "./alpha-autoscale.hosted-worker.ts";
import { tickDependenciesWithRoomToLaunch } from "./autoscale-tick-test-fixtures.ts";
import { recoverIdleWork } from "./idle-recovery.ts";
import {
  readAutoscaleQueue,
  stageEligibleLaunchBriefs,
} from "./regent-queue-feed.ts";

const OBJECTIVE_CODE = "stoppedrow";
const ALPHA_NAME = "alpha-stoppedrow-01";
const TARGET_REPO = "/repos/stopped-row-target";
const TARGET_BRANCH = "main";
const BASE_COMMIT = "0".repeat(40);
const STOPPING_REASON: ReapReason = REAP_REASON.ABANDONED;

const scratchDirectories: string[] = [];

after(async () => {
  await Promise.all(
    scratchDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

interface Court {
  readonly databasePath: string;
  readonly launchLedgerPath: string;
  readonly ledgerBaseDir: string;
  readonly itemId: string;
}

async function courtWithAlphaFlyingTheRow(): Promise<Court> {
  const dataHome = await mkdtemp(path.join(tmpdir(), "abandoned-row-"));
  scratchDirectories.push(dataHome);
  const databasePath = path.join(dataHome, "regent-queue.sqlite3");
  const launchLedgerPath = path.join(dataHome, "alpha-launch-ledger.jsonl");
  const store = openRegentQueueStore(databasePath);
  try {
    const item = store.insertItem({
      objectiveCode: OBJECTIVE_CODE,
      body: "INTENT: a row whose work is stopped",
    });
    store.markLaunchEligible(item.id, {
      alphaName: ALPHA_NAME,
      targetRepo: TARGET_REPO,
      targetBranch: TARGET_BRANCH,
      baseCommit: BASE_COMMIT,
    });
    store.transitionStatus(item.id, RegentQueueItemStatus.InFlight, {
      agentName: ALPHA_NAME,
      targetRepo: TARGET_REPO,
      baseCommit: BASE_COMMIT,
    });
    await appendLaunchLedgerEntry(launchLedgerPath, {
      name: ALPHA_NAME,
      objectiveCode: OBJECTIVE_CODE,
      targetRepo: TARGET_REPO,
      targetBranch: TARGET_BRANCH,
      baseCommit: BASE_COMMIT,
      spawnedAt: "2026-10-08T08:00:00.000Z",
    });
    return {
      databasePath,
      launchLedgerPath,
      ledgerBaseDir: path.join(dataHome, "data"),
      itemId: item.id,
    };
  } finally {
    store.close();
  }
}

function openCourtStore(court: Court) {
  return openRegentQueueStore(court.databasePath);
}

function readRow(court: Court): RegentQueueItemRow {
  const store = openCourtStore(court);
  try {
    const row = store.readItem(court.itemId);
    assert.ok(row);
    return row;
  } finally {
    store.close();
  }
}

function reapDepsForAlphaThatNeverCameUp(court: Court): ReapDeps {
  return reapDepsWithNothingToTearDown({
    listAgents: async () => [],
    resolveQueueReapEvidence: (name, reason) =>
      resolveQueueReapEvidence(name, reason, {
        ledgerBaseDir: court.ledgerBaseDir,
        findDeliveryCommitHash: async () => undefined,
      }),
    writeQueueReapOutcome: (name, reason, writebackDeps) =>
      writeQueueReapOutcome(name, reason, {
        ...writebackDeps,
        openStore: () => openCourtStore(court),
        ledgerBaseDir: court.ledgerBaseDir,
        writeStdout: () => {},
      }),
    launchLedgerPath: court.launchLedgerPath,
    now: () => "2026-10-08T09:00:00.000Z",
  });
}

async function reapTheAlpha(
  court: Court,
  reason: ReapReason,
  force: boolean,
): Promise<void> {
  const exitCode = await reapAgent(
    {
      name: ALPHA_NAME,
      reason,
      force,
      bypassMarker: false,
      archiveAbandonedUnmerged: false,
    },
    reapDepsForAlphaThatNeverCameUp(court),
    new Set(),
  );
  assert.equal(exitCode, 0);
}

function reopenTheRowAsItsFiler(court: Court): void {
  const store = openCourtStore(court);
  try {
    updateQueueItem(
      store,
      parseUpdateQueueArgs([
        "--objective-code",
        OBJECTIVE_CODE,
        "--status",
        RegentQueueItemStatus.Open,
      ]),
    );
  } finally {
    store.close();
  }
}

async function alphasLaunchedByOneAutoscaleTick(court: Court): Promise<string[]> {
  const launched: string[] = [];
  const withCourtStore = <Result>(
    read: (store: ReturnType<typeof openCourtStore>) => Result,
  ): Result => {
    const store = openCourtStore(court);
    try {
      return read(store);
    } finally {
      store.close();
    }
  };
  const dependencies = tickDependenciesWithRoomToLaunch({
    recoverIdleWork: () =>
      recoverIdleWork({ openStore: () => openCourtStore(court) }),
    readReadyQueue: () =>
      withCourtStore((store) =>
        readAutoscaleQueue(store, {
          tokenBalanceKillSwitchOn: () => false,
          tokenBalanceOperatorEnabled: () => false,
          tokenBalanceVerdict: () => {
            throw new Error("the token balancer is off in this court");
          },
        }),
      ),
    autoBriefEligibleItems: () => withCourtStore(stageEligibleLaunchBriefs),
    readLaunchLedger: (objectiveCode) =>
      readLaunchLedger(court.launchLedgerPath, { objectiveCode }),
    invokeCli: async (_executable, argv) => {
      if (argv[1] === "create-agent") {
        launched.push(argv[argv.indexOf("--name") + 1]!);
      }
      return {
        outcome: "success",
        result: { exitCode: 0, stdout: "/opt/example-worktree\n", stderr: "" },
      };
    },
  });
  await new AlphaAutoscaleHostedWorker(dependencies).runOnce();
  return launched;
}

test("an agent reaped as abandoned leaves its queue row abandoned", async () => {
  const court = await courtWithAlphaFlyingTheRow();
  await reapTheAlpha(court, STOPPING_REASON, false);
  const row = readRow(court);
  assert.equal(row.status, RegentQueueItemStatus.Abandoned);
  assert.equal(row.outcome, "abandoned");
});

test("the autoscale tick launches nothing for a row whose agent was reaped as abandoned", async () => {
  const court = await courtWithAlphaFlyingTheRow();
  await reapTheAlpha(court, STOPPING_REASON, false);
  assert.deepEqual(await alphasLaunchedByOneAutoscaleTick(court), []);
  assert.equal(readRow(court).status, RegentQueueItemStatus.Abandoned);
});

test("no reap reason ever reopens a queue row", async () => {
  for (const reason of REAP_REASONS) {
    const court = await courtWithAlphaFlyingTheRow();
    await writeQueueReapOutcome(ALPHA_NAME, reason, {
      openStore: () => openCourtStore(court),
      ledgerBaseDir: court.ledgerBaseDir,
      findDeliveryCommitHash: async () => undefined,
      writeStdout: () => {},
    });
    assert.notEqual(
      readRow(court).status,
      RegentQueueItemStatus.Open,
      `reap reason "${reason}" reopened the row`,
    );
  }
});

test("cancelled is no longer a reap reason", () => {
  assert.equal(isReapReason("cancelled"), false);
  assert.throws(
    () => parseReapRequest([ALPHA_NAME, "--reason", "cancelled"]),
    /invalid reap reason "cancelled"/,
  );
});

test("idle recovery never brings an abandoned row back", async () => {
  const court = await courtWithAlphaFlyingTheRow();
  await reapTheAlpha(court, STOPPING_REASON, false);
  const recovery = recoverIdleWork({ openStore: () => openCourtStore(court) });
  assert.equal(recovery.recovered, null);
  assert.equal(readRow(court).status, RegentQueueItemStatus.Abandoned);
});

test("the filer can still reopen an abandoned row explicitly and it becomes launchable again", async () => {
  const court = await courtWithAlphaFlyingTheRow();
  await reapTheAlpha(court, STOPPING_REASON, false);
  reopenTheRowAsItsFiler(court);
  assert.equal(readRow(court).status, RegentQueueItemStatus.Open);
  assert.deepEqual(await alphasLaunchedByOneAutoscaleTick(court), [ALPHA_NAME]);
});

test("a failed launch can be cleared with an abandoned forced reap and an explicit reopen, and the row launches again", async () => {
  const court = await courtWithAlphaFlyingTheRow();
  const launchHistory = async () => {
    const ledger = await readLaunchLedger(court.launchLedgerPath, {
      objectiveCode: OBJECTIVE_CODE,
    });
    assert.equal(ledger.state, "ok");
    return ledger.entries.map((entry) => entry.status);
  };
  assert.deepEqual(await launchHistory(), ["unknown"]);
  assert.deepEqual(await alphasLaunchedByOneAutoscaleTick(court), []);

  await reapTheAlpha(court, STOPPING_REASON, true);
  assert.deepEqual(await launchHistory(), ["abandoned"]);
  assert.equal(readRow(court).status, RegentQueueItemStatus.Abandoned);
  assert.deepEqual(await alphasLaunchedByOneAutoscaleTick(court), []);

  reopenTheRowAsItsFiler(court);
  assert.deepEqual(await alphasLaunchedByOneAutoscaleTick(court), [ALPHA_NAME]);
});
