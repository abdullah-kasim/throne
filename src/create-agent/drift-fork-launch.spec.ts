import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { copyDriftPrompt, DRIFT_PROMPT_BASENAME, lastLordPromptBefore } from "./drift-prompt.ts";
import { runResidentAgent } from "./resident-agent.ts";
import { baseDeps } from "./policy-test-fixtures.ts";
import type { CreateAgentDeps, PolicyResolution } from "./create.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { TOPIC_VERDICTS_FILE_NAME } from "../topic/topic.command.ts";
import { writeIdentity, writeOpeningPrompt } from "../agentdata/identity-data.service.ts";

const PARENT = "stager-eleventh";
const FORK = "stager-eleventh-invoices";
const LORD_PROMPT = "the invoices page shows last month's totals";
const LAUNCH_STOPPED = "the spec stops at the launch";
const VERDICT_TIME = "2026-11-25T09:12:10.000Z";

function forkRequest(cwd: string): PolicyResolution {
  return {
    flags: { supervisor: PARENT },
    oneShot: false,
    harness: HARNESS_NAMES.CLAUDE,
    model: "opus",
    role: "Stager",
    requestedName: FORK,
    name: FORK,
    requestedCwd: cwd,
    launchHarness: HARNESS_NAMES.CLAUDE,
    launchModel: "opus",
    launchEffort: 1,
    cwd,
    resuming: false,
    customPassthrough: [],
    objectiveContract: { kind: "non-campaign" },
    routingNote: "",
    durableRoutingNote: false,
    effortOverrideNote: "",
    harnessOverrideNote: "",
    bypassedObjectiveCode: false,
    forkedFrom: PARENT,
  };
}

async function forkThroughCreateAgent(verdict: string) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "drift-fork-launch-"));
  await mkdir(path.join(dataDir, PARENT), { recursive: true });
  await mkdir(path.join(dataDir, FORK), { recursive: true });
  const transcript = path.join(dataDir, "parent.jsonl");
  await writeFile(
    transcript,
    JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: "2026-11-25T09:10:00.000Z", message: { content: LORD_PROMPT } }),
  );
  await writeFile(
    path.join(dataDir, PARENT, TOPIC_VERDICTS_FILE_NAME),
    JSON.stringify({ verdict, at: VERDICT_TIME }) + "\n",
  );
  const deps = baseDeps({
    writeIdentity: (name, identity) => writeIdentity(name, identity, dataDir),
    writeOpeningPrompt: (name, prompt) => writeOpeningPrompt(name, prompt, dataDir),
    writeSpawnSpec: async () => {},
    readTreeBase: async () => null,
    resolveMemoryDir: async () => {
      throw new Error("no memory directory in this spec");
    },
    installHerdrOperatorSkill: async (role) => ({ kind: "not-an-operator-role", role }),
    writeStderr: () => {},
    readForkBrief: async () => "INTENT: fix the invoices.\n",
    copyDriftPrompt: (parentName, forkName) => copyDriftPrompt(parentName, forkName, dataDir, async () => transcript),
    startAgent: (async () => {
      throw new Error(LAUNCH_STOPPED);
    }) as unknown as CreateAgentDeps["startAgent"],
  } as Partial<CreateAgentDeps>);
  await assert.rejects(runResidentAgent(forkRequest(dataDir), deps), new RegExp(LAUNCH_STOPPED));
  const read = async (name: string) => {
    try {
      return await readFile(path.join(dataDir, FORK, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const identity = await read("identity.md");
  const opening = await read("opening-prompt.md");
  const files = { lordPrompt: await read(DRIFT_PROMPT_BASENAME), identity, opening };
  await rm(dataDir, { recursive: true, force: true });
  return files;
}

test("a drift fork made through create-agent gets lord-prompt.md and the drift identity", async () => {
  const fork = await forkThroughCreateAgent("changed");
  assert.equal(fork.lordPrompt, LORD_PROMPT);
  assert.match(fork.identity ?? "", /lord-prompt\.md/);
  assert.match(fork.identity ?? "", /`add-to-queue` included/);
  assert.match(fork.opening ?? "", /lord-prompt\.md` and act on it/);
});

test("a fork made through create-agent after a same-topic verdict gets neither", async () => {
  const fork = await forkThroughCreateAgent("same");
  assert.equal(fork.lordPrompt, undefined);
  assert.ok(fork.identity !== undefined);
  assert.doesNotMatch(fork.identity, /lord-prompt\.md/);
  assert.doesNotMatch(fork.opening ?? "", /lord-prompt\.md/);
});

test("a prompt the Lord typed while the Stager was busy still counts as the drift prompt", () => {
  const queued = (origin: string, prompt: string, timestamp: string) =>
    JSON.stringify({
      type: "attachment",
      timestamp,
      attachment: { type: "queued_command", prompt, origin: { kind: origin }, timestamp },
    });
  const transcript = [
    JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: "2026-11-25T09:00:00.000Z", message: { content: "an older prompt" } }),
    queued("human", LORD_PROMPT, "2026-11-25T09:10:00.000Z"),
    queued("plugin", "The throne-delivery plugin sent a message:\n<message9>", "2026-11-25T09:11:00.000Z"),
  ].join("\n");
  assert.equal(lastLordPromptBefore(transcript, VERDICT_TIME), LORD_PROMPT);
});
