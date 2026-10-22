import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AlphaAutoscaleHostedWorker } from "./alpha-autoscale.hosted-worker.ts";
import { readAutoscaleQueue, stageEligibleLaunchBriefs } from "./regent-queue-feed.ts";
import { tickDependenciesWithRoomToLaunch } from "./autoscale-tick-test-fixtures.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";

const OBJECTIVE_CODE = "acq";
const TARGET_REPO = "/tmp/example-target";
const COMPANY_BODY = "INTENT: read the tracker through its MCP server\nACCOUNT: company";
const PLAIN_BODY = "INTENT: fix one function";

const routeWithoutTokenBalance = {
  tokenBalanceKillSwitchOn: () => false,
  tokenBalanceOperatorEnabled: () => false,
  tokenBalanceVerdict: () => {
    throw new Error("token balance is off in this test");
  },
} as never;

async function createAgentArgvForFiledRow(body: string): Promise<readonly string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "throne-queue-account-"));
  try {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    try {
      store.insertItem({
        objectiveCode: OBJECTIVE_CODE,
        body,
        launch: {
          alphaName: `alpha-${OBJECTIVE_CODE}-01`,
          targetRepo: TARGET_REPO,
          targetBranch: "main",
          baseCommit: "0".repeat(40),
        },
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
      assert.deepEqual(stageEligibleLaunchBriefs(store), { state: "staged", count: 1 });
      const ready = readAutoscaleQueue(store, routeWithoutTokenBalance);
      assert.equal(ready.state, "candidates", JSON.stringify(ready));
      if (ready.state !== "candidates") throw new Error("no launch candidate");
      let createAgentArgv: readonly string[] | undefined;
      const deps = tickDependenciesWithRoomToLaunch({
        readReadyQueue: () => ready,
        invokeCli: async (_executable, argv) => {
          if (argv[1] === "create-agent") createAgentArgv = argv;
          return {
            outcome: "success",
            result: { exitCode: 0, stdout: `${TARGET_REPO}-worktree\n`, stderr: "" },
          };
        },
      });
      await new AlphaAutoscaleHostedWorker(deps).runOnce();
      assert.ok(createAgentArgv, "create-agent was never invoked");
      return createAgentArgv;
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a company row's Alpha is spawned with the company account option", async () => {
  const argv = await createAgentArgvForFiledRow(COMPANY_BODY);
  const accountAt = argv.indexOf("--account");
  assert.notEqual(accountAt, -1, `--account absent from ${JSON.stringify(argv)}`);
  assert.equal(argv[accountAt + 1], "company");
  assert.equal(argv.filter((word) => word === "--account").length, 1);
});

test("a row without the marker spawns its Alpha as today", async () => {
  const argv = await createAgentArgvForFiledRow(PLAIN_BODY);
  assert.equal(argv.includes("--account"), false, JSON.stringify(argv));
});
