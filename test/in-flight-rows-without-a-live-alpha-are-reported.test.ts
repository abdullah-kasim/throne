import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  listCompletedAgentNames,
  listRegisteredAgentNames,
  readAgentStatusRole,
} from "../src/agent-statuses/agent-statuses-registry.ts";
import { getAgentStatusesRoster } from "../src/agent-statuses/agent-statuses-roster.ts";
import type { LiveAgentStatus } from "../src/agent-statuses/agent-statuses-herdr.ts";
import { writeIdentity } from "../src/agentdata/identity-data.service.ts";
import { REAPED_DIR_NAME } from "../src/agentdata/ledger-data.service.ts";
import { writeSpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";
import { runCheckInFlightRows } from "../src/check-in-flight-rows/check-in-flight-rows.command.ts";
import {
  readInFlightRowsWithoutLiveAlpha,
  type InFlightRowCheckDependencies,
  type InFlightRowWithoutLiveAlpha,
} from "../src/check-in-flight-rows/in-flight-rows-without-live-alpha.ts";
import type { HerdrAgent, KeepGoingDependencies } from "../src/keep-going/keep-going-context.ts";
import { DESIRED_STATES, UNTHROTTLED_EVALUATION } from "../src/keep-going/keep-going-context.ts";
import { buildRegentNudgeText } from "../src/keep-going/keep-going-nudge.ts";
import { tendRegent } from "../src/keep-going/keep-going-regent-tending.ts";
import {
  openRegentQueueStore,
  RegentQueueItemStatus,
} from "../src/regent-queue/regent-queue.store.ts";

const LIVE_ALPHA = "alpha-rowcheck-live-01";
const DEAD_ALPHA = "alpha-rowcheck-dead-01";
const COMPLETE_ALPHA = "alpha-rowcheck-complete-01";
const REAPED_ALPHA = "alpha-rowcheck-reaped-01";
const NEVER_REGISTERED_ALPHA = "alpha-rowcheck-ghost-01";
const STARTING_ALPHA = "alpha-rowcheck-starting-01";
const A_YOUNG_SPAWN_AGE_MS = 60_000;
const LIVE_REGENT = { name: "Regent", agent: "claude", paneId: "w1:p1" } as unknown as HerdrAgent;

let scratchRoot: string;
let ledgerDirectory: string;
let databaseWithStrandedRows: string;
let databaseWithOnlyHealthyRows: string;

function herdrPaneFor(name: string): LiveAgentStatus {
  return {
    agent: "claude",
    name,
    agentStatus: "working",
    cwd: `/tmp/${name}`,
    focused: false,
    paneId: "w1:p9",
    tabId: "w1:t9",
    terminalId: "term-9",
  };
}

function checkDependencies(databasePath: string): InFlightRowCheckDependencies {
  return {
    openStore: () => openRegentQueueStore(databasePath),
    getRoster: () =>
      getAgentStatusesRoster({
        listLiveAgentStatuses: async () => [herdrPaneFor(LIVE_ALPHA)],
        listRegisteredAgentNames: () => listRegisteredAgentNames(ledgerDirectory),
        listCompletedAgentNames: () => listCompletedAgentNames(ledgerDirectory),
        readAgentStatusRole: (name) => readAgentStatusRole(name, ledgerDirectory),
        loadAgentStatusesRegentTitle: async () => "Regent",
        readAgentPaneTail: async () => "",
      }),
    dataDirectory: ledgerDirectory,
    now: Date.now,
  };
}

async function writeAlphaLedger(
  name: string,
  spawnFinishedAt: string | null,
  directory: string = ledgerDirectory,
): Promise<void> {
  await writeIdentity(name, { supervisor: "Regent", escalation: "Regent", role: "Alpha" }, directory);
  await writeSpawnSpec(
    name,
    {
      harness: "claude",
      model: "opus",
      effort: 1,
      cwd: `/tmp/${name}`,
      spawned_at: new Date(Date.now() - A_YOUNG_SPAWN_AGE_MS).toISOString(),
      tasked_at: null,
      spawn_finished_at: spawnFinishedAt,
    },
    directory,
  );
}

function seedInFlightRows(databasePath: string, agentsByObjective: Readonly<Record<string, string>>): void {
  const store = openRegentQueueStore(databasePath);
  try {
    for (const [objectiveCode, agentName] of Object.entries(agentsByObjective)) {
      const row = store.insertItem({ objectiveCode, body: `INTENT: ${objectiveCode}` });
      store.transitionStatus(row.id, RegentQueueItemStatus.InFlight, { agentName });
    }
    store.insertItem({ objectiveCode: "rowcheckopen", body: "INTENT: not launched yet" });
  } finally {
    store.close();
  }
}

function readEveryRow(databasePath: string): unknown {
  const store = openRegentQueueStore(databasePath);
  try {
    return store.readAll();
  } finally {
    store.close();
  }
}

before(async () => {
  scratchRoot = await mkdtemp(path.join(tmpdir(), "in-flight-row-check-"));
  ledgerDirectory = path.join(scratchRoot, "data");
  const finishedAt = new Date().toISOString();
  await writeAlphaLedger(LIVE_ALPHA, finishedAt);
  await writeAlphaLedger(DEAD_ALPHA, finishedAt);
  await writeAlphaLedger(COMPLETE_ALPHA, finishedAt);
  await writeFile(path.join(ledgerDirectory, COMPLETE_ALPHA, "REPORT.md"), "# Report\n");
  await writeAlphaLedger(STARTING_ALPHA, null);
  await mkdir(path.join(ledgerDirectory, REAPED_DIR_NAME), { recursive: true });
  await writeAlphaLedger(REAPED_ALPHA, finishedAt, path.join(ledgerDirectory, REAPED_DIR_NAME));
  databaseWithStrandedRows = path.join(scratchRoot, "stranded.sqlite3");
  seedInFlightRows(databaseWithStrandedRows, {
    rowchecklive: LIVE_ALPHA,
    rowcheckdead: DEAD_ALPHA,
    rowcheckcomplete: COMPLETE_ALPHA,
    rowcheckreaped: REAPED_ALPHA,
    rowcheckghost: NEVER_REGISTERED_ALPHA,
    rowcheckstarting: STARTING_ALPHA,
  });
  databaseWithOnlyHealthyRows = path.join(scratchRoot, "healthy.sqlite3");
  seedInFlightRows(databaseWithOnlyHealthyRows, {
    rowchecklive: LIVE_ALPHA,
    rowcheckstarting: STARTING_ALPHA,
  });
});

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

interface RegentTick {
  readonly nudgeTexts: string[];
  readonly deps: KeepGoingDependencies;
}

function regentTick(databasePath: string): RegentTick {
  const nudgeTexts: string[] = [];
  const deps = {
    findLiveRegent: async () => LIVE_REGENT,
    readDesiredState: async () => DESIRED_STATES.RUNNING,
    resurrectRegent: async () => undefined,
    evaluateThrottle: async () => UNTHROTTLED_EVALUATION,
    evaluateRegentFence: async () => ({ action: "no-op", reason: "kill switch off" }),
    isRegentHeartbeatNudgeEnabled: async () => false,
    resolveHeartbeatRoot: async () => scratchRoot,
    getRoster: async () => [],
    readStallEvidence: async () => ({ roster: [], supervisors: new Map(), staleAlphas: new Set() }),
    readInFlightRowsWithoutLiveAlpha: () => readInFlightRowsWithoutLiveAlpha(checkDependencies(databasePath)),
    now: () => new Date("2026-10-15T02:30:00Z"),
    stdout: () => undefined,
    stderr: () => undefined,
  } as unknown as KeepGoingDependencies;
  return { nudgeTexts, deps };
}

async function tickOnce(tick: RegentTick): Promise<void> {
  await tendRegent(tick.deps, async (_target, deps, band, families, inFlightRows) => {
    tick.nudgeTexts.push(buildRegentNudgeText(deps.now, band!, families, inFlightRows));
  });
}

test("an in-flight row whose Alpha is dead is reported to the Regent", async () => {
  const tick = regentTick(databaseWithStrandedRows);
  await tickOnce(tick);
  assert.equal(tick.nudgeTexts.length, 1);
  const [nudge] = tick.nudgeTexts;
  assert.match(nudge!, /In-flight rows with no live Alpha:/);
  assert.match(nudge!, new RegExp(`rowcheckdead \\(agent ${DEAD_ALPHA}, DEAD\\)`));
  assert.match(nudge!, new RegExp(`rowcheckcomplete \\(agent ${COMPLETE_ALPHA}, COMPLETE\\)`));
  assert.match(nudge!, new RegExp(`rowcheckreaped \\(agent ${REAPED_ALPHA}, reaped\\)`));
  assert.match(nudge!, new RegExp(`rowcheckghost \\(agent ${NEVER_REGISTERED_ALPHA}, never registered\\)`));
  assert.doesNotMatch(nudge!, /rowchecklive|rowcheckopen/);
});

test("an in-flight row whose Alpha is still starting is not reported", async () => {
  const findings: InFlightRowWithoutLiveAlpha[] = await readInFlightRowsWithoutLiveAlpha(
    checkDependencies(databaseWithStrandedRows),
  );
  assert.deepEqual(
    findings.map((finding) => finding.objectiveCode).sort(),
    ["rowcheckcomplete", "rowcheckdead", "rowcheckghost", "rowcheckreaped"],
  );
});

test("an in-flight row with no live Alpha is reported again on the next tick", async () => {
  const tick = regentTick(databaseWithStrandedRows);
  await tickOnce(tick);
  await tickOnce(tick);
  assert.equal(tick.nudgeTexts.length, 2);
  for (const nudge of tick.nudgeTexts) {
    assert.match(nudge, new RegExp(`rowcheckdead \\(agent ${DEAD_ALPHA}, DEAD\\)`));
  }
});

test("a Regent is not nudged about in-flight rows when every one has a live or starting Alpha", async () => {
  const tick = regentTick(databaseWithOnlyHealthyRows);
  await tickOnce(tick);
  assert.deepEqual(tick.nudgeTexts, []);
});

test("checking in-flight rows never changes a row", async () => {
  const untouchedDatabase = path.join(scratchRoot, "untouched.sqlite3");
  seedInFlightRows(untouchedDatabase, { rowcheckdead: DEAD_ALPHA, rowchecklive: LIVE_ALPHA });
  const before = readEveryRow(untouchedDatabase);
  await runCheckInFlightRows(checkDependencies(untouchedDatabase), () => undefined);
  await tickOnce(regentTick(untouchedDatabase));
  assert.deepEqual(readEveryRow(untouchedDatabase), before);
});

test("check-in-flight-rows exits 1 when a row has no live Alpha and 0 when none do", async () => {
  let strandedOutput = "";
  const strandedExit = await runCheckInFlightRows(checkDependencies(databaseWithStrandedRows), (text) => {
    strandedOutput += text;
  });
  assert.equal(strandedExit, 1);
  assert.match(strandedOutput, /4 in-flight row\(s\) with no live Alpha/);
  assert.match(strandedOutput, new RegExp(`rowcheckghost \\(agent ${NEVER_REGISTERED_ALPHA}, never registered\\)`));

  let healthyOutput = "";
  const healthyExit = await runCheckInFlightRows(checkDependencies(databaseWithOnlyHealthyRows), (text) => {
    healthyOutput += text;
  });
  assert.equal(healthyExit, 0);
  assert.match(healthyOutput, /none found/);
});
