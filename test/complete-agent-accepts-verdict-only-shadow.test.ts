import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../src/agent-statuses/agent-statuses.types.ts";
import { runCompleteAgent } from "../src/complete-agent/complete-agent.ts";
import type { CompleteAgentDependencies } from "../src/complete-agent/complete-agent.ts";
import {
  writeSpawnSpec,
  readSpawnSpec,
} from "../src/agentdata/spawn-data-contracts.ts";

const SHADOW_NAME = "shadow-vgr-verdict-complete-fixture";

let ledgerBaseDir: string;

before(async () => {
  ledgerBaseDir = await mkdtemp(path.join(tmpdir(), "vgr-shadow-complete-ledger-"));
});

after(async () => {
  await rm(ledgerBaseDir, { recursive: true, force: true });
});

/** A Shadow-shaped fixture: no `reportLanded` on the roster (a Shadow never
 *  writes REPORT.md into the roster-scanned location, the exact gap
 *  `isLiveNotWorkingWithoutReport` exists for) and no REPORT.md anywhere —
 *  a verdict-only Shadow produces no such artifact by definition. */
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

function liveNotWorkingWithoutReportEntry(
  name: string,
  liveStatus: AgentStatusesRosterEntry["liveStatus"],
): AgentStatusesRosterEntry {
  return {
    name,
    lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
    liveStatus,
    reportLanded: false,
    focused: false,
  };
}

function buildDependencies(overrides: {
  claimOutput: string;
  reaped: string[];
}): CompleteAgentDependencies {
  return {
    getRoster: async () => [],
    reap: async (name) => {
      overrides.reaped.push(name);
      return 0;
    },
    writeStdout: () => {},
    writeStderr: () => {},
    readAgent: async () => overrides.claimOutput,
    readSpawnSpec: (name) => readSpawnSpec(name, ledgerBaseDir),
  };
}

test("a verdict-only Shadow is independently accepted by complete-agent's outer gate", async () => {
  const name = `${SHADOW_NAME}-1`;
  await landVerdictOnlyShadow({ name, hasShape: true });
  const reaped: string[] = [];
  const dependencies = buildDependencies({
    claimOutput: '{"reapable":"completed"}',
    reaped,
  });
  const code = await runCompleteAgent(
    [name],
    { ...dependencies, getRoster: async () => [liveNotWorkingWithoutReportEntry(name, "done")] },
  );
  assert.equal(code, 0);
  assert.deepEqual(reaped, [name]);
});

test("a Shadow without the durable verdict-only shape is still refused by complete-agent without --force", async () => {
  const name = `${SHADOW_NAME}-2`;
  await landVerdictOnlyShadow({ name, hasShape: false });
  const reaped: string[] = [];
  const dependencies = buildDependencies({
    claimOutput: '{"reapable":"completed"}',
    reaped,
  });
  const code = await runCompleteAgent(
    [name],
    { ...dependencies, getRoster: async () => [liveNotWorkingWithoutReportEntry(name, "done")] },
  );
  assert.equal(code, 1);
  assert.deepEqual(reaped, []);
});

test("a Shadow still marked working is refused by complete-agent regardless of its verdict-only shape", async () => {
  const name = `${SHADOW_NAME}-3`;
  await landVerdictOnlyShadow({ name, hasShape: true });
  const reaped: string[] = [];
  const dependencies = buildDependencies({
    claimOutput: '{"reapable":"completed"}',
    reaped,
  });
  const code = await runCompleteAgent(
    [name],
    {
      ...dependencies,
      getRoster: async () => [
        {
          name,
          lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
          liveStatus: "working",
          reportLanded: false,
          focused: false,
        },
      ],
    },
  );
  assert.equal(code, 1);
  assert.deepEqual(reaped, []);
});
