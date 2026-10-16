import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  AgentStatusesCommand,
  type AgentStatusesCommandDependencies,
} from "../src/agent-statuses/agent-statuses.command.ts";
import {
  listCompletedAgentNames,
  listRegisteredAgentNames,
  readAgentSpawnStillStarting,
  readAgentStatusRole,
} from "../src/agent-statuses/agent-statuses-registry.ts";
import { getAgentStatusesRoster } from "../src/agent-statuses/agent-statuses-roster.ts";
import {
  writeIdentity,
  writeOpeningPrompt,
} from "../src/agentdata/identity-data.service.ts";
import {
  markSpawnFinished,
  readSpawnSpec,
  writeSpawnSpec,
  type SpawnSpec,
} from "../src/agentdata/spawn-data-contracts.ts";
import { SPAWN_STARTING_BOUND_MS } from "../src/agentdata/spawn-starting.ts";
import type { CreateAgentDeps, PolicyResolution } from "../src/create-agent/create.types.ts";
import { resolveSpawnPolicy } from "../src/create-agent/policy.ts";
import {
  baseDeps,
  baseRequest,
  SHADOW_NAME,
} from "../src/create-agent/policy-test-fixtures.ts";
import { runResidentAgent } from "../src/create-agent/resident-agent.ts";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";
import { openMessageQueueStore } from "../src/message-queue/message-queue.store.ts";
import { findUntaskedAgents } from "../src/no-idling/find-untasked-agents.ts";
import { classifyCandidateThroneTab } from "../src/no-idling/stale-tab-report.ts";
import { reapAgent } from "../src/reap-agent/lifecycle.ts";
import { reapDepsWithNothingToTearDown } from "../src/reap-agent/reap-agent-test-fixtures.ts";
import type { ReapDeps, ReapRequest } from "../src/reap-agent/reap-agent.types.ts";

const EMPTY_CLAUDE_COMPOSER_SCREEN_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "claude-live-fleet-done-with-progress-chrome.ansi",
);
const AN_AGE_INSIDE_THE_STRANDED_WINDOW_MS = 120_000;

let scratchRoot: string;
let nextLedgerNumber = 0;

before(async () => {
  scratchRoot = await mkdtemp(path.join(tmpdir(), "spawn-still-starting-"));
});

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

function freshLedgerDirectory(): string {
  nextLedgerNumber += 1;
  return path.join(scratchRoot, `ledger-${nextLedgerNumber}`);
}

function fakeHerdrPane(name: string): HerdrAgent {
  return {
    agent: "claude",
    name,
    agentStatus: "idle",
    cwd: `/tmp/${name}`,
    focused: false,
    paneId: "pane-1",
    tabId: "tab-1",
    terminalId: "terminal-1",
  };
}

interface StalledSpawn {
  readonly reachedTheRegistrationWait: Promise<void>;
  readonly letHerdrRegisterIt: () => void;
  readonly letHerdrFailIt: () => void;
  readonly exitCode: Promise<number>;
}

function spawnDepsInLedger(
  ledgerDirectory: string,
  resolveAgent: CreateAgentDeps["resolveAgent"],
): CreateAgentDeps {
  return baseDeps({
    now: () => new Date().toISOString(),
    writeIdentity: (name, identity) => writeIdentity(name, identity, ledgerDirectory),
    writeOpeningPrompt: (name, text) => writeOpeningPrompt(name, text, ledgerDirectory),
    writeSpawnSpec: (name, spec) => writeSpawnSpec(name, spec, ledgerDirectory),
    markSpawnFinished: (name, finishedAtIso) =>
      markSpawnFinished(name, finishedAtIso, ledgerDirectory),
    writeModelAllowlist: async () => {},
    readTreeBase: async () => null,
    resolveMemoryDir: async () => {
      throw new Error("no memory directory in this test");
    },
    installHerdrOperatorSkill: async (role) => ({
      kind: "not-an-operator-role",
      role,
    }),
    writeStderr: () => {},
    writeStdout: () => {},
    startAgent: (async () => {}) as unknown as CreateAgentDeps["startAgent"],
    resolveAgent,
    correctSettingsRightAfterSpawn: async () => {},
    openMessageQueueStore: () =>
      openMessageQueueStore(path.join(ledgerDirectory, "message-queue.sqlite3")),
  });
}

async function shadowReadyToLaunch(deps: CreateAgentDeps): Promise<PolicyResolution> {
  const policy = await resolveSpawnPolicy(baseRequest(), deps);
  assert.equal(policy.ok, true);
  return (policy as { value: PolicyResolution }).value;
}

