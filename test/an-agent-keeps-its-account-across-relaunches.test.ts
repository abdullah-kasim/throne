import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

import type { ReadAccountsConfig } from "../src/account/agent-account.ts";
import {
  accountsConfigPath,
  parseAccountsConfig,
  writeAccountsConfig,
  type AccountsConfig,
} from "../src/account/accounts-config.ts";
import type { SpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";
import type { StartOptions } from "../src/herdr/herdr-create.contracts.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import { resurrectRegent, type ResurrectDeps } from "../src/regent-state/regent-state.service.ts";
import {
  restartHarnesses,
  type RestartHarnessesDeps,
} from "../src/restart-harnesses/restart-harnesses-runtime.ts";
import { checkAgentRuntimeModelAcceptance } from "../src/session/runtime-model-acceptance.ts";
import { switchAgentModel } from "../src/switch-agent-model/switch-agent-model.ts";
import type { SwitchTransactionDeps } from "../src/switch-agent-model/transaction/transaction-contracts.ts";
import { THRONE_HOME_ENV } from "../src/shared-policy/throne-home.ts";
import {
  resumeOrphan,
  type StartupResumeContract,
} from "../src/throne-startup/throne-startup-reconciliation.service.ts";

const SESSION_ID = "0f6f2a51-7c1e-4d0b-9a55-3f1f5f0c2b9e";
const RECORDED_MODEL = "opus";

let scratchRoot: string;
let secondaryFolder: string;

before(async () => {
  scratchRoot = await mkdtemp(path.join(tmpdir(), "relaunch-account-"));
  secondaryFolder = path.join(scratchRoot, "accounts", "secondary");
});

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

function twoAccounts(longRunningAccount?: string): AccountsConfig {
  return {
    accounts: [
      { name: "primary", harness: "claude", folder: path.join(os.homedir(), ".claude") },
      { name: "secondary", harness: "claude", folder: secondaryFolder },
    ],
    ...(longRunningAccount === undefined ? {} : { longRunningAccount }),
    mcpServersAllowedOnEveryAccount: [],
  };
}

function recordedAgent(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    harness: "claude",
    model: RECORDED_MODEL,
    effort: 2,
    cwd: scratchRoot,
    session_id: SESSION_ID,
    ...overrides,
  };
}

interface ResumeCourt {
  readonly contract: StartupResumeContract;
  readonly launches: StartOptions[];
  readonly records: Map<string, SpawnSpec>;
}

function resumeCourt(
  config: AccountsConfig | null,
  records: Record<string, SpawnSpec>,
  roles: Record<string, string> = {},
): ResumeCourt {
  const launches: StartOptions[] = [];
  const recordsByName = new Map(Object.entries(records));
  const contract: StartupResumeContract = {
    readSpawnSpec: async (name) => recordsByName.get(name) ?? null,
    resumeRegisteredAgentInRestoredTab: async (_name, options) => {
      launches.push(options);
      return { kind: "new-tab-launched" };
    },
    deliverOpeningPrompt: async () => {},
    pathExists: async () => true,
    throneRoot: scratchRoot,
    readAccountsConfig: () => config,
    readAgentRole: async (name) => roles[name],
    log: () => {},
    warn: () => {},
  };
  return { contract, launches, records: recordsByName };
}

function liveAgent(name: string): HerdrAgent {
  return {
    agent: "claude",
    name,
    agentStatus: "idle",
    cwd: scratchRoot,
    focused: false,
    paneId: `pane-${name}`,
    tabId: `tab-${name}`,
    terminalId: `terminal-${name}`,
    sessionId: SESSION_ID,
  };
}

interface RestartRun {
  readonly launches: StartOptions[];
  readonly liveModelAccounts: (string | undefined)[];
  readonly recordAfter: SpawnSpec | undefined;
}

interface RestartCourt {
  readonly deps: RestartHarnessesDeps;
  readonly court: ResumeCourt;
  readonly liveModelAccounts: (string | undefined)[];
  readonly stoppedPanes: Set<string>;
}

