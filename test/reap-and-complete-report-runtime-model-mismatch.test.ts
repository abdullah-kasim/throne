import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAgentState } from "../src/agentdata/agent-state.service.ts";
import { reapAgent } from "../src/reap-agent/lifecycle.ts";
import type { ReapDeps, ReapRequest } from "../src/reap-agent/reap-agent.types.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import {
  readSpawnSpec,
} from "../src/agentdata/spawn-data-contracts.ts";
import { landReapableVerdictOnlyShadow, reapDepsWithNothingToTearDown } from "../src/reap-agent/reap-agent-test-fixtures.ts";
import {
  checkAgentEvidenceRequirementByName,
  type SliceEvidenceResult,
} from "../src/slice-evidence/agent-evidence-gate.ts";
import { runCompleteAgent } from "../src/complete-agent/complete-agent.ts";
import { AGENT_LIFECYCLE_STATES } from "../src/agent-statuses/agent-statuses.types.ts";
import type { RuntimeModelAcceptance } from "../src/session/runtime-model-acceptance.ts";

const MISMATCH_DETAIL =
  "observed claude-opus-5-5 instead of requested opus; evidence preserved at /ledger/verdict-quarantine.json";

const mismatchedAttestation = async (): Promise<RuntimeModelAcceptance> => ({
  ok: false,
  outcome: "mismatch",
  detail: MISMATCH_DETAIL,
  evidencePath: "/ledger/verdict-quarantine.json",
  requestedModel: "opus",
  observedModels: ["claude-opus-5-5"],
});

const verifiedAttestation = async (): Promise<RuntimeModelAcceptance> => ({
  ok: true,
  outcome: "matching",
  evidencePath: "/ledger/verdict-attestation.json",
});

const SHADOW_NAME = "shadow-runtime-model-report-fixture";

let ledgerBaseDir: string;

before(async () => {
  ledgerBaseDir = await mkdtemp(path.join(tmpdir(), "runtime-model-report-ledger-"));
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
  return reapDepsWithNothingToTearDown({
    listAgents: async () => [liveShadow(overrides.name, "done")],
    readAgentState: (agentName) => readAgentState(agentName, ledgerBaseDir),
    readSpawnSpec: (name) => readSpawnSpec(name, ledgerBaseDir),
    writeQueueReapOutcome: async () => {},
    appendLaunchLedgerStatus: async () => {},
  });
}

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("a mismatched runtime-model attestation no longer refuses the evidence gate and names the mismatch", async () => {
  const name = `${SHADOW_NAME}-gate-mismatch`;
  const result = await checkAgentEvidenceRequirementByName(name, ledgerBaseDir, mismatchedAttestation);
  assert.equal(result.ok, true);
  assert.deepEqual(result.runtimeModelMismatch, {
    requestedModel: "opus",
    observedModels: ["claude-opus-5-5"],
    detail: MISMATCH_DETAIL,
    evidencePath: "/ledger/verdict-quarantine.json",
  });
});

test("a verified runtime-model attestation passes the evidence gate with no mismatch recorded", async () => {
  const name = `${SHADOW_NAME}-gate-verified`;
  const result = await checkAgentEvidenceRequirementByName(name, ledgerBaseDir, verifiedAttestation);
  assert.equal(result.ok, true);
  assert.equal(result.runtimeModelMismatch, undefined);
});

test("reap-agent reaps an agent whose runtime model mismatched and prints both models", async () => {
  const name = `${SHADOW_NAME}-reap`;
  await landReapableVerdictOnlyShadow(name, ledgerBaseDir);
  const deps: ReapDeps = {
    ...buildDeps({ name }),
    checkEvidenceRequirement: (agentName) =>
      checkAgentEvidenceRequirementByName(agentName, ledgerBaseDir, mismatchedAttestation),
  };
  const { code, stderr } = await captureStderr(() => reapAgent(baseRequest(name), deps, new Set()));
  assert.equal(code, 0);
  assert.match(stderr, /warning: "[^"]+" ran on claude-opus-5-5, spawn\.json says opus; recorded at \/ledger\/verdict-quarantine\.json/);
});

test("complete-agent reaps an agent whose runtime model mismatched and prints both models", async () => {
  const name = `${SHADOW_NAME}-complete`;
  await landReapableVerdictOnlyShadow(name, ledgerBaseDir);
  const reaped: string[] = [];
  let stderr = "";
  const code = await runCompleteAgent([name], {
    getRoster: async () => [
      { name, lifecycle: AGENT_LIFECYCLE_STATES.LIVE, liveStatus: "done", reportLanded: false, focused: false },
    ],
    reap: async (reapedName) => {
      reaped.push(reapedName);
      return 0;
    },
    writeStdout: () => {},
    writeStderr: (text) => {
      stderr += text;
    },
    readAgentState: (agentName) => readAgentState(agentName, ledgerBaseDir),
    readSpawnSpec: (agentName) => readSpawnSpec(agentName, ledgerBaseDir),
    checkEvidenceRequirement: async (): Promise<SliceEvidenceResult> =>
      checkAgentEvidenceRequirementByName(name, ledgerBaseDir, mismatchedAttestation),
  });
  assert.equal(code, 0);
  assert.deepEqual(reaped, [name]);
  assert.match(stderr, /warning: "[^"]+" ran on claude-opus-5-5, spawn\.json says opus; recorded at \/ledger\/verdict-quarantine\.json/);
});
