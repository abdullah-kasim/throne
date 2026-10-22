import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listRegisteredAgentNames } from "../agent-statuses/agent-statuses-registry.ts";
import { listForkedAgentNames } from "../agentdata/fork-evidence.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { hasUncommittedChanges } from "../git-lifecycle/checkout-standing.ts";
import {
  GitLifecycleService,
  pathExists,
} from "../git-lifecycle/git-command.service.ts";
import { resumeRegisteredAgentInRestoredTabWithDeps } from "../herdr/herdr-agent-recovery.ts";
import type {
  AgentStartEvidence,
  StartOptions,
} from "../herdr/herdr-create.contracts.ts";
import type { HerdrPane, HerdrTab } from "../herdr/herdr-inventory.service.ts";
import {
  fastForwardTreeToMainWhenOnlyBehind,
  isRegisteredStager,
} from "../stager-tree-refresh/stager-tree-refresh.ts";
import {
  STAGER_REUSE_OUTCOMES,
  reuseRegisteredStager,
  type StagerReuseEffects,
} from "./stager-reuse.ts";

const RECORDED_SESSION = "0d3c2a1e-5b6f-4c7d-8e9f-a0b1c2d3e4f5";

interface WorktreeState {
  uncommittedChanges: boolean;
  commitsAheadOfMain: number;
  commitsBehindMain: number;
}

interface Launch {
  name: string;
  cwd: string | undefined;
  argv: readonly string[];
  paneId: string | "new-tab";
}