function restartCourt(name: string, record: SpawnSpec | null, readConfig: ReadAccountsConfig): RestartCourt {
  const resume = resumeCourt(null, record === null ? {} : { [name]: record });
  const court = { ...resume, contract: { ...resume.contract, readAccountsConfig: readConfig } };
  const liveModelAccounts: (string | undefined)[] = [];
  const stoppedPanes = new Set<string>();
  const deps: RestartHarnessesDeps = {
    listAgents: async () => [liveAgent(name)],
    currentPaneId: async () => undefined,
    getPaneProcessInfo: async (paneId) => ({
      paneId,
      foregroundProcesses: stoppedPanes.has(paneId) ? [] : [{ name: "claude", argv: ["claude"], pid: 4242 }],
    }),
    signalProcess: () => {
      stoppedPanes.add(`pane-${name}`);
    },
    sleep: async () => {},
    now: () => 0,
    readSpawnSpec: async (agentName) => court.records.get(agentName) ?? null,
    writeSpawnSpec: async (agentName, spec) => {
      court.records.set(agentName, spec);
    },
    readLiveModel: async (_agent, recordedAccount) => {
      liveModelAccounts.push(recordedAccount);
      return RECORDED_MODEL;
    },
    readHarnessRecord: async () => undefined,
    resume: (agentName) => resumeOrphan(agentName, court.contract),
    readAccountsConfig: readConfig,
    configuredEffort: async () => undefined,
    renameAgent: async () => {},
    acquireRegentRestartLock: async () => "token",
    releaseRegentRestartLock: async () => {},
    log: () => {},
    warn: () => {},
  };
  return { deps, court, liveModelAccounts, stoppedPanes };
}

async function restartOneAgent(name: string, record: SpawnSpec | null, config: AccountsConfig | null): Promise<RestartRun> {
  const { deps, court, liveModelAccounts } = restartCourt(name, record, () => config);
  const outcomes = await restartHarnesses({ dryRun: false, force: false, only: [name] }, deps);
  assert.deepEqual(outcomes.map((outcome) => outcome.verdict), ["restarted"]);
  return { launches: court.launches, liveModelAccounts, recordAfter: court.records.get(name) };
}

test("an agent recorded on the secondary is resumed on the secondary after a restart", async () => {
  const run = await restartOneAgent("shadow-on-secondary", recordedAgent({ account: "secondary" }), twoAccounts());
  assert.equal(run.launches.length, 1);
  assert.equal(run.launches[0]!.account, "secondary");
  assert.ok(run.launches[0]!.argv.includes(SESSION_ID));
});

test("restart-harnesses keeps an agent's account", async () => {
  const run = await restartOneAgent(
    "alpha-on-secondary",
    recordedAgent({ account: "secondary", session_id: "11111111-2222-4333-8444-555555555555" }),
    twoAccounts(),
  );
  assert.equal(run.recordAfter?.account, "secondary");
  assert.equal(run.recordAfter?.session_id, SESSION_ID);
  assert.deepEqual(run.liveModelAccounts, ["secondary"]);
  assert.equal(run.launches[0]!.account, "secondary");
});

test("restart-harnesses stops no harness while the accounts file is malformed and names the problem", async () => {
  const malformedPath = path.join(scratchRoot, "malformed-accounts.json");
  const { deps, court, stoppedPanes } = restartCourt(
    "alpha-under-a-malformed-file",
    recordedAgent({ account: "secondary" }),
    () => parseAccountsConfig('{"accounts": [', malformedPath),
  );
  const outcomes = await restartHarnesses({ dryRun: false, force: false, only: ["alpha-under-a-malformed-file"] }, deps);
  assert.deepEqual(outcomes.map((outcome) => outcome.verdict), ["failed"]);
  assert.match(outcomes[0]!.detail, /Invalid throne accounts config in ".*malformed-accounts\.json": expected JSON/);
  assert.equal(stoppedPanes.size, 0);
  assert.equal(court.launches.length, 0);
});

test("startup recovery resumes an agent on its recorded account", async () => {
  const court = resumeCourt(twoAccounts(), { "shadow-recovered": recordedAgent({ account: "secondary" }) });
  await resumeOrphan("shadow-recovered", court.contract);
  assert.equal(court.launches.length, 1);
  assert.equal(court.launches[0]!.account, "secondary");
  assert.ok(court.launches[0]!.argv.includes(SESSION_ID));
});

