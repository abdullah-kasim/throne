import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reapAgent } from "./lifecycle.ts";
import type { ReapDeps, ReapRequest } from "./reap-agent.types.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import {
  writeSpawnSpec,
  readSpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { writeIdentity, readAgentRole, IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { DELIVERY_EVIDENCE_DATA } from "../agentdata/delivery-evidence-data.service.ts";
import { hasCompletionReportForAgent, LedgerDataService } from "../agentdata/ledger-data.service.ts";
import { isAncestor } from "../git-lifecycle/delivery.ts";
import { hasDeliveryCommit } from "../git-lifecycle/delivery-commit-proof.ts";
import type { DeliveryVerdict } from "../verify-delivery/verify-delivery-runtime.ts";

const execFileAsync = promisify(execFile);
const ALPHA_NAME = "alpha-acp-fixture";
const SHADOW_NAME = "shadow-acp-fixture";

let ledgerBaseDir: string;
let repoDir: string;
const LEDGER_DATA = new LedgerDataService();

async function git(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}

before(async () => {
  ledgerBaseDir = await mkdtemp(path.join(tmpdir(), "acp-reap-ledger-"));
  repoDir = await mkdtemp(path.join(tmpdir(), "acp-reap-repo-"));
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "fixture"]);
  await writeFile(path.join(repoDir, "seed.txt"), "seed\n");
  await git(["add", "seed.txt"]);
  await git(["commit", "-m", "seed"]);
});

after(async () => {
  await rm(ledgerBaseDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

function liveAgent(name: string): HerdrAgent {
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

async function registerAgent(name: string, role: "Alpha" | "Shadow"): Promise<void> {
  await writeIdentity(
    name,
    { supervisor: "Regent", escalation: "Regent", role },
    ledgerBaseDir,
  );
}

/** No published claim in any live message — proves each new leg satisfies
 *  the gate on its own, without the existing message-scan path helping. */
const NO_CLAIM_OUTPUT = "just chatting, nothing that parses as a claim";

function buildDeps(name: string): ReapDeps {
  return {
    listAgents: async () => [liveAgent(name)],
    sleep: async () => {},
    readAgent: async () => NO_CLAIM_OUTPUT,
    readSpawnSpec: (agentName) => readSpawnSpec(agentName, ledgerBaseDir),
    readAgentRole: (agentName) => readAgentRole(agentName, ledgerBaseDir),
    readDeliveryEvidence: (agentName) =>
      DELIVERY_EVIDENCE_DATA.read(agentName, ledgerBaseDir),
    isAncestor,
    hasCompletionReport: (agentName) =>
      hasCompletionReportForAgent(agentName, ledgerBaseDir),
    readCompletionReport: async (agentName) => {
      try {
        return await readFile(
          path.join(ledgerBaseDir, agentName, "REPORT.md"),
          "utf8",
        );
      } catch {
        return undefined;
      }
    },
    closeAgentTab: async () => {},
    removeTree: async () => false,
    archiveAgentData: async () => "archived",
    listCompletedAgents: () => LEDGER_DATA.listCompletedAgents(ledgerBaseDir),
    hasDeliveryCommit: (agentName) =>
      hasDeliveryCommit(agentName, repoDir, ledgerBaseDir),
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

// Same fixtures as before the Lord's 2026-08-21 ruling, opposite expectation.
// Each of these three agents carries an artifact that USED to admit it for
// teardown without it ever saying it was done. None of them admit it now:
// an artifact proves work happened, never that the agent is finished with
// it. Kept as the inversion rather than deleted, so the shapes that used to
// pass are the shapes now proven not to.
test("a delivered commit no longer admits an Alpha that never published a claim", async () => {
  const name = `${ALPHA_NAME}-ancestry`;
  await registerAgent(name, "Alpha");
  await writeSpawnSpec(
    name,
    { harness: "claude", model: "sonnet", effort: 1, cwd: repoDir },
    ledgerBaseDir,
  );
  await git(["commit", "--allow-empty", "-m", "delivered work"]);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
  const commit = stdout.trim();
  await DELIVERY_EVIDENCE_DATA.write(
    name,
    { repo: repoDir, targetBranch: "main", commit },
    ledgerBaseDir,
  );

  const code = await reapAgent(baseRequest(name), buildDeps(name), new Set());
  assert.equal(code, 1);
});

test("a written REPORT.md no longer admits a verdict-only Alpha that never published a claim", async () => {
  const name = `${ALPHA_NAME}-verdict-only`;
  await registerAgent(name, "Alpha");
  await writeSpawnSpec(
    name,
    {
      harness: "claude",
      model: "sonnet",
      effort: 1,
      cwd: "/tmp/does-not-matter",
      deliverable_shape: "verdict-only",
    },
    ledgerBaseDir,
  );
  await mkdir(path.join(ledgerBaseDir, name), { recursive: true });
  await writeFile(
    path.join(ledgerBaseDir, name, "REPORT.md"),
    "# Report\n\nVerdict-only completion.\n",
  );

  const code = await reapAgent(baseRequest(name), buildDeps(name), new Set());
  assert.equal(code, 1);
});

test("a no-delivery REPORT.md no longer admits a superseded Alpha that never published a claim", async () => {
  const name = `${ALPHA_NAME}-superseded`;
  await registerAgent(name, "Alpha");
  await writeSpawnSpec(
    name,
    { harness: "claude", model: "sonnet", effort: 1, cwd: "/tmp/does-not-matter" },
    ledgerBaseDir,
  );
  await mkdir(path.join(ledgerBaseDir, name), { recursive: true });
  await writeFile(
    path.join(ledgerBaseDir, name, "REPORT.md"),
    "# Report\n\nCampaign superseded; reverted own work. No delivery landed.\n",
  );

  const code = await reapAgent(baseRequest(name), buildDeps(name), new Set());
  assert.equal(code, 1);
});

test("a verdict-only Shadow with no delivery commit and no published claim is still refused teardown", async () => {
  const name = `${SHADOW_NAME}-verdict-only`;
  await registerAgent(name, "Shadow");
  await writeSpawnSpec(
    name,
    {
      harness: "claude",
      model: "sonnet",
      effort: 1,
      cwd: "/tmp/does-not-matter",
      deliverable_shape: "verdict-only",
    },
    ledgerBaseDir,
  );

  const code = await reapAgent(baseRequest(name), buildDeps(name), new Set());
  assert.equal(code, 1);
});

test("an Alpha still genuinely working, with no delivery evidence and no REPORT.md, is still refused teardown without a published claim", async () => {
  const name = `${ALPHA_NAME}-still-working`;
  await registerAgent(name, "Alpha");
  await writeSpawnSpec(
    name,
    { harness: "claude", model: "sonnet", effort: 1, cwd: "/tmp/does-not-matter" },
    ledgerBaseDir,
  );

  const code = await reapAgent(baseRequest(name), buildDeps(name), new Set());
  assert.equal(code, 1);
});
