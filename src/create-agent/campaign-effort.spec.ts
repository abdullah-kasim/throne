import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSpawnPolicy } from "./policy.ts";
import { baseDeps, baseRequest, SUPERVISOR_NAME } from "./policy-test-fixtures.ts";
import { createAgentIdentity, persistNewAgentRecord } from "./agent-record.ts";
import type { CreateAgentDeps, PolicyResolution } from "./create.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { writeModelAllowlist } from "./model-allowlist.ts";
import { type SpawnSpec, writeSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  type AgentIdentity,
  writeIdentity,
  writeOpeningPrompt,
} from "../agentdata/identity-data.service.ts";

const ALPHA_NAME = "alpha-brg-campaign-effort";
const alphaUsageBypass: Partial<CreateAgentDeps> = {
  readUsageBypassAuthorizations: async () => ({
    version: 1,
    authorizations: [
      {
        authorizer: "Regent",
        objective_code: "brg",
        recipient: ALPHA_NAME,
        evidence_locator: "test-usage-bypass",
        expires_at: "2030-01-01T00:00:00.000Z",
      },
    ],
  }),
};
const CAMPAIGN_EFFORT_LINE = "- **Campaign effort:** 4 (from the Lord-filed queue row)";

function supervisorWithCampaignEffort(campaignEffort: number | undefined) {
  return (async (name: string) =>
    name === SUPERVISOR_NAME
      ? {
          harness: HARNESS_NAMES.CLAUDE,
          model: "sonnet",
          effort: campaignEffort ?? 1,
          cwd: "/tmp/alpha-brg-model-allowlist",
          objective_code: "brg",
          ...(campaignEffort === undefined ? {} : { campaign_effort: campaignEffort }),
        }
      : null) as unknown as CreateAgentDeps["readSpawnSpec"];
}

async function persistedRecord(request: PolicyResolution) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "throne-campaign-effort-"));
  const deps = {
    writeIdentity: (agentName: string, identity: AgentIdentity) =>
      writeIdentity(agentName, identity, dataDir),
    writeOpeningPrompt: (agentName: string, prompt: string) =>
      writeOpeningPrompt(agentName, prompt, dataDir),
    writeSpawnSpec: (agentName: string, spec: SpawnSpec) =>
      writeSpawnSpec(agentName, spec, dataDir),
    writeModelAllowlist: (options: Parameters<typeof writeModelAllowlist>[0]) =>
      writeModelAllowlist({ ...options, dataDir }),
    removeRegistration: async () => {},
    now: () => "2026-09-23T00:00:00.000Z",
    planPresetName: "AnthropicOnly",
  };
  try {
    assert.equal(
      await persistNewAgentRecord(
        request,
        deps as unknown as Parameters<typeof persistNewAgentRecord>[1],
        createAgentIdentity(request, "Regent"),
        "opening prompt",
      ),
      true,
    );
    return {
      spawn: JSON.parse(await readFile(path.join(dataDir, request.name, "spawn.json"), "utf8")),
      identity: await readFile(path.join(dataDir, request.name, "identity.md"), "utf8"),
    };
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function alphaRequest(overrides: Partial<PolicyResolution> = {}): PolicyResolution {
  return {
    ...baseRequest({ role: "Alpha", name: ALPHA_NAME, requestedName: ALPHA_NAME }),
    flags: { supervisor: "Regent" },
    objectiveContract: { kind: "campaign", objectiveCode: "brg" },
    launchEffort: 1,
    routingNote: "",
    durableRoutingNote: false,
    capabilityOverrideNote: "",
    effortOverrideNote: "",
    harnessOverrideNote: "",
    bypassedObjectiveCode: false,
    ...overrides,
  };
}

test("an Alpha launched at an explicit effort records that campaign effort in its identity and spawn record", async () => {
  const errors: string[] = [];
  const result = await resolveSpawnPolicy(
    baseRequest({
      role: "Alpha",
      model: "opus",
      launchModel: "opus",
      name: ALPHA_NAME,
      requestedName: ALPHA_NAME,
      requestedEffort: 4,
      flags: { supervisor: "Regent", "objective-code": "brg", "bypass-effort": true, "bypass-usage": true },
    }),
    baseDeps({ ...alphaUsageBypass, writeStderr: (text) => errors.push(text) }),
  );
  assert.equal(result.ok, true, errors.join(""));
  if (!result.ok) return;
  assert.equal(result.value.launchEffort, 4);
  assert.equal(result.value.campaignEffort, 4);
  const { spawn, identity } = await persistedRecord(
    alphaRequest({ launchEffort: 4, campaignEffort: 4 }),
  );
  assert.equal(spawn.campaign_effort, 4);
  assert.ok(identity.includes(CAMPAIGN_EFFORT_LINE));
});

test("a Shadow spawned under an Alpha with a campaign effort runs at that effort without any effort flag", async () => {
  const errors: string[] = [];
  const result = await resolveSpawnPolicy(
    baseRequest(),
    baseDeps({
      readSpawnSpec: supervisorWithCampaignEffort(4),
      writeStderr: (text) => errors.push(text),
    }),
  );
  assert.equal(result.ok, true, errors.join(""));
  if (!result.ok) return;
  assert.equal(result.value.launchEffort, 4);
  assert.equal(result.value.campaignEffort, undefined);
});

test("a Shadow asking for a different effort than its campaign's is refused without the effort bypass", async () => {
  const errors: string[] = [];
  const refused = await resolveSpawnPolicy(
    baseRequest({ requestedEffort: 2 }),
    baseDeps({
      readSpawnSpec: supervisorWithCampaignEffort(4),
      writeStderr: (text) => errors.push(text),
    }),
  );
  assert.equal(refused.ok, false);
  assert.match(errors.join(""), /requested effort 2 diverges/);
  const bypassed = await resolveSpawnPolicy(
    baseRequest({
      requestedEffort: 2,
      flags: { supervisor: SUPERVISOR_NAME, "bypass-usage": true, "bypass-effort": true },
    }),
    baseDeps({ readSpawnSpec: supervisorWithCampaignEffort(4) }),
  );
  assert.equal(bypassed.ok, true);
  if (!bypassed.ok) return;
  assert.equal(bypassed.value.launchEffort, 2);
});

test("an Alpha launched without an explicit effort records no campaign effort and its Shadows use the global effort", async () => {
  const alpha = await resolveSpawnPolicy(
    baseRequest({
      role: "Alpha",
      model: "opus",
      launchModel: "opus",
      name: ALPHA_NAME,
      requestedName: ALPHA_NAME,
      flags: { supervisor: "Regent", "objective-code": "brg", "bypass-usage": true },
    }),
    baseDeps(alphaUsageBypass),
  );
  assert.equal(alpha.ok, true);
  if (!alpha.ok) return;
  assert.equal(alpha.value.campaignEffort, undefined);
  const { spawn, identity } = await persistedRecord(alphaRequest());
  assert.equal("campaign_effort" in spawn, false);
  assert.ok(!identity.includes("Campaign effort"));
  const shadow = await resolveSpawnPolicy(
    baseRequest(),
    baseDeps({ readSpawnSpec: supervisorWithCampaignEffort(undefined) }),
  );
  assert.equal(shadow.ok, true);
  if (!shadow.ok) return;
  assert.equal(shadow.value.launchEffort, 1);
});
