import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reapAgent } from "../src/reap-agent/lifecycle.ts";
import type {
  ReapDeps,
  ReapRequest,
} from "../src/reap-agent/reap-agent.types.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import {
  writeSpawnSpec,
  readSpawnSpec,
} from "../src/agentdata/spawn-data-contracts.ts";
import { IdentityLineReadStatus } from "../src/agentdata/identity-data.service.ts";
import type { DeliveryVerdict } from "../src/verify-delivery/verify-delivery-runtime.ts";
import { formatReapabilityClaim } from "../src/reap-agent/reapability-claim.ts";

// The hiregent lie (2026-09-02): the queue write-back ran BEFORE teardown, so
// a `--reason completed` reap marked the row `complete`, teardown then
// refused, and the queue said "done" about an agent still alive. The
// write-back now runs only after teardown has succeeded; a refused teardown
// writes nothing to the queue and nothing to the launch ledger.

const NAME_PREFIX = "shadow-qwb-order-fixture";

let ledgerBaseDir: string;

before(async () => {
  ledgerBaseDir = await mkdtemp(path.join(tmpdir(), "qwb-order-ledger-"));
});

after(async () => {
  await rm(ledgerBaseDir, { recursive: true, force: true });
});

function liveShadow(name: string): HerdrAgent {
  return {
    agent: "claude",
    name,
    agentStatus: "done",
    cwd: "/tmp/does-not-matter",
    focused: false,
    paneId: "pane-1",
    tabId: "tab-1",
    terminalId: "terminal-1",
  };
}

async function landVerdictOnlyShadow(name: string): Promise<void> {
  await writeSpawnSpec(
    name,
    {
      harness: "claude",
      model: "sonnet",
      effort: 1,
      cwd: "/tmp/does-not-matter",
      deliverable_shape: "verdict-only" as const,
    },
    ledgerBaseDir,
  );
}

function request(name: string): ReapRequest {
  return {
    name,
    force: false,
    bypassMarker: false,
    forceDiscardMemories: false,
    archiveCancelledUnmerged: false,
    reason: "completed",
  };
}

interface Recorded {
  queueWrites: Array<{ reason: string; deliveryCommit: string | undefined }>;
  ledgerAppends: number;
}

function buildDeps(
  name: string,
  recorded: Recorded,
  overrides: Partial<ReapDeps> = {},
): ReapDeps {
  return {
    listAgents: async () => [liveShadow(name)],
    sleep: async () => {},
    readAgent: async () =>
      `Reporting DONE.\n${formatReapabilityClaim("completed")}`,
    readSpawnSpec: (agent) => readSpawnSpec(agent, ledgerBaseDir),
    closeAgentTab: async () => {},
    removeTree: async () => false,
    archiveAgentData: async () => "archived",
    listCompletedAgents: async () => [],
    listRegisteredAgents: async () => [],
    readAgentSupervisor: async () => ({
      status: IdentityLineReadStatus.FieldAbsent,
    }),
    readTreeBase: async () => null,
    readTreeRepo: async () => undefined,
    checkDeliveryVerdict: async (): Promise<DeliveryVerdict> => ({
      status: "missing-provenance",
      missingFields: "test fixture",
    }),
    listUncommittedMemoryChanges: async () => [],
    readSpawnCwd: async () => undefined,
    recordTiming: async () => {},
    notify: async () => undefined,
    resolveQueueReapDeliveryCommit: async () => "abc123",
    writeQueueReapOutcome: async (_agent, reason, deps) => {
      recorded.queueWrites.push({
        reason,
        deliveryCommit: deps?.deliveryCommit,
      });
    },
    appendLaunchLedgerStatus: async () => {
      recorded.ledgerAppends += 1;
    },
    cleanupAgentScratch: async () => [],
    terminateWorktreeProcesses: async () => ({ killed: [], failed: [] }),
    ...overrides,
  };
}

test("a completed reap whose teardown succeeds writes the queue outcome once, with the pre-resolved delivery commit", async () => {
  const name = `${NAME_PREFIX}-1`;
  await landVerdictOnlyShadow(name);
  const recorded: Recorded = { queueWrites: [], ledgerAppends: 0 };
  const code = await reapAgent(
    request(name),
    buildDeps(name, recorded),
    new Set(),
  );
  assert.equal(code, 0);
  assert.deepEqual(recorded.queueWrites, [
    { reason: "completed", deliveryCommit: "abc123" },
  ]);
  assert.equal(recorded.ledgerAppends, 1);
});

test("a completed reap whose teardown is refused writes neither the queue outcome nor the launch ledger", async () => {
  const name = `${NAME_PREFIX}-2`;
  await landVerdictOnlyShadow(name);
  const recorded: Recorded = { queueWrites: [], ledgerAppends: 0 };
  const deps = buildDeps(name, recorded, {
    // Uncommitted memory changes make teardown refuse without --force-discard-memories.
    listUncommittedMemoryChanges: async () => [
      "agent_docs/MEMORY/SOMETHING.md",
    ],
    writeMemoryRefusal: () => {},
  });
  const code = await reapAgent(request(name), deps, new Set());
  assert.equal(code, 1);
  assert.deepEqual(recorded.queueWrites, []);
  assert.equal(recorded.ledgerAppends, 0);
});

test("a scratch reap of the recorded launcher of an in-flight queue row refuses and tears nothing down", async () => {
  const name = `${NAME_PREFIX}-3`;
  await landVerdictOnlyShadow(name);
  const recorded: Recorded = { queueWrites: [], ledgerAppends: 0 };
  let tabsClosed = 0;
  const deps = buildDeps(name, recorded, {
    readQueueLinkage: async () => ({ itemId: "item-77", objectiveCode: "hrg" }),
    closeAgentTab: async () => {
      tabsClosed += 1;
    },
  });
  const code = await reapAgent(
    { ...request(name), reason: "scratch" },
    deps,
    new Set(),
  );
  assert.equal(code, 1);
  assert.equal(tabsClosed, 0);
  assert.deepEqual(recorded.queueWrites, []);
});

test("a scratch reap of an agent no queue row records proceeds as before", async () => {
  const name = `${NAME_PREFIX}-4`;
  await landVerdictOnlyShadow(name);
  const recorded: Recorded = { queueWrites: [], ledgerAppends: 0 };
  let tabsClosed = 0;
  const deps = buildDeps(name, recorded, {
    readQueueLinkage: async () => undefined,
    closeAgentTab: async () => {
      tabsClosed += 1;
    },
  });
  const code = await reapAgent(
    { ...request(name), reason: "scratch" },
    deps,
    new Set(),
  );
  assert.equal(code, 0);
  assert.equal(tabsClosed, 1);
});
