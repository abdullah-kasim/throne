import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Account, AccountsConfig } from "../account/accounts-config.ts";
import { claudeProjectsFolderOf } from "../account/agent-account.ts";
import {
  readSpawnSpec,
  writeSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { writeIdentity, writeOpeningPrompt } from "../agentdata/identity-data.service.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { readHarnessUsage } from "../harness-routing/policy/usage.ts";
import type { StartOptions } from "../herdr/herdr-create.contracts.ts";
import { AgentResolutionError, type HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import { openMessageQueueStore } from "../message-queue/message-queue.store.ts";
import type { UsagePayload } from "../plan-usage-remaining/telemetry.types.ts";
import { runCreateAgent } from "./create.ts";
import type { CreateAgentDeps } from "./create.types.ts";
import { writeModelAllowlist } from "./model-allowlist.ts";
import { fakeQueueStoreWithOpenItem } from "./policy-test-fixtures.ts";

const COMPANY_DOMAIN = "company.example";
const PERSONAL_DOMAIN = "personal.example";
const COMPANY_OBJECTIVE = "acb";
const COMPANY_ALPHA = "alpha-acb-01";

interface AccountState {
  readonly loggedIn: boolean;
  readonly emailDomain: string;
  readonly fivehourUsedPct: number;
  readonly weeklyUsedPct: number;
  readonly usageRefused?: boolean;
}

interface Court {
  readonly config: AccountsConfig | null;
  readonly accounts: Readonly<Record<string, AccountState>>;
  readonly registered?: Readonly<Record<string, SpawnSpec>>;
}

interface CreateAgentRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly launches: number;
  readonly launchAccounts: readonly (string | undefined)[];
  readonly accountUsageReads: number;
  readonly spawn: SpawnSpec | null;
  readonly identity: string;
}

let scratchRoot: string;
let secondaryFolder: string;

before(async () => {
  scratchRoot = await mkdtemp(path.join(tmpdir(), "create-agent-account-"));
  secondaryFolder = path.join(scratchRoot, "accounts", "secondary");
});

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

function primary(): Account {
  return { name: "primary", harness: "claude", folder: path.join(os.homedir(), ".claude") };
}

function secondary(): Account {
  return { name: "secondary", harness: "claude", folder: secondaryFolder };
}

function twoAccounts(longRunningAccount?: string): AccountsConfig {
  return {
    accounts: [primary(), secondary()],
    ...(longRunningAccount === undefined ? {} : { longRunningAccount }),
    companyLogin: { emailDomain: COMPANY_DOMAIN },
    mcpServersAllowedOnEveryAccount: [],
  };
}

function account(fivehourUsedPct: number, weeklyUsedPct: number, emailDomain = PERSONAL_DOMAIN): AccountState {
  return { loggedIn: true, emailDomain, fivehourUsedPct, weeklyUsedPct };
}

function refusedWithHttp429(): AccountState {
  return { ...account(0, 0), usageRefused: true };
}

function balancingOff(): AccountsConfig {
  return { ...twoAccounts(), balancing: false };
}

function loggedOut(): AccountState {
  return { loggedIn: false, emailDomain: PERSONAL_DOMAIN, fivehourUsedPct: 0, weeklyUsedPct: 0 };
}

function usagePayload(state: AccountState): UsagePayload {
  return {
    source: "api",
    harness: "claude",
    as_of: "2026-10-16T00:00:00.000Z",
    windows: [
      { cap_window: "5h", used_pct: state.fivehourUsedPct, remaining_pct: 100 - state.fivehourUsedPct },
      { cap_window: "weekly", used_pct: state.weeklyUsedPct, remaining_pct: 100 - state.weeklyUsedPct },
    ],
  } as UsagePayload;
}

function accountUsagePayload(state: AccountState): UsagePayload {
  return state.usageRefused === true
    ? ({ source: "error", harness: "claude", error: "HTTP 429" } as unknown as UsagePayload)
    : usagePayload(state);
}

function livePane(name: string): HerdrAgent {
  return {
    agent: "claude",
    name,
    agentStatus: "idle",
    cwd: "/tmp",
    focused: false,
    paneId: `pane-${name}`,
    tabId: `tab-${name}`,
    terminalId: `terminal-${name}`,
  };
}

interface RunRecord {
  launches: number;
  launchAccounts: (string | undefined)[];
  accountUsageReads: number;
  stdout: string[];
  stderr: string[];
}

function courtDeps(court: Court, dataDir: string, record: RunRecord) {
  const launched = new Set<string>();
  const stateOf = (candidate: Account) => court.accounts[candidate.name]!;
  const deps: CreateAgentDeps = {
    resolveAgent: (async (name: string) => {
      if (launched.has(name)) return livePane(name);
      throw new AgentResolutionError(name, 0);
    }) as unknown as CreateAgentDeps["resolveAgent"],
    startAgent: (async (name: string, options: StartOptions) => {
      record.launches++;
      record.launchAccounts.push(options.account);
      launched.add(name);
    }) as unknown as CreateAgentDeps["startAgent"],
    resumeRegisteredAgentInRestoredTab: (async (name: string, options: StartOptions) => {
      record.launches++;
      record.launchAccounts.push(options.account);
      launched.add(name);
      return { kind: "resumed" };
    }) as unknown as CreateAgentDeps["resumeRegisteredAgentInRestoredTab"],
    closeAgentTab: async () => {},
    ensureCodexTrust: (async () => {}) as unknown as CreateAgentDeps["ensureCodexTrust"],
    probeCodexTrustPrompt: (async () => {}) as unknown as CreateAgentDeps["probeCodexTrustPrompt"],
    writeIdentity: (name, identity) => writeIdentity(name, identity, dataDir),
    writeOpeningPrompt: (name, text) => writeOpeningPrompt(name, text, dataDir),
    writeSpawnSpec: (name, spec) => writeSpawnSpec(name, spec, dataDir),
    readSpawnSpec: (name) => readSpawnSpec(name, dataDir),
    writeModelAllowlist: (options) => writeModelAllowlist({ ...options, dataDir }),
    registrationExists: async (name) => court.registered?.[name] !== undefined,
    removeRegistration: async () => {},
    openMessageQueueStore: () => openMessageQueueStore(path.join(dataDir, "queue.sqlite3")),
    confirmSpawnTasking: (async () => ({ kind: "confirmed" })) as unknown as CreateAgentDeps["confirmSpawnTasking"],
    correctSettingsRightAfterSpawn: async () => "",
    installHerdrOperatorSkill: (async (role: string) => ({ kind: "not-an-operator-role", role })) as never,
    resolveMemoryDir: (async () => {
      throw new Error("memory is not resolved in this test");
    }) as never,
    writeQueueLaunchLinkage: async () => {},
    getClaudeUsage: async () => usagePayload(stateOf(primary())),
    getCodexUsage: (async () => ({ source: "api", harness: "codex", as_of: "2026-10-16T00:00:00.000Z", windows: [] })) as never,
    getOpenCodeGoUsage: (async () => ({})) as never,
    readAccountsConfig: () => court.config,
    readAccountReading: async (candidate) => {
      const state = stateOf(candidate);
      record.accountUsageReads++;
      return {
        name: candidate.name,
        loggedIn: state.loggedIn,
        isCompany: state.loggedIn && state.emailDomain === COMPANY_DOMAIN,
        loginDescription: state.emailDomain,
        usage: state.loggedIn ? readHarnessUsage(accountUsagePayload(state)) : { ok: false },
      };
    },
    readAccountLogin: async (candidate) => {
      const state = stateOf(candidate);
      return {
        loggedIn: state.loggedIn,
        emailDomain: state.emailDomain,
        isCompany: state.loggedIn && state.emailDomain === COMPANY_DOMAIN,
      };
    },
    readAccountUsage: async (candidate) => {
      record.accountUsageReads++;
      return accountUsagePayload(stateOf(candidate));
    },
    openQueueStore: fakeQueueStoreWithOpenItem(COMPANY_OBJECTIVE),
    validateShadowTree: async () => undefined,
    readTreeBase: async () => null,
    planPresetName: "AnthropicOnly",
    targetEffort: 1,
    readModelAllowlist: async () => undefined,
    sleep: async () => {},
    now: () => "2026-10-16T00:00:00.000Z",
    writeStdout: (text) => record.stdout.push(text),
    writeStderr: (text) => record.stderr.push(text),
  };
  return deps;
}

async function createAgent(court: Court, args: string[]): Promise<CreateAgentRun> {
  const dataDir = await mkdtemp(path.join(scratchRoot, "ledger-"));
  for (const [name, spec] of Object.entries(court.registered ?? {})) {
    await writeSpawnSpec(name, spec, dataDir);
  }
  const record: RunRecord = { launches: 0, launchAccounts: [], accountUsageReads: 0, stdout: [], stderr: [] };
  const name = args[args.indexOf("--name") + 1]!;
  const code = await runCreateAgent(["--cwd", "/tmp", ...args], courtDeps(court, dataDir, record));
  const identity = await readFile(path.join(dataDir, name, "identity.md"), "utf8").catch(() => "");
  return {
    code,
    stdout: record.stdout.join(""),
    stderr: record.stderr.join(""),
    launches: record.launches,
    launchAccounts: record.launchAccounts,
    accountUsageReads: record.accountUsageReads,
    spawn: await readSpawnSpec(name, dataDir),
    identity,
  };
}

function agentArgs(name: string, ...extra: string[]): string[] {
  return ["--model", "sonnet", "--name", name, "--supervisor", "Regent", "--role", "Agent", "--non-campaign",
    "--bypass-preset-agent", ...extra];
}

function stagerArgs(name: string): string[] {
  return ["--model", "opus", "--name", name, "--supervisor", "Regent", "--role", "Stager", "--non-campaign"];
}

test("a new agent goes to the primary while it is under 90% used and to the secondary once it reaches 90%", async () => {
  const underNinety = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(50, 89), secondary: account(0, 0) } },
    agentArgs("agent-under-ninety"),
  );
  assert.equal(underNinety.code, 0, underNinety.stderr);
  assert.equal(underNinety.spawn?.account, "primary");
  const atNinety = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(90, 10), secondary: account(0, 0) } },
    agentArgs("agent-at-ninety"),
  );
  assert.equal(atNinety.code, 0, atNinety.stderr);
  assert.equal(atNinety.spawn?.account, "secondary");
  assert.match(atNinety.stdout, /Spawned "agent-at-ninety".*account secondary \(secondary is under 90% used/);
});

