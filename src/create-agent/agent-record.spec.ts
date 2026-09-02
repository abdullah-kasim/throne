import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeIdentity, writeOpeningPrompt } from "../agentdata/identity-data.service.ts";
import { writeSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { planRolePool } from "../config.ts";
import { persistNewAgentRecord } from "./agent-record.ts";
import type { CreateAgentDeps, PolicyResolution } from "./create.types.ts";
import {
  MODEL_ALLOWLIST_FILE_NAME,
  writeModelAllowlist,
} from "./model-allowlist.ts";

const ALPHA_NAME = "alpha-mal-allowlist-record";
const SHADOW_NAME = "shadow-mal-01-record";
const objectiveContract = { kind: "campaign", objectiveCode: "mal" } as const;

function campaignRequest(overrides: Partial<PolicyResolution> = {}): PolicyResolution {
  return {
    flags: { supervisor: "Regent" },
    oneShot: false,
    harness: HARNESS_NAMES.CLAUDE,
    model: "sonnet",
    role: "Alpha",
    requestedName: ALPHA_NAME,
    name: ALPHA_NAME,
    requestedCwd: "/tmp/alpha-mal-allowlist-record",
    launchHarness: HARNESS_NAMES.CLAUDE,
    launchModel: "sonnet",
    launchEffort: 1,
    cwd: "/tmp/alpha-mal-allowlist-record",
    resuming: false,
    customPassthrough: [],
    objectiveContract,
    routingNote: "",
    durableRoutingNote: false,
    capabilityOverrideNote: "",
    effortOverrideNote: "",
    harnessOverrideNote: "",
    bypassedObjectiveCode: false,
    ...overrides,
  };
}

test("campaign Alpha spawn writes the owning model allowlist and Shadow spawn does not", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "throne-model-allowlist-"));
  const deps: Pick<
    CreateAgentDeps,
    | "writeIdentity"
    | "writeOpeningPrompt"
    | "writeSpawnSpec"
    | "writeModelAllowlist"
    | "removeRegistration"
    | "now"
    | "planPresetName"
  > = {
    writeIdentity: (name, identity) => writeIdentity(name, identity, dataDir),
    writeOpeningPrompt: (name, prompt) => writeOpeningPrompt(name, prompt, dataDir),
    writeSpawnSpec: (name, spec) => writeSpawnSpec(name, spec, dataDir),
    writeModelAllowlist: (options) => writeModelAllowlist({ ...options, dataDir }),
    removeRegistration: async () => {},
    now: () => "2026-08-24T00:00:00.000Z",
    planPresetName: "AnthropicOnly",
  };
  const writeRecord = async (request: PolicyResolution): Promise<boolean> =>
    persistNewAgentRecord(
      request,
      deps as unknown as Parameters<typeof persistNewAgentRecord>[1],
      { supervisor: "Regent", escalation: "Regent", role: request.role },
      "opening prompt",
    );
  try {
    assert.equal(await writeRecord(campaignRequest()), true);
    const allowlistPath = path.join(dataDir, ALPHA_NAME, MODEL_ALLOWLIST_FILE_NAME);
    const expectedPairs = [
      ...planRolePool("Alpha", "AnthropicOnly"),
      ...planRolePool("Shadow", "AnthropicOnly"),
      ...planRolePool("ShadowSlice99", "AnthropicOnly"),
    ].filter(
      (pair, index, pairs) =>
        pairs.findIndex(
          (candidate) =>
            candidate.harness === pair.harness && candidate.model === pair.model,
        ) === index,
    );
    assert.deepEqual(JSON.parse(await readFile(allowlistPath, "utf8")), {
      version: 1,
      pairs: expectedPairs,
    });

    assert.equal(
      await writeRecord(
        campaignRequest({
          role: "Shadow",
          requestedName: SHADOW_NAME,
          name: SHADOW_NAME,
          flags: { supervisor: ALPHA_NAME },
        }),
      ),
      true,
    );
    await assert.rejects(readFile(path.join(dataDir, SHADOW_NAME, MODEL_ALLOWLIST_FILE_NAME)));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
