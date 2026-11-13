import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { declareAgentState, readAgentState } from "../src/agentdata/agent-state.service.ts";
import { reapAgent } from "../src/reap-agent/lifecycle.ts";
import type { ReapDeps, ReapRequest } from "../src/reap-agent/reap-agent.types.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import {
  writeSpawnSpec,
  readSpawnSpec,
} from "../src/agentdata/spawn-data-contracts.ts";
import { IdentityLineReadStatus } from "../src/agentdata/identity-data.service.ts";
import type { DeliveryVerdict } from "../src/verify-delivery/verify-delivery-runtime.ts";
import { formatReapabilityClaim } from "../src/reap-agent/reapability-claim.ts";
import { SLICE_ASSIGNMENT_COMPLETION_SECTION } from "../src/slice-assignment/slice-assignment-template.ts";

const SHADOW_NAME = "shadow-gvs-handshake-fixture";

let ledgerBaseDir: string;

before(async () => {
  ledgerBaseDir = await mkdtemp(path.join(tmpdir(), "gvs-shadow-ledger-"));
});

after(async () => {
  await rm(ledgerBaseDir, { recursive: true, force: true });
});

function liveShadow(
  name: string,
  agentStatus: HerdrAgent["agentStatus"],
): HerdrAgent {
  return {
    agent: "claude",
    name,
    agentStatus,
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

function baseRequest(name: string): ReapRequest {
  return {
    name,
    force: false,
    bypassMarker: false,
    archiveAbandonedUnmerged: false,
    reason: "completed",
  };
}

function buildDeps(overrides: {
  name: string;
}): ReapDeps {
  return {
    listAgents: async () => [liveShadow(overrides.name, "done")],
    sleep: async () => {},
    readAgentState: (agentName) => readAgentState(agentName, ledgerBaseDir),
    readSpawnSpec: (name) => readSpawnSpec(name, ledgerBaseDir),
    closeAgentTab: async () => {},
    removeTree: async () => false,
    archiveAgentData: async () => "archived",
    listCompletedAgents: async () => [],
    listRegisteredAgents: async () => [],
    readAgentSupervisor: async () => ({ status: IdentityLineReadStatus.FieldAbsent }),
    readTreeBase: async () => null,
    readTreeRepo: async () => undefined,
    checkDeliveryVerdict: async (): Promise<DeliveryVerdict> => ({
      status: "missing-provenance",
      missingFields: "test fixture",
    }),
    readSpawnCwd: async () => undefined,
    recordTiming: async () => {},
    notify: async () => undefined,
    writeQueueReapOutcome: async () => {},
    appendLaunchLedgerStatus: async () => {},
    cleanupAgentScratch: async () => [],
    terminateWorktreeProcesses: async () => ({ killed: [], failed: [] }),
  };
}

test("a live verdict-only Shadow that has published a fresh reapability claim can be reaped without --force", async () => {
  const name = `${SHADOW_NAME}-1`;
  await landVerdictOnlyShadow(name);
  assert.match(
    SLICE_ASSIGNMENT_COMPLETION_SECTION,
    new RegExp(
      formatReapabilityClaim("completed").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
  await declareAgentState(name, { state: "reapable", reapableReason: "completed", declaredBy: "agent" }, ledgerBaseDir);
  const deps = buildDeps({ name });
  const code = await reapAgent(baseRequest(name), deps, new Set());
  assert.equal(code, 0);
});

test("a live verdict-only Shadow that has NOT published a claim refuses without --force", async () => {
  const name = `${SHADOW_NAME}-2`;
  await landVerdictOnlyShadow(name);
  await declareAgentState(name, { state: "waiting-on-supervisor", waitingOn: "alpha", declaredBy: "agent" }, ledgerBaseDir);
  const deps = buildDeps({ name });
  const code = await reapAgent(baseRequest(name), deps, new Set());
  assert.equal(code, 1);
});