async function startSpawnThatStallsBeforeItsOpeningPrompt(
  ledgerDirectory: string,
): Promise<StalledSpawn> {
  let signalReached!: () => void;
  const reachedTheRegistrationWait = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let settleRegistration!: (registered: boolean) => void;
  const registration = new Promise<boolean>((resolve) => {
    settleRegistration = resolve;
  });
  const deps = spawnDepsInLedger(ledgerDirectory, (async (name: string) => {
    signalReached();
    if (!(await registration)) throw new Error("herdr lost the launched pane");
    return fakeHerdrPane(name);
  }) as unknown as CreateAgentDeps["resolveAgent"]);
  const request = await shadowReadyToLaunch(deps);
  return {
    reachedTheRegistrationWait,
    letHerdrRegisterIt: () => settleRegistration(true),
    letHerdrFailIt: () => settleRegistration(false),
    exitCode: runResidentAgent(request, deps),
  };
}

async function stateShownByAgentStatuses(
  ledgerDirectory: string,
  name: string,
): Promise<string | undefined> {
  const dependencies: AgentStatusesCommandDependencies = {
    readAgentStatusesDesiredState: async () => "running",
    getAgentStatusesRoster: () =>
      getAgentStatusesRoster({
        listLiveAgentStatuses: async () => [],
        listRegisteredAgentNames: () => listRegisteredAgentNames(ledgerDirectory),
        listCompletedAgentNames: () => listCompletedAgentNames(ledgerDirectory),
        readAgentStatusRole: (agentName) => readAgentStatusRole(agentName, ledgerDirectory),
        loadAgentStatusesRegentTitle: async () => "Regent",
        readAgentPaneTail: async () => "",
      }),
    readAgentSpawnStillStarting: (agentName) =>
      readAgentSpawnStillStarting(agentName, ledgerDirectory),
  };
  const printed: string[] = [];
  const writeToStdout = process.stdout.write;
  process.stdout.write = ((text: string) => {
    printed.push(text);
    return true;
  }) as typeof process.stdout.write;
  try {
    await new AgentStatusesCommand(dependencies).run([]);
  } finally {
    process.stdout.write = writeToStdout;
  }
  const row = printed
    .join("")
    .split("\n")
    .find((line) => line.startsWith(`${name} `));
  return row?.trim().split(/\s{2,}/)[2];
}

interface ObservedReap {
  readonly exitCode: number;
  readonly ledgersArchived: number;
  readonly stderr: string;
}

