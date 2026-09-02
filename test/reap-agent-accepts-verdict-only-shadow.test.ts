import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reapAgent } from "../src/reap-agent/lifecycle.ts";
import type { ReapDeps, ReapRequest } from "../src/reap-agent/reap-agent.types.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import {
  writeSpawnSpec,
  readSpawnSpec,
} from "../src/agentdata/spawn-data-contracts.ts";
import { IdentityLineReadStatus } from "../src/agentdata/identity-data.service.ts";
import type { DeliveryVerdict } from "../src/verify-delivery/verify-delivery-runtime.ts";

const SHADOW_NAME = "shadow-vgr-verdict-fixture";

let ledgerBaseDir: string;

before(async () => {
  ledgerBaseDir = await mkdtemp(path.join(tmpdir(), "vgr-shadow-ledger-"));
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

/** A Shadow-shaped fixture: never writes REPORT.md — a verdict-only Shadow
 *  produces no such artifact by definition. Every case below carries only
 *  the durable spawn-time shape and the live reapability claim, varying
 *  only the one axis each test names. */
async function landVerdictOnlyShadow(options: {
  name: string;
  hasShape: boolean;
}): Promise<void> {
  await writeSpawnSpec(
    options.name,
    {
      harness: "claude",
      model: "sonnet",
      effort: 1,
      cwd: "/tmp/does-not-matter",
      ...(options.hasShape ? { deliverable_shape: "verdict-only" as const } : {}),
    },
    ledgerBaseDir,
  );
}

function baseRequest(name: string): ReapRequest {
  return {
    name,
    force: false,
    bypassMarker: false,
    forceDiscardMemories: false,
    archiveCancelledUnmerged: false,
    reason: "completed",
  };
}

function buildDeps(overrides: {
  name: string;
  claimOutput: string;
  liveStatus?: HerdrAgent["agentStatus"];
}): ReapDeps {
  return {
    listAgents: async () => [
      liveShadow(overrides.name, overrides.liveStatus ?? "done"),
    ],
    sleep: async () => {},
    readAgent: async () => overrides.claimOutput,
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
    listUncommittedMemoryChanges: async () => [],
    readSpawnCwd: async () => undefined,
    recordTiming: async () => {},
    notify: async () => undefined,
    writeQueueReapOutcome: async () => {},
    appendLaunchLedgerStatus: async () => {},
    cleanupAgentScratch: async () => [],
    terminateWorktreeProcesses: async () => ({ killed: [], failed: [] }),
  };
}

test("a verdict-only Shadow that published a completed verdict can be reaped without --force", async () => {
  const name = `${SHADOW_NAME}-1`;
  await landVerdictOnlyShadow({ name, hasShape: true });
  const deps = buildDeps({
    name,
    claimOutput: '{"reapable":"completed"}',
  });
  // `requireLiveReapabilityClaim` and the still-working liveness check are
  // the only paths that can return a nonzero code for a LIVE, non-force
  // request here — a 0 exit is therefore proof teardown proceeded past both.
  const code = await reapAgent(baseRequest(name), deps, new Set());
  assert.equal(code, 0);
});

// Inverted by the Lord's ruling of 2026-08-21: the durable verdict-only
// shape used to be a REQUIRED second proof alongside the claim, so a Shadow
// that had plainly said it was done was refused for lacking a spawn-time
// field describing what kind of deliverable it produces. That field answers
// "what shape is its output", never "is it finished", and requiring it is
// what forced --force onto healthy gates. The claim alone is now sufficient.
test("a published claim is sufficient without the durable verdict-only shape", async () => {
  const name = `${SHADOW_NAME}-2`;
  await landVerdictOnlyShadow({ name, hasShape: false });
  const deps = buildDeps({
    name,
    claimOutput: '{"reapable":"completed"}',
  });
  const code = await reapAgent(baseRequest(name), deps, new Set());
  assert.equal(code, 0);
});

test("a Shadow still marked working is refused regardless of its verdict-only shape", async () => {
  const name = `${SHADOW_NAME}-3`;
  await landVerdictOnlyShadow({ name, hasShape: true });
  const deps = buildDeps({
    name,
    claimOutput: '{"reapable":"completed"}',
    liveStatus: "working",
  });
  const code = await reapAgent(baseRequest(name), deps, new Set());
  assert.equal(code, 1);
});