test("a new agent on the secondary is launched with its account", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(95, 10), secondary: account(0, 0) } },
    agentArgs("agent-launched-on-secondary"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.launchAccounts, ["secondary"]);
});

test("create-agent with an account option overrides the balancer", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(0, 0), secondary: account(0, 0) } },
    agentArgs("agent-named-secondary", "--account", "secondary"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.spawn?.account, "secondary");
  assert.match(run.stdout, /account secondary \(account secondary named for this agent\)/);
});

test("create-agent refuses an unknown account naming the configured accounts", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(0, 0), secondary: account(0, 0) } },
    agentArgs("agent-unknown-account", "--account", "tertiary"),
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /unknown account "tertiary"; configured accounts: primary \(.*\), secondary \(.*\)/);
  assert.equal(run.launches, 0);
  assert.equal(run.spawn, null);
});

test("create-agent refuses a logged-out account", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(0, 0), secondary: loggedOut() } },
    agentArgs("agent-logged-out-account", "--account", "secondary"),
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /account "secondary" is not logged in; configured accounts: primary/);
  assert.equal(run.launches, 0);
  assert.equal(run.spawn, null);
});

test("a Stager is created on the long-running account whatever the usage", async () => {
  const run = await createAgent(
    { config: twoAccounts("secondary"), accounts: { primary: account(0, 0), secondary: account(95, 95) } },
    stagerArgs("stager-long-running"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.spawn?.account, "secondary");
  assert.match(run.stdout, /account secondary \(Stager runs on the long-running account secondary\)/);
});

test("a Shadow of a company campaign is created on the company account", async () => {
  const run = await createAgent(
    {
      config: twoAccounts(),
      accounts: { primary: account(0, 0), secondary: account(0, 0, COMPANY_DOMAIN) },
      registered: {
        [COMPANY_ALPHA]: {
          harness: HARNESS_NAMES.CLAUDE,
          model: "sonnet",
          effort: 1,
          cwd: "/tmp",
          objective_code: COMPANY_OBJECTIVE,
          account: "secondary",
          account_requirement: "company",
        },
      },
    },
    ["--model", "sonnet", "--name", "shadow-acb-company", "--supervisor", COMPANY_ALPHA, "--role", "Shadow",
      "--bypass-preset-agent"],
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.spawn?.account, "secondary");
  assert.equal(run.spawn?.account_requirement, "company");
});

test("company work waits when the company account is at its limit", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(100, 100, COMPANY_DOMAIN), secondary: account(0, 0) } },
    agentArgs("agent-company-at-limit", "--account", "company"),
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /the spawn is paused: waits for the company account primary: at its limit/);
  assert.equal(run.launches, 0);
  assert.equal(run.spawn, null);
});

