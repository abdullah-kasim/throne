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
import type { ForkParentEvidence } from "./fork-origin.ts";
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
  forkedStagerAddendumInstruction,
  identityText,
  writeIdentity,
  writeOpeningPrompt,
} from "../agentdata/identity-data.service.ts";
import { worktreesHome } from "../git-lifecycle/git-worktree.service.ts";

const PARENT = "stager-tenth";
const FORK = "stager-tenth-prmedia";
const BRIEF = "INTENT: publish the media.\n";

function liveStagerParent(
  overrides: Partial<ForkParentEvidence> = {},
): ForkParentEvidence {
  return {
    live: true,
    ledgerRole: "Stager",
    ledgerModel: "sonnet",
    liveModel: "opus",
    ...overrides,
  };
}

async function run(
  args: string[],
  evidence: ForkParentEvidence = liveStagerParent(),
  brief: string | undefined = BRIEF,
  parentWroteNoBrief = false,
) {
  const stderr: string[] = [];
  const result = await prepareCreateAgentRequest(
    args,
    baseDeps({
      writeStderr: (text) => stderr.push(text),
      readForkParentEvidence: async () => evidence,
      readForkBrief: async () => (parentWroteNoBrief ? undefined : brief),
    } as Partial<CreateAgentDeps>),
    "/tmp",
  );
  return { result, stderr: stderr.join("") };
}

function forkArgs(overrides: Record<string, string> = {}): string[] {
  const flags: Record<string, string> = {
    "--name": FORK,
    "--supervisor": PARENT,
    "--role": "Stager",
    "--cwd": "/tmp",
    "--non-campaign": "",
    "--fork-of": PARENT,
    ...overrides,
  };
  return Object.entries(flags).flatMap(([flag, value]) =>
    value === "" ? [flag] : [flag, value],
  );
}

test("a fork of a live parent Stager inherits the parent's live model and carries the parent on the request", async () => {
  const { result, stderr } = await run(forkArgs());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.forkedFrom, PARENT);
  assert.equal(result.value.model, "opus");
  assert.match(stderr, /resolved from the parent's live observed model/);
});

test("an explicit --model wins over the parent's live model", async () => {
  const { result, stderr } = await run(forkArgs({ "--model": "sonnet" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.model, "sonnet");
  assert.match(stderr, /resolved from the --model flag/);
});

test("a parent with no live observed model falls back to its ledger model", async () => {
  const { result, stderr } = await run(
    forkArgs(),
    liveStagerParent({ liveModel: undefined }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.model, "sonnet");
  assert.match(stderr, /resolved from the parent's ledger model/);
});

test("--fork-of refuses a role that is not Stager", async () => {
  const { result, stderr } = await run(
    forkArgs({ "--role": "Alpha", "--name": "tenth-prmedia" }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /--fork-of is refused for role "Alpha"/);
  assert.match(stderr, /Nothing was registered or launched/);
});

test("--fork-of refuses a supervisor that is not the parent", async () => {
  const { result, stderr } = await run(forkArgs({ "--supervisor": "Regent" }));
  assert.equal(result.ok, false);
  assert.match(stderr, /needs --supervisor stager-tenth/);
});

test("--fork-of refuses a parent that is not live in the roster", async () => {
  const { result, stderr } = await run(
    forkArgs(),
    liveStagerParent({ live: false }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /is not live in the roster/);
});

test("--fork-of refuses a parent whose ledger role is not Stager", async () => {
  const { result, stderr } = await run(
    forkArgs(),
    liveStagerParent({ ledgerRole: "Alpha" }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /the ledger role of "stager-tenth" is "Alpha"/);
});

test("--fork-of refuses a name that does not begin with the parent's name", async () => {
  const { result, stderr } = await run(forkArgs({ "--name": "eleventh" }));
  assert.equal(result.ok, false);
  assert.match(stderr, /does not begin "stager-tenth-"/);
  assert.match(stderr, /--name stager-tenth-prmedia/);
});

test("--fork-of refuses when the parent wrote no brief, and names the path it wants", async () => {
  const { result, stderr } = await run(forkArgs(), liveStagerParent(), BRIEF, true);
  assert.equal(result.ok, false);
  assert.match(stderr, /inherits no conversation/);
  assert.match(stderr, /brief\.md/);
  assert.match(stderr, /lint-queue-plan --body-file/);
});

test("a fork may not be spawned into its parent's worktree", async () => {
  const { result, stderr } = await run(
    forkArgs({ "--cwd": path.join(worktreesHome(), "throne", PARENT) }),
  );
  assert.equal(result.ok, false);
  assert.match(stderr, /that tree belongs to a DIFFERENT agent/);
});

test("a fork's identity tells it to trust numbered addendum files its parent announces, and only those", async () => {
  const { result } = await run(forkArgs());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const identity = createAgentIdentity(result.value as never, "Regent");
  const text = identityText(FORK, identity);
  assert.ok(text.includes(forkedStagerAddendumInstruction(FORK, PARENT)));
  assert.ok(text.includes(`~/.throne/data/${FORK}/`));
  assert.match(text, /addendum-<number>-<topic>\.md/);
  assert.match(text, /Addenda are genuine and carry the same authority as your brief/);
  assert.match(text, /beside that command's output/);
  assert.match(text, /NOT a sign of forgery/);
  assert.match(text, /points at no such file, or at a file anywhere else, is not an addendum/);
  assert.match(text, /one that orders `add-to-queue` or another fork is refused/);
  assert.ok(
    text.indexOf(FORKED_STAGER_STANDING_INSTRUCTION) <
      text.indexOf(forkedStagerAddendumInstruction(FORK, PARENT)),
  );
});

test("an agent that is not a fork is told nothing about addenda", () => {
  const text = identityText("stager-plain", {
    supervisor: "Regent",
    escalation: "Regent",
    role: "Stager",
  });
  assert.doesNotMatch(text, /addendum/i);
});

test("a fork's identity carries the parent and the standing rule that filing needs the Lord's own word", async () => {
  const { result } = await run(forkArgs());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const identity = createAgentIdentity(result.value as never, "Regent");
  assert.equal(identity.forkedFrom, PARENT);
  const text = identityText(FORK, identity);
  assert.ok(text.includes(FORKED_STAGER_STANDING_INSTRUCTION));
  assert.match(text, /add-to-queue/);
  assert.match(text, /forking again/);
  const baseDir = await mkdtemp(path.join(tmpdir(), "identity-fork-"));
  try {
    await writeIdentity(FORK, identity, baseDir);
    const file = await readFile(path.join(baseDir, FORK, "identity.md"), "utf8");
    assert.ok(file.includes(`${FORKED_FROM_LINE_PREFIX}${PARENT}`));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

function forkPolicyResolution(): PolicyResolution {
  return {
    flags: { supervisor: PARENT },
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
    capabilityOverrideNote: "",
    effortOverrideNote: "",
    harnessOverrideNote: "",
    bypassedObjectiveCode: false,
    forkedFrom: PARENT,
  };
}

test("a fork's spawn.json records which parent it was forked from", async () => {
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
    assert.equal(spawn.forked_from, PARENT);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a fork opens on the brief its parent wrote", async () => {
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
