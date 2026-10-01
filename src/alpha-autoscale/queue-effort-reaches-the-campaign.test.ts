import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AlphaAutoscaleHostedWorker,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import type { LaunchQueueCandidate } from "../alpha-launch-queue/ready-queue.ts";
import { parseAddToQueueArgs } from "../add-to-queue/add-to-queue-runtime.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { resolveSpawnPolicy } from "../create-agent/policy.ts";
import { baseDeps, baseRequest } from "../create-agent/policy-test-fixtures.ts";
import {
  createAgentIdentity,
  persistNewAgentRecord,
} from "../create-agent/agent-record.ts";
import type { CreateAgentDeps } from "../create-agent/create.types.ts";
import { writeModelAllowlist } from "../create-agent/model-allowlist.ts";
import {
  type SpawnSpec,
  readSpawnSpec,
  writeSpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import {
  type AgentIdentity,
  writeIdentity,
  writeOpeningPrompt,
} from "../agentdata/identity-data.service.ts";
import { acquireSweepLockOfItsOwn } from "./alpha-autoscale-sweep-lock-test-fixtures.ts";

const OBJECTIVE_CODE = "brg";
const ALPHA_NAME = "alpha-brg-01";
const GLOBAL_EFFORT = 1;

const alphaUsageBypass: Partial<CreateAgentDeps> = {
  readUsageBypassAuthorizations: async () => ({
    version: 1,
    authorizations: [
      {
        authorizer: "Regent",
        objective_code: OBJECTIVE_CODE,
        recipient: ALPHA_NAME,
        evidence_locator: "test-usage-bypass",
        expires_at: "2030-01-01T00:00:00.000Z",
      },
    ],
  }),
};

async function storedRowEffort(
  fileArgs: readonly string[],
): Promise<number | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "throne-queue-effort-"));
  try {
    const filed = parseAddToQueueArgs([
      "--objective-code",
      OBJECTIVE_CODE,
      "--target-repo",
      "/tmp/example-target",
      ...fileArgs,
      "INTENT:",
      "run",
    ]);
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    try {
      const row = store.insertItem({
        objectiveCode: OBJECTIVE_CODE,
        body: "INTENT: run",
        ...(filed.effort === undefined ? {} : { effort: filed.effort }),
      });
      return store.readItem(row.id)?.effort ?? null;
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createAgentArgvFor(
  effort: number | null,
): Promise<readonly string[]> {
  const candidate: LaunchQueueCandidate = {
    name: ALPHA_NAME,
    target: "/tmp/example-target",
    dependencyReady: true,
    executableWork: true,
    harness: "claude",
    model: "opus",
    objectiveCode: OBJECTIVE_CODE,
    targetRepo: "/tmp/example-target",
    targetBranch: "main",
    baseCommit: "0".repeat(40),
    objective: "INTENT: run",
    effort,
  };
  let createAgentArgv: readonly string[] | undefined;
  const deps: AlphaAutoscaleDependencies = {
    log: () => {},
    acquireSweepLock: acquireSweepLockOfItsOwn,
    notifyOfFloorBreach: {
      resolveAgent: async () => ({ paneId: "test-pane" }) as never,
      submitToAgent: async () => {},
    },
    promoteDeferredWork: () => ({
      released: [],
      recovered: null,
      overriddenAuthority: null,
    }),
    notifyOfIdleRecovery: async () => {},
    readPressure: () => ({
      verdict: "take-more-work",
      pressure: 0,
      reasons: [],
    }),
    readReadyQueue: () => ({ state: "candidates", candidates: [candidate] }),
    autoBriefEligibleItems: () => ({ state: "staged", count: 0 }),
    readKillSwitch: () => true,
    readSpawnCooldown: () => ({ elapsed: true }),
    recordSuccessfulSpawn: () => {},
    readActiveCapacityInputs: async () => ({
      activeRecords: [],
      mutatingTargets: [],
    }),
    readLaunchLedger: async () => ({ state: "entries", entries: [] }) as never,
    resolvePublishedRuntime: () => ({
      repoRoot: "/tmp/throne-dist",
      generation: "g",
    }),
    invokeCli: async (_executable, argv) => {
      if (argv[1] === "create-agent") createAgentArgv = argv;
      return {
        outcome: "success",
        result: {
          exitCode: 0,
          stdout: "/tmp/example-target-worktree\n",
          stderr: "",
        },
      };
    },
  };
  await new AlphaAutoscaleHostedWorker(deps).runOnce();
  assert.ok(createAgentArgv, "create-agent was never invoked");
  return createAgentArgv;
}

async function launchCampaign(fileArgs: readonly string[]) {
  const argv = await createAgentArgvFor(await storedRowEffort(fileArgs));
  const effortAt = argv.indexOf("--effort");
  const requestedEffort =
    effortAt === -1 ? undefined : Number(argv[effortAt + 1]);
  const dataDir = await mkdtemp(path.join(tmpdir(), "throne-campaign-data-"));
  try {
    const recordDeps = {
      readSpawnSpec: (name: string) => readSpawnSpec(name, dataDir),
      writeIdentity: (name: string, identity: AgentIdentity) =>
        writeIdentity(name, identity, dataDir),
      writeOpeningPrompt: (name: string, prompt: string) =>
        writeOpeningPrompt(name, prompt, dataDir),
      writeSpawnSpec: (name: string, spec: SpawnSpec) =>
        writeSpawnSpec(name, spec, dataDir),
      writeModelAllowlist: (
        options: Parameters<typeof writeModelAllowlist>[0],
      ) => writeModelAllowlist({ ...options, dataDir }),
    };
    const alpha = await resolveSpawnPolicy(
      baseRequest({
        role: "Alpha",
        model: "opus",
        launchModel: "opus",
        name: ALPHA_NAME,
        requestedName: ALPHA_NAME,
        ...(requestedEffort === undefined ? {} : { requestedEffort }),
        flags: {
          supervisor: "Regent",
          "objective-code": OBJECTIVE_CODE,
          "bypass-usage": true,
          ...(argv.includes("--bypass-effort")
            ? { "bypass-effort": true }
            : {}),
        },
      }),
      baseDeps({ ...alphaUsageBypass, ...recordDeps }),
    );
    assert.equal(alpha.ok, true);
    if (!alpha.ok) throw new Error("Alpha refused");
    assert.equal(
      await persistNewAgentRecord(
        alpha.value,
        {
          ...recordDeps,
          removeRegistration: async () => {},
          now: () => "2026-09-23T00:00:00.000Z",
          planPresetName: "AnthropicOnly",
        } as unknown as Parameters<typeof persistNewAgentRecord>[1],
        createAgentIdentity(alpha.value, "Regent"),
        "opening prompt",
      ),
      true,
    );
    const shadow = await resolveSpawnPolicy(
      baseRequest({ flags: { supervisor: ALPHA_NAME, "bypass-usage": true } }),
      baseDeps(recordDeps),
    );
    assert.equal(shadow.ok, true);
    if (!shadow.ok) throw new Error("Shadow refused");
    return {
      argv,
      alphaEffort: alpha.value.launchEffort,
      shadowEffort: shadow.value.launchEffort,
      spawn: JSON.parse(
        await readFile(path.join(dataDir, ALPHA_NAME, "spawn.json"), "utf8"),
      ),
      identity: await readFile(
        path.join(dataDir, ALPHA_NAME, "identity.md"),
        "utf8",
      ),
    };
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a queue row filed at high effort launches its Alpha and that Alpha's Shadows at effort 3", async () => {
  const campaign = await launchCampaign(["--effort", "high"]);
  const effortAt = campaign.argv.indexOf("--effort");
  assert.equal(campaign.argv[effortAt + 1], "3");
  assert.ok(campaign.argv.includes("--bypass-effort"));
  assert.equal(campaign.alphaEffort, 3);
  assert.equal(campaign.spawn.campaign_effort, 3);
  assert.ok(
    campaign.identity.includes(
      "- **Campaign effort:** 3 (from the Lord-filed queue row)",
    ),
  );
  assert.equal(campaign.shadowEffort, 3);
});

test("a queue row filed without an effort launches its campaign exactly as before", async () => {
  const campaign = await launchCampaign([]);
  assert.equal(campaign.argv.includes("--effort"), false);
  assert.equal(campaign.argv.includes("--bypass-effort"), false);
  assert.equal(campaign.alphaEffort, GLOBAL_EFFORT);
  assert.equal("campaign_effort" in campaign.spawn, false);
  assert.ok(!campaign.identity.includes("Campaign effort"));
  assert.equal(campaign.shadowEffort, GLOBAL_EFFORT);
});