test("the chosen account is recorded in spawn.json and identity.md", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(0, 0), secondary: account(0, 0) } },
    agentArgs("agent-recorded-account"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.spawn?.account, "primary");
  assert.match(run.identity, /^- \*\*Account:\*\* primary$/m);
});

test("a resumed agent keeps its recorded account", async () => {
  const registered = {
    "agent-resumed": {
      harness: HARNESS_NAMES.CLAUDE,
      model: "sonnet",
      effort: 1,
      cwd: "/tmp",
      non_campaign: true as const,
      account: "secondary",
    },
  };
  const court = { config: twoAccounts(), accounts: { primary: account(0, 0), secondary: account(95, 95) }, registered };
  const resumed = await createAgent(court, agentArgs("agent-resumed"));
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed "agent-resumed".*account secondary \(recorded at spawn\)/);
  assert.equal(resumed.spawn?.account, "secondary");
  assert.deepEqual(resumed.launchAccounts, ["secondary"]);
  const moved = await createAgent(court, agentArgs("agent-resumed", "--account", "primary"));
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /--account primary does not match its recorded account "secondary"/);
  assert.equal(moved.launches, 0);
});

test("the Claude usage gate reads the chosen account's usage", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(0, 0), secondary: account(100, 100) } },
    ["--model", "opus", "--name", "agent-exhausted-secondary", "--supervisor", "Regent", "--role", "Agent",
      "--non-campaign", "--bypass-preset-agent", "--account", "secondary"],
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /refusing final native Claude Opus launch target "agent-exhausted-secondary" — fresh usage/);
  assert.equal(run.launches, 0);
});

