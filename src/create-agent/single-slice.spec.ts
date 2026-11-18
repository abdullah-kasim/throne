import assert from "node:assert/strict";
import test from "node:test";
import { prepareCreateAgentRequest } from "./request.ts";
import { baseDeps } from "./policy-test-fixtures.ts";
import { createAgentIdentity, persistNewAgentRecord } from "./agent-record.ts";
import type { PolicyResolution } from "./create.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { writeModelAllowlist } from "./model-allowlist.ts";
import { readSpawnSpec, type SpawnSpec, writeSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  type AgentIdentity,
  identityText,
  SHADOWED_LINE,
  SHADOWED_STANDING_INSTRUCTION,
  SINGLE_SLICE_LINE,
  SINGLE_SLICE_STANDING_INSTRUCTION,
  writeIdentity,
  writeOpeningPrompt,
} from "../agentdata/identity-data.service.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function alphaArguments(name: string, modeFlag: string): string[] {
  return [
    "--model",
    "sonnet",
    "--name",
    name,
    "--supervisor",
    "Regent",
    "--role",
    "Alpha",
    "--cwd",
    "/tmp",
    "--non-campaign",
    modeFlag,
  ];
}

function policyResolution(name: string): PolicyResolution {
  return {
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
    objectiveContract: { kind: "campaign", objectiveCode: "one" },
    routingNote: "",
    durableRoutingNote: false,
    effortOverrideNote: "",
    harnessOverrideNote: "",
    bypassedObjectiveCode: false,
    singleSlice: true,
  };
}

for (const removedFlag of ["--shadowless", "--sliceless"]) {
  test(`spawning an Alpha with ${removedFlag} is refused because the Lord removed it`, async () => {
    const { result, stderr } = await run(alphaArguments("alpha-removed-01", removedFlag));
    assert.equal(result.ok, false);
    assert.match(stderr, new RegExp(`${removedFlag} was removed by the Lord on 2026-11-04`));
    assert.match(stderr, /"Actually let's drop shadowless and sliceless\."/);
    assert.match(stderr, /--single-slice/);
    assert.match(stderr, /Nothing was registered/);
  });
}

test("only an Alpha may be spawned single-slice", async () => {
  const { result, stderr } = await run([
    "--model",
    "sonnet",
    "--name",
    "shadow-one-01",
    "--supervisor",
    "alpha-one-01",
    "--role",
    "Shadow",
    "--cwd",
    "/tmp",
    "--non-campaign",
    "--single-slice",
  ]);
  assert.equal(result.ok, false);
  assert.match(stderr, /--single-slice is refused for role "Shadow"/);
  assert.match(stderr, /add-to-queue --single-slice/);
});

test("a single-slice Alpha's identity states the single-slice contract in one paragraph", async () => {
  const { result, stderr } = await run(alphaArguments("alpha-one-01", "--single-slice"));
  assert.equal(result.ok, true, stderr);
  if (!result.ok) return;
  assert.equal(result.value.singleSlice, true);
  const identity = createAgentIdentity(result.value as never, "Regent");
  const text = identityText("alpha-one-01", identity);
  assert.ok(text.includes(SINGLE_SLICE_STANDING_INSTRUCTION));
  assert.ok(!SINGLE_SLICE_STANDING_INSTRUCTION.includes("\n"));
  assert.match(SINGLE_SLICE_STANDING_INSTRUCTION, /ONE implementation slice, `01`/);
  assert.match(SINGLE_SLICE_STANDING_INSTRUCTION, /distinct from the executor/);
  assert.match(SINGLE_SLICE_STANDING_INSTRUCTION, /2026-11-04/);
  const baseDir = await mkdtemp(path.join(tmpdir(), "identity-single-slice-"));
  try {
    await writeIdentity("alpha-one-01", identity, baseDir);
    const file = await readFile(path.join(baseDir, "alpha-one-01", "identity.md"), "utf8");
    assert.ok(file.includes(SINGLE_SLICE_LINE));
    assert.equal(file.split("**Execution mode:**").length - 1, 1);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

async function persistRecord(request: PolicyResolution, dataDir: string): Promise<boolean> {
  const deps = {
    writeIdentity: (agentName: string, identity: AgentIdentity) => writeIdentity(agentName, identity, dataDir),
    writeOpeningPrompt: (agentName: string, prompt: string) => writeOpeningPrompt(agentName, prompt, dataDir),
    writeSpawnSpec: (agentName: string, spec: SpawnSpec) => writeSpawnSpec(agentName, spec, dataDir),
    writeModelAllowlist: (options: Parameters<typeof writeModelAllowlist>[0]) =>
      writeModelAllowlist({ ...options, dataDir }),
    removeRegistration: async () => {},
    now: () => "2026-11-04T00:00:00.000Z",
    planPresetName: "AnthropicOnly",
  };
  return persistNewAgentRecord(
    request,
    deps as unknown as Parameters<typeof persistNewAgentRecord>[1],
    createAgentIdentity(request, "Regent"),
    "opening prompt",
  );
}

test("a single-slice Alpha's spawn record says single_slice", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "throne-single-slice-spawn-"));
  const name = "alpha-one-spawn-record";
  try {
    assert.equal(await persistRecord(policyResolution(name), dataDir), true);
    const spawn = await readSpawnSpec(name, dataDir);
    assert.equal(spawn?.single_slice, true);
    assert.equal(spawn?.objective_code, "one");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an agent whose old spawn record says shadowless or sliceless reads as an ordinary shadowed agent", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "throne-old-mode-spawn-"));
  const name = "alpha-old-mode";
  const ordinaryRequest: PolicyResolution = { ...policyResolution(name), singleSlice: undefined };
  try {
    assert.equal(await persistRecord(ordinaryRequest, dataDir), true);
    const spawnFile = path.join(dataDir, name, "spawn.json");
    const written = JSON.parse(await readFile(spawnFile, "utf8"));
    await writeFile(spawnFile, JSON.stringify({ ...written, shadowless: true, sliceless: true }));
    const oldRecord = await readSpawnSpec(name, dataDir);
    assert.notEqual(oldRecord, null);
    assert.equal(oldRecord?.single_slice, undefined);
    const identityFile = await readFile(path.join(dataDir, name, "identity.md"), "utf8");
    assert.ok(identityFile.includes(SHADOWED_LINE));
    assert.ok(identityText(name, createAgentIdentity(ordinaryRequest, "Regent")).includes(SHADOWED_STANDING_INSTRUCTION));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
