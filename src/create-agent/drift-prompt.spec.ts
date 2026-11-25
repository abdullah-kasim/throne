import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { copyDriftPrompt, DRIFT_PROMPT_BASENAME } from "./drift-prompt.ts";
import { createAgentIdentity, createAgentOpeningPrompts } from "./agent-record.ts";
import type { PolicyResolution } from "./create.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { TOPIC_VERDICTS_FILE_NAME } from "../topic/topic.command.ts";
import {
  FORKED_STAGER_STANDING_INSTRUCTION,
  identityText,
} from "../agentdata/identity-data.service.ts";

const PARENT = "stager-ninth";
const FORK = "stager-ninth-billing";
const LORD_PROMPT = "now look at the billing page,\nit double charges";

function entry(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "user", ...fields });
}

const TRANSCRIPT = [
  entry({ origin: { kind: "human" }, timestamp: "2026-11-25T09:00:00.000Z", message: { content: "an older prompt" } }),
  entry({ origin: { kind: "human" }, timestamp: "2026-11-25T09:10:00.000Z", message: { content: LORD_PROMPT } }),
  entry({ origin: { kind: "plugin", name: "throne-delivery" }, timestamp: "2026-11-25T09:11:00.000Z", message: { content: "The throne-delivery plugin sent a message:\n<message9>" } }),
  entry({ timestamp: "2026-11-25T09:12:00.000Z", message: { content: [{ type: "tool_result", content: "topic: recorded changed billing" }] } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-11-25T09:12:30.000Z", message: { content: [{ type: "text", text: "forking" }] } }),
  entry({ origin: { kind: "human" }, timestamp: "2026-11-25T09:20:00.000Z", message: { content: "typed after the verdict" } }),
].join("\n");

async function forkDataHome(verdicts: string[]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "drift-fork-"));
  await mkdir(path.join(dataDir, PARENT), { recursive: true });
  await mkdir(path.join(dataDir, FORK), { recursive: true });
  const transcript = path.join(dataDir, "parent.jsonl");
  await writeFile(transcript, TRANSCRIPT);
  await writeFile(
    path.join(dataDir, PARENT, TOPIC_VERDICTS_FILE_NAME),
    verdicts.map((verdict) => JSON.stringify({ verdict, at: "2026-11-25T09:12:10.000Z" })).join("\n") + "\n",
  );
  const copy = () => copyDriftPrompt(PARENT, FORK, dataDir, async () => transcript);
  return { dataDir, copy };
}

function forkRequest(): PolicyResolution {
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
    effortOverrideNote: "",
    harnessOverrideNote: "",
    bypassedObjectiveCode: false,
    forkedFrom: PARENT,
  };
}

const DRIFT_PATH = `/data/${FORK}/${DRIFT_PROMPT_BASENAME}`;

test("a fork made after the parent recorded a topic change gets the Lord's drift prompt copied verbatim into lord-prompt.md", async () => {
  const { dataDir, copy } = await forkDataHome(["same", "changed"]);
  try {
    const written = await copy();
    assert.equal(written, path.join(dataDir, FORK, DRIFT_PROMPT_BASENAME));
    assert.equal(await readFile(written as string, "utf8"), LORD_PROMPT);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the copied drift prompt is the Lord's typed prompt, not a delivered message or a tool result", async () => {
  const { dataDir, copy } = await forkDataHome(["changed"]);
  try {
    const text = await readFile((await copy()) as string, "utf8");
    assert.doesNotMatch(text, /throne-delivery|<message9>|topic: recorded|typed after the verdict/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a fork made without a topic change gets no lord-prompt.md", async () => {
  const { dataDir, copy } = await forkDataHome(["changed", "same"]);
  try {
    assert.equal(await copy(), undefined);
    await assert.rejects(readFile(path.join(dataDir, FORK, DRIFT_PROMPT_BASENAME), "utf8"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a drift fork's identity lets it act on lord-prompt.md as the Lord's own word, add-to-queue included", () => {
  const identity = { ...createAgentIdentity(forkRequest(), "Regent"), driftPromptPath: DRIFT_PATH };
  const text = identityText(FORK, identity);
  assert.ok(text.includes(DRIFT_PATH));
  assert.match(text, /Act on it as the \w+'s own word typed in YOUR OWN pane, `add-to-queue` included/);
});

test("a fork's opening text never asks it to report to a parent", () => {
  const plain = identityText(FORK, createAgentIdentity(forkRequest(), "Regent"));
  assert.doesNotMatch(plain, /lord-prompt\.md/);
  assert.doesNotMatch(plain, /parent/i);
  assert.match(plain, /report to no one; your supervisor is Regent/);
});

test("a fork's opening text ends by leaving its pane showing the result until the Lord reaps it", () => {
  assert.match(FORKED_STAGER_STANDING_INSTRUCTION, /leave your pane showing the result; you stay alive until the \w+ reaps you\.$/);
});

test("a drift fork names the origin Stager instead of a parent", () => {
  const identity = { ...createAgentIdentity(forkRequest(), "Regent"), driftPromptPath: DRIFT_PATH };
  const text = identityText(FORK, identity);
  const origin = identity.forkedFrom;
  assert.ok(text.includes(`the topic changed in ${origin}`));
  assert.ok(text.includes(`${origin}'s transcript`));
  assert.doesNotMatch(text, /parent/i);
});

test("a forked Stager forks again only when its own topic changes, and then without asking", () => {
  assert.match(FORKED_STAGER_STANDING_INSTRUCTION, /You fork again only when your own topic changes/);
  assert.match(FORKED_STAGER_STANDING_INSTRUCTION, /`throne topic changed`, fork at once without asking/);
  assert.doesNotMatch(FORKED_STAGER_STANDING_INSTRUCTION, /Every other fork/);
});

test("a drift fork's opening prompt points it at lord-prompt.md", async () => {
  const request = forkRequest();
  const brief = async () => "INTENT: fix billing.\n";
  const drift = await createAgentOpeningPrompts(
    request,
    { ...createAgentIdentity(request, "Regent"), driftPromptPath: DRIFT_PATH },
    async () => "",
    brief,
  );
  assert.match(drift.complete, new RegExp(`Read \`${DRIFT_PATH}\` and act on it`));
  assert.ok(drift.complete.includes("INTENT: fix billing."));
  const plain = await createAgentOpeningPrompts(request, createAgentIdentity(request, "Regent"), async () => "", brief);
  assert.doesNotMatch(plain.complete, /lord-prompt\.md/);
});
