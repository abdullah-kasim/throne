import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  readAgentRole,
  writeIdentity,
} from "../src/agentdata/identity-data.service.ts";
import {
  readSpawnSpec,
  writeSpawnSpec,
} from "../src/agentdata/spawn-data-contracts.ts";
import { writeQueueLaunchLinkage } from "../src/create-agent/queue-launch-writeback.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import { reapAgent } from "../src/reap-agent/lifecycle.ts";
import {
  resolveQueueReapEvidence,
  writeQueueReapOutcome,
} from "../src/reap-agent/queue-reap-writeback.ts";
import { reapDepsWithNothingToTearDown } from "../src/reap-agent/reap-agent-test-fixtures.ts";
import {
  openRegentQueueStore,
  RegentQueueItemStatus,
} from "../src/regent-queue/regent-queue.store.ts";

const OBJECTIVE_CODE = "releasecheck";
const ALPHA_NAME = "alpha-releasecheck-01";
const SHADOW_NAME = "shadow-releasecheck-01-worker";
const SPAWNED_LONG_AGO = "2026-10-15T01:00:00.000Z";

let scratchRoot: string;
let nextCourtNumber = 0;

before(async () => {
  scratchRoot = await mkdtemp(path.join(tmpdir(), "row-release-"));
});

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

interface Court {
  readonly ledgerBaseDir: string;
  readonly databasePath: string;
  readonly itemId: string;
}

async function courtWithRow(
  status: typeof RegentQueueItemStatus.Open | typeof RegentQueueItemStatus.InFlight,
): Promise<Court> {
  nextCourtNumber += 1;
  const directory = path.join(scratchRoot, `court-${nextCourtNumber}`);
  const databasePath = path.join(directory, "regent-queue.sqlite3");
  const store = openRegentQueueStore(databasePath);
  try {
    const item = store.insertItem({
      objectiveCode: OBJECTIVE_CODE,
      body: "INTENT: a row given back by a reap",
    });
    if (status === RegentQueueItemStatus.InFlight) {
      store.transitionStatus(item.id, RegentQueueItemStatus.InFlight, {
        agentName: ALPHA_NAME,
      });
    }
    return {
      ledgerBaseDir: path.join(directory, "data"),
      databasePath,
      itemId: item.id,
    };
  } finally {
    store.close();
  }
}

async function registerCampaignAgent(
  court: Court,
  name: string,
  role: "Alpha" | "Shadow",
): Promise<void> {
  await writeIdentity(
    name,
    {
      role,
      supervisor: role === "Alpha" ? "Regent" : ALPHA_NAME,
      escalation: "Regent",
      objectiveCode: OBJECTIVE_CODE,
    },
    court.ledgerBaseDir,
  );
  await writeSpawnSpec(
    name,
    {
      harness: "claude",
      model: "opus",
      effort: 2,
      cwd: `/worktrees/${name}`,
      spawned_at: SPAWNED_LONG_AGO,
      objective_code: OBJECTIVE_CODE,
      tasked_at: SPAWNED_LONG_AGO,
    },
    court.ledgerBaseDir,
  );
}

function rowStatus(court: Court): string {
  const store = openRegentQueueStore(court.databasePath);
  try {
    const row = store.readItem(court.itemId);
    assert.ok(row);
    return row.status;
  } finally {
    store.close();
  }
}