async function reapInLedger(
  ledgerDirectory: string,
  request: Partial<ReapRequest> & Pick<ReapRequest, "name">,
): Promise<ObservedReap> {
  let ledgersArchived = 0;
  const deps: ReapDeps = reapDepsWithNothingToTearDown({
    listAgents: async () => [],
    readSpawnSpec: (name) => readSpawnSpec(name, ledgerDirectory),
    archiveAgentData: async () => {
      ledgersArchived += 1;
      return "archived";
    },
    resolveQueueReapEvidence: async () => ({ deliveryCommit: null }),
    readQueueLinkage: async () => undefined,
    writeQueueReapOutcome: async () => {},
    appendLaunchLedgerStatus: async () => {},
    launchLedgerPath: path.join(ledgerDirectory, "launch-ledger.jsonl"),
  });
  const stderr: string[] = [];
  const writeToStderr = process.stderr.write;
  const writeToStdout = process.stdout.write;
  process.stderr.write = ((text: string) => {
    stderr.push(text);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const exitCode = await reapAgent(
      {
        force: true,
        bypassMarker: false,
        archiveAbandonedUnmerged: false,
        reason: "abandoned",
        ...request,
      },
      deps,
      new Set(),
    );
    return { exitCode, ledgersArchived, stderr: stderr.join("") };
  } finally {
    process.stderr.write = writeToStderr;
    process.stdout.write = writeToStdout;
  }
}

async function writeSpawnRecordAged(
  ledgerDirectory: string,
  name: string,
  ageMs: number,
  record: Pick<SpawnSpec, "spawn_finished_at">,
): Promise<void> {
  await writeIdentity(
    name,
    { supervisor: "alpha-test", escalation: "Regent", role: "Shadow" },
    ledgerDirectory,
  );
  await writeOpeningPrompt(name, "the opening prompt", ledgerDirectory);
  await writeSpawnSpec(
    name,
    {
      harness: "claude",
      model: "sonnet",
      effort: 1,
      cwd: `/tmp/${name}`,
      spawned_at: new Date(Date.now() - ageMs).toISOString(),
      tasked_at: null,
      ...record,
    },
    ledgerDirectory,
  );
}

async function writeOneStartingAndOneFinishedSpawnWithoutPrompt(
  ledgerDirectory: string,
): Promise<{ startingName: string; finishedName: string }> {
  const startingName = "shadow-spawn-still-starting";
  const finishedName = "shadow-spawn-finished-without-prompt";
  await writeSpawnRecordAged(ledgerDirectory, startingName, AN_AGE_INSIDE_THE_STRANDED_WINDOW_MS, {
    spawn_finished_at: null,
  });
  await writeSpawnRecordAged(ledgerDirectory, finishedName, AN_AGE_INSIDE_THE_STRANDED_WINDOW_MS, {
    spawn_finished_at: new Date().toISOString(),
  });
  return { startingName, finishedName };
}

test("an agent whose spawn is still running is shown as starting", async () => {
  const ledgerDirectory = freshLedgerDirectory();
  const spawn = await startSpawnThatStallsBeforeItsOpeningPrompt(ledgerDirectory);
  await spawn.reachedTheRegistrationWait;

  assert.equal(await stateShownByAgentStatuses(ledgerDirectory, SHADOW_NAME), "STARTING");

  spawn.letHerdrRegisterIt();
  assert.equal(await spawn.exitCode, 0);
  assert.equal(await stateShownByAgentStatuses(ledgerDirectory, SHADOW_NAME), "DEAD");
});

test("an agent whose spawn is still running cannot be reaped, even with --force", async () => {
  const ledgerDirectory = freshLedgerDirectory();
  const spawn = await startSpawnThatStallsBeforeItsOpeningPrompt(ledgerDirectory);
  await spawn.reachedTheRegistrationWait;

  const reap = await reapInLedger(ledgerDirectory, { name: SHADOW_NAME, force: true });

  assert.equal(reap.exitCode, 1);
  assert.equal(reap.ledgersArchived, 0);
  assert.match(reap.stderr, /spawn is still starting/);
  assert.match(reap.stderr, /--spawn-process-gone/);
  spawn.letHerdrRegisterIt();
  assert.equal(await spawn.exitCode, 0);
});

test("a starting agent can be reaped when the caller says its spawn process is gone", async () => {
  const ledgerDirectory = freshLedgerDirectory();
  const spawn = await startSpawnThatStallsBeforeItsOpeningPrompt(ledgerDirectory);
  await spawn.reachedTheRegistrationWait;

  const reap = await reapInLedger(ledgerDirectory, {
    name: SHADOW_NAME,
    force: true,
    spawnProcessGone: true,
  });

  assert.equal(reap.exitCode, 0);
  assert.equal(reap.ledgersArchived, 1);
  spawn.letHerdrRegisterIt();
  await spawn.exitCode;
});

test("a spawn that fails still records that it finished", async () => {
  const ledgerDirectory = freshLedgerDirectory();
  const spawn = await startSpawnThatStallsBeforeItsOpeningPrompt(ledgerDirectory);
  await spawn.reachedTheRegistrationWait;
  assert.equal((await readSpawnSpec(SHADOW_NAME, ledgerDirectory))?.spawn_finished_at, null);

  spawn.letHerdrFailIt();

  assert.equal(await spawn.exitCode, 1);
  const finishedAt = (await readSpawnSpec(SHADOW_NAME, ledgerDirectory))?.spawn_finished_at;
  assert.equal(typeof finishedAt, "string");
  assert.notEqual(await stateShownByAgentStatuses(ledgerDirectory, SHADOW_NAME), "STARTING");
});

test("an agent whose spawn record outlived the bound is no longer starting", async () => {
  const ledgerDirectory = freshLedgerDirectory();
  const name = "shadow-spawn-outlived-its-bound";
  await writeSpawnRecordAged(ledgerDirectory, name, SPAWN_STARTING_BOUND_MS + 1_000, {
    spawn_finished_at: null,
  });

  assert.equal(await stateShownByAgentStatuses(ledgerDirectory, name), "DEAD");
  const reap = await reapInLedger(ledgerDirectory, { name, force: true });
  assert.equal(reap.exitCode, 0);
  assert.equal(reap.ledgersArchived, 1);
});

test("a spawn still starting is not redelivered as stranded, and the same spawn once finished is", async () => {
  const ledgerDirectory = freshLedgerDirectory();
  const emptyComposerScreen = await readFile(EMPTY_CLAUDE_COMPOSER_SCREEN_PATH, "utf8");
  const { startingName, finishedName } =
    await writeOneStartingAndOneFinishedSpawnWithoutPrompt(ledgerDirectory);
  const classify = (name: string) =>
    classifyCandidateThroneTab(
      { label: name, tabId: "tab-1", paneCount: 1, reason: "test candidate" },
      new Set([name]),
      [{ paneId: "pane-1", tabId: "tab-1", terminalId: "terminal-1" }],
      ledgerDirectory,
      {
        readVisibleAnsi: async () => emptyComposerScreen,
        fileExists: async () => true,
        readSpawnSpec,
      },
    );

  assert.equal((await classify(startingName)).kind, "none");
  assert.equal((await classify(finishedName)).kind, "stranded");
});

test("a spawn still starting is not reported as untasked, and the same spawn once finished is", async () => {
  const ledgerDirectory = freshLedgerDirectory();
  const { startingName, finishedName } =
    await writeOneStartingAndOneFinishedSpawnWithoutPrompt(ledgerDirectory);
  const idleLiveShadow = (name: string) => ({
    name,
    lifecycle: "live" as const,
    liveStatus: "idle" as const,
    reportLanded: false,
    role: "Shadow",
    focused: false,
  });

  const untasked = await findUntaskedAgents({
    roster: [idleLiveShadow(startingName), idleLiveShadow(finishedName)],
    readSpawnSpec: (name) => readSpawnSpec(name, ledgerDirectory),
  });

  assert.deepEqual(untasked.map((agent) => agent.name), [finishedName]);
});
