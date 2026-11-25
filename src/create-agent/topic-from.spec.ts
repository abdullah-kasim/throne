import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { prepareCreateAgentRequest } from "./request.ts";
import { baseDeps } from "./policy-test-fixtures.ts";
import {
  createAgentIdentity,
  createAgentOpeningPrompts,
  persistNewAgentRecord,
} from "./agent-record.ts";
import type { CreateAgentDeps, PolicyResolution } from "./create.types.ts";
import type { ForkOriginEvidence } from "./fork-origin.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { writeModelAllowlist } from "./model-allowlist.ts";
import {
  type SpawnSpec,
  writeSpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import {
  type AgentIdentity,
  FORKED_FROM_LINE_PREFIX,
  FORKED_STAGER_STANDING_INSTRUCTION,
  identityText,
  writeIdentity,
  writeOpeningPrompt,
} from "../agentdata/identity-data.service.ts";
import { worktreesHome } from "../git-lifecycle/git-worktree.service.ts";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";

const ORIGIN = "stager-tenth";
const FORK = "stager-tenth-prmedia";
const BRIEF = "INTENT: publish the media.\n";

function liveStagerOrigin(
  overrides: Partial<ForkOriginEvidence> = {},
): ForkOriginEvidence {
  return {
    live: true,
    ledgerRole: "Stager",
    ledgerModel: "sonnet",
    liveModel: "opus",
    topicChanged: true,
    ...overrides,
  };
}

async function run(
  args: string[],
  evidence: ForkOriginEvidence = liveStagerOrigin(),
  brief: string | undefined = BRIEF,
  originWroteNoBrief = false,
) {
  const stderr: string[] = [];
  const result = await prepareCreateAgentRequest(
    args,
    baseDeps({
      writeStderr: (text) => stderr.push(text),
      readForkOriginEvidence: async () => evidence,
      readForkBrief: async () => (originWroteNoBrief ? undefined : brief),
    } as Partial<CreateAgentDeps>),
    "/tmp",
  );
  return { result, stderr: stderr.join("") };
}

function forkArgs(overrides: Record<string, string> = {}): string[] {
  const flags: Record<string, string> = {
    "--name": FORK,
    "--supervisor": "Regent",
    "--role": "Stager",
    "--cwd": "/tmp",
    "--non-campaign": "",
    "--topic-from": ORIGIN,
    ...overrides,
  };
  return Object.entries(flags).flatMap(([flag, value]) =>
    value === "" ? [flag] : [flag, value],
  );
}

test("a fork of a live origin Stager inherits the origin's live model and carries the origin on the request", async () => {
  const { result, stderr } = await run(forkArgs());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.forkedFrom, ORIGIN);
  assert.equal(result.value.model, "opus");
  assert.match(stderr, /resolved from the origin's live observed model/);
});

test("an explicit --model wins over the origin's live model", async () => {
  const { result, stderr } = await run(forkArgs({ "--model": "sonnet" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.model, "sonnet");
  assert.match(stderr, /resolved from the --model flag/);
});

test("an origin with no live observed model falls back to its ledger model", async () => {
  const { result, stderr } = await run(
    forkArgs(),
    liveStagerOrigin({ liveModel: undefined }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.model, "sonnet");
  assert.match(stderr, /resolved from the origin's ledger model/);
});

test("--topic-from refuses a role that is not Stager", async () => {
  const { result, stderr } = await run(
    forkArgs({ "--role": "Alpha", "--name": "tenth-prmedia" }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /--topic-from is refused for role "Alpha"/);
  assert.match(stderr, /Nothing was registered or launched/);
});

test("a topic-from fork is supervised by the Regent", async () => {
  const { result, stderr } = await run(forkArgs({ "--supervisor": ORIGIN }));
  assert.equal(result.ok, false);
  assert.match(stderr, /--topic-from stager-tenth needs --supervisor Regent/);
});

test("a fork can only be made from a Stager whose latest topic record is a change", async () => {
  const { result, stderr } = await run(
    forkArgs(),
    liveStagerOrigin({ topicChanged: false }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /the latest topic record of the origin "stager-tenth" is not a change/);
  assert.match(stderr, /Nothing was registered or launched/);
});

test("the old --fork-of flag is refused as unknown", async () => {
  const flags = forkArgs();
  flags[flags.indexOf("--topic-from")] = "--fork-of";
  const { result, stderr } = await run(flags);
  assert.equal(result.ok, false);
  assert.match(stderr, /fork-of/);
});

test("refusals name the origin, never a parent", async () => {
  const refusals = [
    await run(forkArgs({ "--role": "Alpha", "--name": "tenth-prmedia" })),
    await run(forkArgs({ "--supervisor": ORIGIN })),
    await run(forkArgs(), liveStagerOrigin({ live: false })),
    await run(forkArgs(), liveStagerOrigin({ ledgerRole: "Alpha" })),
    await run(forkArgs(), liveStagerOrigin({ topicChanged: false })),
    await run(forkArgs(), liveStagerOrigin(), BRIEF, true),
    await run(forkArgs(), liveStagerOrigin({ liveModel: undefined, ledgerModel: undefined })),
  ];
  for (const { result, stderr } of refusals) {
    assert.equal(result.ok, false);
    assert.doesNotMatch(stderr, /parent/i);
  }
});

test("--topic-from refuses an origin that is not live in the roster", async () => {
  const { result, stderr } = await run(
    forkArgs(),
    liveStagerOrigin({ live: false }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /is not live in the roster/);
});

test("--topic-from refuses an origin whose ledger role is not Stager", async () => {
  const { result, stderr } = await run(
    forkArgs(),
    liveStagerOrigin({ ledgerRole: "Alpha" }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /the ledger role of "stager-tenth" is "Alpha"/);
});

test("a Stager may fork a topic Stager whose name does not begin with its own", async () => {
  const { result } = await run(forkArgs({ "--name": "stager-gardenboard" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.forkedFrom, ORIGIN);
});

test("--topic-from refuses when the origin wrote no brief, and names the path it wants", async () => {
  const { result, stderr } = await run(forkArgs(), liveStagerOrigin(), BRIEF, true);
  assert.equal(result.ok, false);
  assert.match(stderr, /inherits no conversation/);
  assert.match(stderr, /brief\.md/);
  assert.match(stderr, /lint-queue-plan --body-file/);
});

test("a fork may not be spawned into its origin's worktree", async () => {
  const { result, stderr } = await run(
    forkArgs({ "--cwd": path.join(worktreesHome(), "throne", ORIGIN) }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /that tree belongs to a DIFFERENT agent/);
});

test("a fork's identity carries the origin and the standing rule that filing needs the Lord's own word", async () => {
  const { result } = await run(forkArgs());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const identity = createAgentIdentity(result.value as never, "Regent");
  assert.equal(identity.forkedFrom, ORIGIN);
  const text = identityText(FORK, identity);
  assert.ok(text.includes(FORKED_STAGER_STANDING_INSTRUCTION));
  const baseDir = await mkdtemp(path.join(tmpdir(), "identity-fork-"));
  try {
    await writeIdentity(FORK, identity, baseDir);
    const file = await readFile(path.join(baseDir, FORK, "identity.md"), "utf8");
    assert.ok(file.includes(`${FORKED_FROM_LINE_PREFIX}${ORIGIN}`));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

function forkPolicyResolution(): PolicyResolution {
  return {
    flags: { supervisor: "Regent" },
    oneShot: false,
    harness: HARNESS_NAMES.CLAUDE,
    model: "opus",
    role: "Stager",
    requestedName: FORK,
    name: FORK,
    requestedCwd: `/tmp/${FORK}`,
    launchHarness: HARNESS_NAMES.CLAUDE,
    launchModel: "opus",
    launchEffort: 1,
    cwd: `/tmp/${FORK}`,
    resuming: false,
    customPassthrough: [],
    objectiveContract: { kind: "non-campaign" },
    routingNote: "",
    durableRoutingNote: false,
    effortOverrideNote: "",
    harnessOverrideNote: "",
    bypassedObjectiveCode: false,
    forkedFrom: ORIGIN,
  };
}

test("a fork's spawn.json records which origin it was forked from", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "throne-fork-spawn-"));
  const request = forkPolicyResolution();
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
    now: () => "2026-09-18T00:00:00.000Z",
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
    const spawn = JSON.parse(
      await readFile(path.join(dataDir, FORK, "spawn.json"), "utf8"),
    );
    assert.equal(spawn.forked_from, ORIGIN);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a fork opens on the brief its origin wrote", async () => {
  const request = forkPolicyResolution();
  const identity = createAgentIdentity(request, "Regent");
  const prompts = await createAgentOpeningPrompts(
    request,
    identity,
    async () => "unused situation brief",
    async (name) => (name === FORK ? BRIEF : undefined),
  );
  assert.ok(prompts.complete.includes(BRIEF.trim()));
  assert.ok(!prompts.complete.includes("unused situation brief"));
});