test("without an accounts file create-agent records no account", async () => {
  const run = await createAgent(
    { config: null, accounts: { primary: account(0, 0) } },
    agentArgs("agent-without-accounts"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.spawn?.account, undefined);
  assert.deepEqual(run.launchAccounts, [undefined]);
  assert.doesNotMatch(run.identity, /Account:/);
  assert.doesNotMatch(run.stdout, / account /);
});

test("when both accounts answer 429 the spawn goes to the primary account and does not pause", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: refusedWithHttp429(), secondary: refusedWithHttp429() } },
    agentArgs("agent-both-refused"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.spawn?.account, "primary");
  assert.doesNotMatch(run.stderr, /paused/);
});

test("when no account has a usage reading the spawn goes to the primary account and says why", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: refusedWithHttp429(), secondary: refusedWithHttp429() } },
    agentArgs("agent-no-reading"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stdout,
    /no account has a usable usage reading below its limit, so the spawn goes to the primary account primary; no usage reading: primary, secondary/,
  );
});

test("when both accounts read as full the spawn still pauses", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(100, 50), secondary: account(30, 100) } },
    agentArgs("agent-both-full"),
  );
  assert.equal(run.code, 1);
  assert.match(run.stderr, /the spawn is paused: every logged-in account is at its limit/);
  assert.equal(run.launches, 0);
  assert.equal(run.spawn, null);
});

test("an unreadable account is not counted as full when the other account is full", async () => {
  const run = await createAgent(
    { config: twoAccounts(), accounts: { primary: account(100, 100), secondary: refusedWithHttp429() } },
    agentArgs("agent-full-and-refused"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.spawn?.account, "secondary");
  assert.match(run.stdout, /so the spawn goes to secondary; no usage reading: secondary/);
});

test("with balancing off a spawn reads no usage at all and goes to the primary account", async () => {
  const run = await createAgent(
    { config: balancingOff(), accounts: { primary: account(95, 95), secondary: account(0, 0) } },
    agentArgs("agent-balancing-off"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.accountUsageReads, 0);
  assert.equal(run.spawn?.account, "primary");
  assert.match(run.stdout, /balancing is off in accounts\.json, so the spawn goes to the primary account primary/);
});

test("with balancing off an agent that names its account still gets that account", async () => {
  const run = await createAgent(
    { config: balancingOff(), accounts: { primary: account(0, 0), secondary: account(0, 0) } },
    agentArgs("agent-balancing-off-named", "--account", "secondary"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.accountUsageReads, 0);
  assert.equal(run.spawn?.account, "secondary");
  assert.deepEqual(run.launchAccounts, ["secondary"]);
  const loggedOutRun = await createAgent(
    { config: balancingOff(), accounts: { primary: account(0, 0), secondary: loggedOut() } },
    agentArgs("agent-off-named-logged-out", "--account", "secondary"),
  );
  assert.equal(loggedOutRun.code, 1);
  assert.equal(loggedOutRun.accountUsageReads, 0);
  assert.match(loggedOutRun.stderr, /account "secondary" is not logged in; configured accounts: primary \(personal\.example\), secondary \(not logged in\)/);
});

test("with balancing off company work still reads the company account's usage", async () => {
  const run = await createAgent(
    { config: balancingOff(), accounts: { primary: account(0, 0), secondary: account(0, 0, COMPANY_DOMAIN) } },
    agentArgs("agent-balancing-off-company", "--account", "company"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.accountUsageReads, 2);
  assert.equal(run.spawn?.account, "secondary");
  assert.match(run.stdout, /company work runs on the company account secondary/);
});

test("with balancing off send-agent's transcript lookup for an agent on the secondary account uses the secondary folder", async () => {
  const run = await createAgent(
    { config: balancingOff(), accounts: { primary: account(0, 0), secondary: account(0, 0) } },
    agentArgs("agent-balancing-off-transcript", "--account", "secondary"),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(claudeProjectsFolderOf(run.spawn?.account, balancingOff), path.join(secondaryFolder, "projects"));
});