test("an agent with no recorded account relaunches exactly as today", async () => {
  const court = resumeCourt(null, { "shadow-before-accounts": recordedAgent() });
  await resumeOrphan("shadow-before-accounts", court.contract);
  assert.deepEqual(Object.keys(court.launches[0]!).sort(), ["argv", "cwd"]);
});

test("an agent with no recorded account is launched on the primary when accounts are configured", async () => {
  const court = resumeCourt(twoAccounts(), { "shadow-recorded-earlier": recordedAgent() });
  await resumeOrphan("shadow-recorded-earlier", court.contract);
  assert.equal(court.launches[0]!.account, "primary");
});

interface RegentResurrection {
  readonly launches: StartOptions[];
  readonly regentDir: string;
}

async function resurrectRegentWithRecord(
  config: AccountsConfig | null,
  existingRecord?: SpawnSpec,
): Promise<RegentResurrection> {
  const launches: StartOptions[] = [];
  const regentDir = path.join(await mkdtemp(path.join(scratchRoot, "regent-data-")), "regent");
  await mkdir(regentDir);
  if (existingRecord !== undefined) await writeFile(path.join(regentDir, "spawn.json"), JSON.stringify(existingRecord));
  const deps: ResurrectDeps = {
    startAgent: (async (_name: string, options: StartOptions) => {
      launches.push(options);
    }) as unknown as ResurrectDeps["startAgent"],
    deliverOpeningPrompt: async () => {},
    readRegentHarness: async () => "claude",
    readRegentRoute: async () => undefined,
    configuredRegentLaunch: () => undefined,
    findLiveRegent: async () => null,
    installHerdrOperatorSkill: async (role) => ({ kind: "not-an-operator-role", role }),
    readAccountsConfig: () => config,
    writeStderr: () => {},
    throneRoot: scratchRoot,
    regentDir,
    spawnMarkerWindowMs: 0,
  };
  await resurrectRegent(deps);
  return { launches, regentDir };
}

async function resurrectFreshRegent(config: AccountsConfig | null): Promise<StartOptions[]> {
  return (await resurrectRegentWithRecord(config)).launches;
}

async function readRegentRecord(regentDir: string): Promise<SpawnSpec | null> {
  try {
    return JSON.parse(await readFile(path.join(regentDir, "spawn.json"), "utf8")) as SpawnSpec;
  } catch {
    return null;
  }
}

test("the Regent is launched on the long-running account", async () => {
  assert.deepEqual((await resurrectFreshRegent(twoAccounts("secondary"))).map((options) => options.account), [
    "secondary",
  ]);
  assert.deepEqual((await resurrectFreshRegent(twoAccounts())).map((options) => options.account), ["primary"]);
  assert.deepEqual((await resurrectFreshRegent(null)).map((options) => Object.keys(options).sort()), [["argv", "cwd"]]);
});

test("a Stager with no recorded account relaunches on the long-running account", async () => {
  const court = resumeCourt(
    twoAccounts("secondary"),
    { "stager-unrecorded": recordedAgent(), "shadow-unrecorded": recordedAgent() },
    { "stager-unrecorded": "Stager", "shadow-unrecorded": "Shadow" },
  );
  await resumeOrphan("stager-unrecorded", court.contract);
  await resumeOrphan("shadow-unrecorded", court.contract);
  assert.deepEqual(court.launches.map((options) => options.account), ["secondary", "primary"]);
});

test("the Regent records the account it was launched on", async () => {
  const fresh = await resurrectRegentWithRecord(twoAccounts("secondary"));
  const freshRecord = await readRegentRecord(fresh.regentDir);
  assert.equal(freshRecord?.account, "secondary");
  assert.equal(freshRecord?.harness, "claude");
  assert.equal(freshRecord?.cwd, scratchRoot);

  const recorded = await resurrectRegentWithRecord(twoAccounts("secondary"), recordedAgent());
  assert.deepEqual(await readRegentRecord(recorded.regentDir), recordedAgent({ account: "secondary" }));

  const withoutAccounts = await resurrectRegentWithRecord(null);
  assert.equal(await readRegentRecord(withoutAccounts.regentDir), null);
});