interface ReapResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function reapAbandoned(court: Court, name: string): Promise<ReapResult> {
  const deps = reapDepsWithNothingToTearDown({
    listAgents: async () => [],
    closeAgentTab: async () => {},
    readAgentRole: (agentName) => readAgentRole(agentName, court.ledgerBaseDir),
    readSpawnSpec: (agentName) => readSpawnSpec(agentName, court.ledgerBaseDir),
    resolveQueueReapEvidence: (agentName, reason) =>
      resolveQueueReapEvidence(agentName, reason, {
        ledgerBaseDir: court.ledgerBaseDir,
        findDeliveryCommitHash: async () => undefined,
      }),
    readQueueLinkage: async () => undefined,
    writeQueueReapOutcome: (agentName, reason, writebackDeps) =>
      writeQueueReapOutcome(agentName, reason, {
        ...writebackDeps,
        openStore: () => openRegentQueueStore(court.databasePath),
        ledgerBaseDir: court.ledgerBaseDir,
        writeStdout: () => {},
      }),
    appendLaunchLedgerStatus: async () => {},
    launchLedgerPath: path.join(court.ledgerBaseDir, "launch-ledger.jsonl"),
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeToStdout = process.stdout.write;
  const writeToStderr = process.stderr.write;
  process.stdout.write = ((text: string) => {
    stdout.push(text);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((text: string) => {
    stderr.push(text);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = await reapAgent(
      {
        name,
        reason: "abandoned",
        force: true,
        bypassMarker: false,
        archiveAbandonedUnmerged: false,
      },
      deps,
      new Set(),
    );
    return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = writeToStdout;
    process.stderr.write = writeToStderr;
  }
}

function herdrPane(name: string): HerdrAgent {
  return {
    agent: "claude",
    name,
    agentStatus: "idle",
    cwd: `/worktrees/${name}`,
    focused: false,
    paneId: "pane-1",
    tabId: "tab-1",
    terminalId: "terminal-1",
  };
}

async function launchWriteBack(
  court: Court,
  listHerdrAgents: () => Promise<HerdrAgent[]>,
): Promise<string> {
  let printed = "";
  await writeQueueLaunchLinkage(
    ALPHA_NAME,
    { kind: "campaign", objectiveCode: OBJECTIVE_CODE },
    {
      openStore: () => openRegentQueueStore(court.databasePath),
      readTreeBase: async () => null,
      listAgents: listHerdrAgents,
      ledgerBaseDir: court.ledgerBaseDir,
      writeStdout: (text) => {
        printed += text;
      },
    },
  );
  return printed;
}

test("reaping a campaign Alpha whose row is not in flight says the row was not released and fails", async () => {
  const court = await courtWithRow(RegentQueueItemStatus.Open);
  await registerCampaignAgent(court, ALPHA_NAME, "Alpha");

  const reap = await reapAbandoned(court, ALPHA_NAME);

  assert.equal(reap.exitCode, 1);
  assert.match(reap.stderr, /queue row was NOT released/);
  assert.match(reap.stderr, /throne render-queue/);
  assert.doesNotMatch(reap.stdout, /Reaped "/);
  assert.equal(rowStatus(court), RegentQueueItemStatus.Open);
});

test("reaping a campaign Alpha whose row is in flight releases the row and reports it reaped", async () => {
  const court = await courtWithRow(RegentQueueItemStatus.InFlight);
  await registerCampaignAgent(court, ALPHA_NAME, "Alpha");

  const reap = await reapAbandoned(court, ALPHA_NAME);

  assert.equal(reap.exitCode, 0);
  assert.doesNotMatch(reap.stderr, /NOT released/);
  assert.equal(rowStatus(court), RegentQueueItemStatus.Abandoned);
});

test("reaping a Shadow with no queue row stays quiet", async () => {
  const court = await courtWithRow(RegentQueueItemStatus.InFlight);
  await registerCampaignAgent(court, SHADOW_NAME, "Shadow");

  const reap = await reapAbandoned(court, SHADOW_NAME);

  assert.equal(reap.exitCode, 0);
  assert.doesNotMatch(reap.stderr, /NOT released/);
  assert.equal(rowStatus(court), RegentQueueItemStatus.InFlight);
});

test("a launch write-back for an agent reaped during its own spawn does not mark the row in flight", async () => {
  const court = await courtWithRow(RegentQueueItemStatus.Open);

  const printed = await launchWriteBack(court, async () => []);

  assert.match(printed, /queue linkage not recorded for "alpha-releasecheck-01"/);
  assert.equal(rowStatus(court), RegentQueueItemStatus.Open);
});

test("a launch write-back for an agent whose ledger survives but whose pane is gone does not mark the row in flight", async () => {
  const court = await courtWithRow(RegentQueueItemStatus.Open);
  await registerCampaignAgent(court, ALPHA_NAME, "Alpha");

  const printed = await launchWriteBack(court, async () => []);

  assert.match(printed, /no longer registered in herdr/);
  assert.equal(rowStatus(court), RegentQueueItemStatus.Open);
});

test("a launch write-back for a live agent marks the row in flight under its name", async () => {
  const court = await courtWithRow(RegentQueueItemStatus.Open);
  await registerCampaignAgent(court, ALPHA_NAME, "Alpha");

  const printed = await launchWriteBack(court, async () => [herdrPane(ALPHA_NAME)]);

  assert.equal(printed, "");
  assert.equal(rowStatus(court), RegentQueueItemStatus.InFlight);
});

test("a launch write-back for a live agent still marks the row in flight when herdr cannot list its agents", async () => {
  const court = await courtWithRow(RegentQueueItemStatus.Open);
  await registerCampaignAgent(court, ALPHA_NAME, "Alpha");

  const printed = await launchWriteBack(court, async () => {
    throw new Error("herdr server is not answering");
  });

  assert.doesNotMatch(printed, /write-back failed/);
  assert.equal(rowStatus(court), RegentQueueItemStatus.InFlight);
});
