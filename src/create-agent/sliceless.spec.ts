import assert from "node:assert/strict";
import test from "node:test";
import { prepareCreateAgentRequest } from "./request.ts";
import { baseDeps } from "./policy-test-fixtures.ts";
import { createAgentIdentity, persistNewAgentRecord } from "./agent-record.ts";
import type { PolicyResolution } from "./create.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { writeModelAllowlist } from "./model-allowlist.ts";
import { type SpawnSpec, writeSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  type AgentIdentity,
  identityText,
  SHADOWLESS_LINE,
  SHADOWLESS_STANDING_INSTRUCTION,
  SLICELESS_LINE,
  SLICELESS_STANDING_INSTRUCTION,
  writeIdentity,
  writeOpeningPrompt,
} from "../agentdata/identity-data.service.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function run(args: string[]) {
  const stderr: string[] = [];
  const result = await prepareCreateAgentRequest(
    args,
    baseDeps({ writeStderr: (text) => stderr.push(text) }),
    "/tmp",
  );
  return { result, stderr: stderr.join("") };
}

test("--sliceless is refused for any role but Alpha and names where the authorization comes from", async () => {
  const { result, stderr } = await run([
    "--model",
    "sonnet",
    "--name",
    "shadow-slc-01",
    "--supervisor",
    "alpha-slc-01",
    "--role",
    "Shadow",
    "--cwd",
    "/tmp",
    "--non-campaign",
    "--sliceless",
  ]);
  assert.equal(result.ok, false);
  assert.match(stderr, /--sliceless is refused for role "Shadow"/);
  assert.match(stderr, /add-to-queue --sliceless/);
});

test("--sliceless on an Alpha is carried on the request as sliceless and shadowless, and the identity gets one execution-mode line", async () => {
  const { result, stderr } = await run([
    "--model",
    "sonnet",
    "--name",
    "alpha-slc-01",
    "--supervisor",
    "Regent",
    "--role",
    "Alpha",
    "--cwd",
    "/tmp",
    "--non-campaign",
    "--sliceless",
  ]);
  assert.doesNotMatch(stderr, /--sliceless is refused/);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sliceless, true);
  assert.equal(result.value.shadowless, true);
  const identity = createAgentIdentity(result.value as never, "Regent");
  assert.equal(identity.sliceless, true);
  assert.equal(identity.shadowless, true);
  const text = identityText("alpha-slc-01", identity);
  assert.ok(text.includes(SLICELESS_STANDING_INSTRUCTION));
  assert.ok(!text.includes(SHADOWLESS_STANDING_INSTRUCTION));
  const baseDir = await mkdtemp(path.join(tmpdir(), "identity-sliceless-"));
  try {
    await writeIdentity("alpha-slc-01", identity, baseDir);
    const file = await readFile(path.join(baseDir, "alpha-slc-01", "identity.md"), "utf8");
    assert.ok(file.includes(SLICELESS_LINE));
    assert.ok(!file.includes(SHADOWLESS_LINE));
    assert.equal(file.split("**Execution mode:**").length - 1, 1);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("a sliceless Alpha's spawn.json records both sliceless and shadowless", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "throne-sliceless-spawn-"));
  const name = "alpha-slc-spawn-record";
  const request: PolicyResolution = {
    flags: { supervisor: "Regent" },
    oneShot: false,
    harness: HARNESS_NAMES.CLAUDE,
    model: "sonnet",
    role: "Alpha",
    requestedName: name,
    name,
    requestedCwd: `/tmp/${name}`,
    launchHarness: HARNESS_NAMES.CLAUDE,
    launchModel: "sonnet",
    launchEffort: 1,
    cwd: `/tmp/${name}`,
    resuming: false,
    customPassthrough: [],
    objectiveContract: { kind: "campaign", objectiveCode: "slc" },
    routingNote: "",
    durableRoutingNote: false,
    capabilityOverrideNote: "",
    effortOverrideNote: "",
    harnessOverrideNote: "",
    bypassedObjectiveCode: false,
    sliceless: true,
    shadowless: true,
  };
  const deps = {
    writeIdentity: (agentName: string, identity: AgentIdentity) => writeIdentity(agentName, identity, dataDir),
    writeOpeningPrompt: (agentName: string, prompt: string) => writeOpeningPrompt(agentName, prompt, dataDir),
    writeSpawnSpec: (agentName: string, spec: SpawnSpec) => writeSpawnSpec(agentName, spec, dataDir),
    writeModelAllowlist: (options: Parameters<typeof writeModelAllowlist>[0]) =>
      writeModelAllowlist({ ...options, dataDir }),
    removeRegistration: async () => {},
    now: () => "2026-09-15T00:00:00.000Z",
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
    const spawn = JSON.parse(await readFile(path.join(dataDir, name, "spawn.json"), "utf8"));
    assert.equal(spawn.sliceless, true);
    assert.equal(spawn.shadowless, true);
    assert.equal(spawn.objective_code, "slc");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