test("the Regent relaunched by restart-harnesses stays on the long-running account", async () => {
  const unrecorded = await restartOneAgent("Regent", null, twoAccounts("secondary"));
  assert.deepEqual(unrecorded.launches.map((options) => options.account), ["secondary"]);
  assert.ok(unrecorded.launches[0]!.argv.includes(SESSION_ID));
  const recordedWithoutAccount = await restartOneAgent("Regent", recordedAgent(), twoAccounts("secondary"));
  assert.deepEqual(recordedWithoutAccount.launches.map((options) => options.account), ["secondary"]);
});

async function useScratchThroneHome(context: TestContext, prefix: string): Promise<string> {
  const throneHome = await mkdtemp(path.join(scratchRoot, prefix));
  const previousThroneHome = process.env[THRONE_HOME_ENV];
  process.env[THRONE_HOME_ENV] = throneHome;
  context.after(() => {
    if (previousThroneHome === undefined) delete process.env[THRONE_HOME_ENV];
    else process.env[THRONE_HOME_ENV] = previousThroneHome;
  });
  return throneHome;
}

test("an agent's transcript is read from its own account folder", async (context) => {
  const throneHome = await useScratchThroneHome(context, "throne-home-");
  await mkdir(path.dirname(accountsConfigPath()), { recursive: true });
  await writeAccountsConfig(twoAccounts());
  const dataDir = path.join(throneHome, "data");
  const name = "shadow-transcript";
  const cwd = path.join(scratchRoot, "work");
  await mkdir(path.join(dataDir, name), { recursive: true });
  await writeFile(path.join(dataDir, name, "identity.md"), `# ${name}\n\n- **Role:** Shadow\n`);
  await writeFile(
    path.join(dataDir, name, "spawn.json"),
    JSON.stringify(recordedAgent({ cwd, account: "secondary", session_id: undefined })),
  );
  const projectFolder = path.join(secondaryFolder, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
  await mkdir(projectFolder, { recursive: true });
  await writeFile(
    path.join(projectFolder, "session.jsonl"),
    `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: RECORDED_MODEL } })}\n`,
  );

  const acceptance = await checkAgentRuntimeModelAcceptance(name, "task", dataDir);

  assert.equal(acceptance.outcome, "matching");
});

test("switch-agent-model closes no agent while the accounts file is malformed and names the problem", async (context) => {
  await useScratchThroneHome(context, "throne-home-malformed-");
  await mkdir(path.dirname(accountsConfigPath()), { recursive: true });
  await writeFile(accountsConfigPath(), '{"accounts": [');
  const name = "alpha-switching-model";
  const closed: string[] = [];
  const launches: { argv: string[]; account?: string }[] = [];
  const agent = liveAgent(name);
  const deps: SwitchTransactionDeps = {
    inspectRecipient: async () => ({
      outcome: "ready",
      agent,
      harness: "claude",
      snapshot: {} as never,
    }),
    captureStatus: async () => ({ outcome: "captured", text: `Session ID: ${SESSION_ID}\ncwd: ${scratchRoot}\n` }),
    closeAgent: async (target) => {
      closed.push(target.paneId);
    },
    withRecipientPaneLock: (_paneId, action) => action(),
    startAgent: async (_agentName, options) => {
      launches.push(options);
      throw new Error("no agent is launched in this test");
    },
    persistSpawnSpec: async () => {},
    resolvePath: async (candidate) => candidate,
    readPreservedBytes: async () => ({ identity: "identity", tree: "tree" }),
    wait: async () => {},
    now: () => new Date(0),
  };
  const result = await switchAgentModel(
    {
      agentName: name,
      spawn: recordedAgent({ account: "secondary" }),
      request: { model: "sonnet" },
      preserved: { identity: "identity", tree: "tree" },
    },
    deps,
  );
  assert.equal(result.outcome, "refused-before-close");
  assert.match(result.reason ?? "", /Invalid throne accounts config in ".*accounts\.json": expected JSON/);
  assert.deepEqual(closed, []);
  assert.deepEqual(launches, []);
});