interface FakeCourt {
  ledgerDir: string;
  worktreesDir: string;
  worktrees: Map<string, WorktreeState>;
  liveAgentNames: string[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  harnessPaneIds: Set<string>;
  unresumableSessions: Set<string>;
  launchAttempts: Launch[];
  launches: Launch[];
  fastForwardedWorktrees: string[];
  openingPrompts: string[];
}

interface DeadStager {
  name: string;
  role?: string;
  spawnedAt: string;
  switchedAt?: string;
  forkedFrom?: string;
  worktreeIsMissing?: true;
  worktree?: Partial<WorktreeState>;
}

async function fakeCourt(): Promise<FakeCourt> {
  const root = await mkdtemp(path.join(os.tmpdir(), "throne-stager-reuse-"));
  return {
    ledgerDir: path.join(root, "data"),
    worktreesDir: path.join(root, "worktrees"),
    worktrees: new Map(),
    liveAgentNames: [],
    tabs: [],
    panes: [],
    harnessPaneIds: new Set(),
    unresumableSessions: new Set(),
    launchAttempts: [],
    launches: [],
    fastForwardedWorktrees: [],
    openingPrompts: [],
  };
}

function worktreeOf(court: FakeCourt, name: string): string {
  return path.join(court.worktreesDir, name);
}

async function registerDeadStager(
  court: FakeCourt,
  stager: DeadStager,
): Promise<void> {
  const ledger = path.join(court.ledgerDir, stager.name);
  const worktree = worktreeOf(court, stager.name);
  await mkdir(ledger, { recursive: true });
  await writeFile(
    path.join(ledger, "identity.md"),
    `# Identity — ${stager.name}\n\n- **Role:** ${stager.role ?? "Stager"}\n`,
  );
  await writeFile(
    path.join(ledger, "spawn.json"),
    JSON.stringify({
      harness: "claude",
      model: "opus",
      effort: 3,
      cwd: worktree,
      session_id: RECORDED_SESSION,
      spawned_at: stager.spawnedAt,
      switched_at: stager.switchedAt,
      forked_from: stager.forkedFrom,
    }),
  );
  if (stager.worktreeIsMissing) return;
  await mkdir(worktree, { recursive: true });
  court.worktrees.set(worktree, {
    uncommittedChanges: false,
    commitsAheadOfMain: 0,
    commitsBehindMain: 0,
    ...stager.worktree,
  });
}

function seatTab(
  court: FakeCourt,
  label: string,
  pane: "bare-shell" | "harness",
): string {
  const tabId = `tab-${court.tabs.length + 1}`;
  const paneId = `pane-${court.tabs.length + 1}`;
  court.tabs.push({ tabId, label, paneCount: 1, workspaceId: "workspace-1" });
  court.panes.push({ paneId, tabId, terminalId: `terminal-${paneId}` });
  if (pane === "harness") court.harnessPaneIds.add(paneId);
  return paneId;
}

function fakeGit(court: FakeCourt): GitLifecycleService {
  return new GitLifecycleService(async (args, cwd) => {
    const worktree = court.worktrees.get(cwd)!;
    const [command] = args;
    if (command === "merge") court.fastForwardedWorktrees.push(cwd);
    const stdout =
      command === "status" && worktree.uncommittedChanges
        ? " M AGENTS.md\n"
        : command === "rev-list"
          ? `${worktree.commitsAheadOfMain}\t${worktree.commitsBehindMain}\n`
          : "";
    return { stdout, stderr: "" };
  });
}

function launchIn(
  court: FakeCourt,
  name: string,
  paneId: Launch["paneId"],
  opts: StartOptions,
): void {
  const launch = { name, cwd: opts.cwd, argv: opts.argv, paneId };
  court.launchAttempts.push(launch);
  if (opts.argv.some((argument) => court.unresumableSessions.has(argument))) {
    throw new Error("no conversation found for the recorded session");
  }
  court.launches.push(launch);
}

function reuseEffects(court: FakeCourt): StagerReuseEffects {
  const git = fakeGit(court);
  const herdr = {
    listTabs: async () => court.tabs,
    listPanes: async () => court.panes,
    listNameOwners: async () => [],
    getPaneProcessInfo: async (paneId: string) => ({
      paneId,
      foregroundProcesses: court.harnessPaneIds.has(paneId)
        ? [{ name: "claude", argv: ["/pinned/claude"], pid: 7 }]
        : [{ name: "bash", argv: ["-bash"], pid: 3 }],
    }),
    renameAgent: async () => {},
    startInTab: async (name: string, paneId: string, opts: StartOptions) => {
      launchIn(court, name, paneId, opts);
      return paneId;
    },
    startAgent: async (name: string, opts: StartOptions) => {
      launchIn(court, name, "new-tab", opts);
      return {} as AgentStartEvidence;
    },
    closePane: async () => {},
    sleep: async () => {},
  };
  return {
    evidence: {
      listRegisteredAgentNames: () => listRegisteredAgentNames(court.ledgerDir),
      isRegisteredStager: (name) => isRegisteredStager(name, court.ledgerDir),
      readSpawnSpec: (name) => readSpawnSpec(name, court.ledgerDir),
      readForkedAgentNames: () => listForkedAgentNames(court.ledgerDir),
      pathExists,
      hasUncommittedChanges: (worktree) => hasUncommittedChanges(worktree, git),
    },
    listLiveAgentNames: async () => court.liveAgentNames,
    listTabs: herdr.listTabs,
    findRestoredAgentTab: async (label) => {
      const labelled = court.tabs.filter((tab) => tab.label === label);
      const pane = court.panes.find((candidate) => candidate.tabId === labelled[0]?.tabId);
      return labelled.length !== 1 || pane === undefined || court.harnessPaneIds.has(pane.paneId)
        ? null
        : { tabId: pane.tabId, paneId: pane.paneId };
    },
    fastForwardWorktreeToMain: (worktree) =>
      fastForwardTreeToMainWhenOnlyBehind(worktree, git),
    resume: {
      readSpawnSpec: (name) => readSpawnSpec(name, court.ledgerDir),
      resumeRegisteredAgentInRestoredTab: (name, opts) =>
        resumeRegisteredAgentInRestoredTabWithDeps(name, opts, herdr),
      deliverOpeningPrompt: async (name) => {
        court.openingPrompts.push(name);
      },
      pathExists,
      throneRoot: court.worktreesDir,
      readAccountsConfig: () => null,
      readAgentRole: async () => undefined,
      log: () => {},
      warn: () => {},
    },
    log: () => {},
  };
}

function reuse(court: FakeCourt) {
  return reuseRegisteredStager(reuseEffects(court));
}

async function ledgerFilesOf(court: FakeCourt, name: string) {
  const ledger = path.join(court.ledgerDir, name);
  const fileNames = (await readdir(ledger)).sort();
  return Promise.all(
    fileNames.map(async (fileName) => ({
      fileName,
      text: await readFile(path.join(ledger, fileName), "utf8"),
    })),
  );
}

function assertOnlyBroughtBack(
  court: FakeCourt,
  outcome: Awaited<ReturnType<typeof reuse>>,
  name: string,
): void {
  assert.deepEqual(outcome, {
    kind: STAGER_REUSE_OUTCOMES.REUSED,
    name,
    worktree: worktreeOf(court, name),
  });
  assert.deepEqual(
    court.launches.map((launch) => ({ name: launch.name, cwd: launch.cwd })),
    [{ name, cwd: worktreeOf(court, name) }],
  );
}

function assertNothingLaunched(
  court: FakeCourt,
  outcome: Awaited<ReturnType<typeof reuse>>,
): void {
  assert.deepEqual(outcome, { kind: STAGER_REUSE_OUTCOMES.NONE_REUSABLE });
  assert.deepEqual(court.launchAttempts, []);
  assert.deepEqual(court.fastForwardedWorktrees, []);
}

async function courtWithAnOlderStagerAnd(newest: Omit<DeadStager, "name" | "spawnedAt">) {
  const court = await fakeCourt();
  await registerDeadStager(court, { name: "stager-older", spawnedAt: "2026-10-01T00:00:00.000Z" });
  await registerDeadStager(court, { name: "stager-newest", spawnedAt: "2026-10-08T00:00:00.000Z", ...newest });
  return court;
}

test("with no live Stager the newest registered dead Stager is brought back under its own name and worktree", async () => {
  const court = await fakeCourt();
  await registerDeadStager(court, { name: "stager-spawned-last", spawnedAt: "2026-10-05T00:00:00.000Z" });
  await registerDeadStager(court, {
    name: "stager-switched-last",
    spawnedAt: "2026-09-01T00:00:00.000Z",
    switchedAt: "2026-10-08T00:00:00.000Z",
  });

  assertOnlyBroughtBack(court, await reuse(court), "stager-switched-last");
  assert.deepEqual(court.openingPrompts, ["stager-switched-last"]);
});

test("a dead Stager whose worktree is missing is not reused", async () => {
  const court = await courtWithAnOlderStagerAnd({ worktreeIsMissing: true });

  assertOnlyBroughtBack(court, await reuse(court), "stager-older");
});

test("a dead Stager whose worktree has uncommitted changes is not reused", async () => {
  const court = await courtWithAnOlderStagerAnd({ worktree: { uncommittedChanges: true } });

  assertOnlyBroughtBack(court, await reuse(court), "stager-older");
});

test("a forked Stager is not reused", async () => {
  const court = await courtWithAnOlderStagerAnd({ forkedFrom: "stager-older" });

  assertOnlyBroughtBack(court, await reuse(court), "stager-older");
});

test("only one Stager is brought back even when several could be", async () => {
  const court = await courtWithAnOlderStagerAnd({});
  await registerDeadStager(court, { name: "stager-oldest", spawnedAt: "2026-09-01T00:00:00.000Z" });

  assertOnlyBroughtBack(court, await reuse(court), "stager-newest");
  assert.equal(court.launchAttempts.length, 1);
});

test("a reused Stager comes back in its restored tab when one exists", async () => {
  const court = await courtWithAnOlderStagerAnd({});
  const restoredPaneId = seatTab(court, "stager-newest", "bare-shell");

  assertOnlyBroughtBack(court, await reuse(court), "stager-newest");
  assert.equal(court.launches[0]!.paneId, restoredPaneId);
});

test("a reused Stager opens a new tab of its own name when no tab carries it", async () => {
  const court = await courtWithAnOlderStagerAnd({});
  seatTab(court, "stager-older", "bare-shell");

  assertOnlyBroughtBack(court, await reuse(court), "stager-newest");
  assert.equal(court.launches[0]!.paneId, "new-tab");
});

test("a Stager whose name is already carried by a tab that cannot be reused is not given a second tab", async () => {
  const carriedByTwoTabs = await courtWithAnOlderStagerAnd({});
  seatTab(carriedByTwoTabs, "stager-newest", "bare-shell");
  seatTab(carriedByTwoTabs, "stager-newest", "bare-shell");
  const carriedByARunningHarness = await courtWithAnOlderStagerAnd({});
  seatTab(carriedByARunningHarness, "stager-newest", "harness");

  for (const court of [carriedByTwoTabs, carriedByARunningHarness]) {
    assertNothingLaunched(court, await reuse(court));
  }
});

test("a reused Stager resumes its recorded session", async () => {
  const court = await courtWithAnOlderStagerAnd({});

  assertOnlyBroughtBack(court, await reuse(court), "stager-newest");
  assert.deepEqual(court.launches[0]!.argv.slice(-2), ["--resume", RECORDED_SESSION]);
});

test("a reused Stager starts a fresh session under the same name and worktree when its session cannot be resumed", async () => {
  const court = await courtWithAnOlderStagerAnd({});
  court.unresumableSessions.add(RECORDED_SESSION);

  assertOnlyBroughtBack(court, await reuse(court), "stager-newest");
  assert.equal(court.launchAttempts.length, 2);
  assert.ok(court.launchAttempts[0]!.argv.includes(RECORDED_SESSION));
  assert.ok(!court.launches[0]!.argv.includes("--resume"));
});

test("a reused Stager's worktree is fast-forwarded to main only when that is a pure fast-forward", async () => {
  const onlyBehindMain = await courtWithAnOlderStagerAnd({ worktree: { commitsBehindMain: 2 } });
  const divergedFromMain = await courtWithAnOlderStagerAnd({
    worktree: { commitsBehindMain: 2, commitsAheadOfMain: 1 },
  });

  assertOnlyBroughtBack(onlyBehindMain, await reuse(onlyBehindMain), "stager-newest");
  assertOnlyBroughtBack(divergedFromMain, await reuse(divergedFromMain), "stager-newest");
  assert.deepEqual(onlyBehindMain.fastForwardedWorktrees, [worktreeOf(onlyBehindMain, "stager-newest")]);
  assert.deepEqual(divergedFromMain.fastForwardedWorktrees, []);
});

test("the other dead Stager ledgers are left exactly as they were", async () => {
  const court = await courtWithAnOlderStagerAnd({});
  seatTab(court, "stager-older", "bare-shell");
  const ledgerBefore = await ledgerFilesOf(court, "stager-older");
  const tabsBefore = structuredClone(court.tabs);

  assertOnlyBroughtBack(court, await reuse(court), "stager-newest");
  assert.deepEqual(await ledgerFilesOf(court, "stager-older"), ledgerBefore);
  assert.deepEqual(court.tabs, tabsBefore);
  assert.deepEqual((await readdir(court.ledgerDir)).sort(), ["stager-newest", "stager-older"]);
});

test("with no Stager that can be reused nothing is launched and the caller is told so", async () => {
  const court = await courtWithAnOlderStagerAnd({ forkedFrom: "stager-older" });
  court.liveAgentNames.push("stager-older");
  await registerDeadStager(court, { name: "alpha-dead", role: "Alpha", spawnedAt: "2026-10-09T00:00:00.000Z" });

  assertNothingLaunched(court, await reuse(court));
});
