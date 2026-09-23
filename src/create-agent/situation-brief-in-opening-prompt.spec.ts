import assert from "node:assert/strict";
import test from "node:test";
import type { AgentIdentity } from "../agentdata/identity-data.service.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { SITUATION_BRIEF_HEADING } from "../situation-brief/situation-brief-composer.ts";
import { createAgentOpeningPrompts } from "./agent-record.ts";
import type { PolicyResolution } from "./create.types.ts";

function launchRequest(overrides: {
  role: string;
  resuming?: boolean;
  objectiveCode?: string;
  prompt?: string;
}): PolicyResolution {
  return {
    name: `${overrides.role.toLowerCase()}-wired-01`,
    role: overrides.role,
    resuming: overrides.resuming ?? false,
    launchHarness: HARNESS_NAMES.CLAUDE,
    flags: { prompt: overrides.prompt, supervisor: "Regent" },
    ...(overrides.objectiveCode === undefined
      ? { objectiveContract: { kind: "non-campaign" } }
      : { objectiveContract: { kind: "campaign", objectiveCode: overrides.objectiveCode } }),
  } as unknown as PolicyResolution;
}

const identity: AgentIdentity = { supervisor: "Regent", escalation: "Regent", role: "Alpha" };

function recordingComposer(calls: string[]) {
  return async (objectiveCode: string) => {
    calls.push(objectiveCode);
    return `${SITUATION_BRIEF_HEADING}\n\nbrief for ${objectiveCode}`;
  };
}

test("a fresh Alpha launched for a queue row gets the situation brief after its queue body", async () => {
  const calls: string[] = [];
  const prompts = await createAgentOpeningPrompts(
    launchRequest({ role: "Alpha", objectiveCode: "wired", prompt: "INTENT: the queue body" }),
    identity,
    recordingComposer(calls),
  );
  assert.deepEqual(calls, ["wired"]);
  const bodyAt = prompts.complete.indexOf("INTENT: the queue body");
  const briefAt = prompts.complete.indexOf(`${SITUATION_BRIEF_HEADING}\n\nbrief for wired`);
  assert.ok(bodyAt >= 0 && briefAt > bodyAt, prompts.complete);
});

test("no brief is composed for a Shadow, a resumed Alpha, or an Alpha outside the queue", async () => {
  const cases = [
    launchRequest({ role: "Shadow", objectiveCode: "wired", prompt: "do the slice" }),
    launchRequest({ role: "Alpha", objectiveCode: "wired", resuming: true, prompt: "carry on" }),
    launchRequest({ role: "Alpha", prompt: "non-queue work" }),
  ];
  for (const request of cases) {
    const calls: string[] = [];
    const prompts = await createAgentOpeningPrompts(request, identity, recordingComposer(calls));
    assert.deepEqual(calls, [], request.name);
    assert.equal(prompts.complete.includes(SITUATION_BRIEF_HEADING), false, request.name);
  }
});

test("a brief that cannot be composed never blocks the launch and tells the Alpha how to get it", async () => {
  const prompts = await createAgentOpeningPrompts(
    launchRequest({ role: "Alpha", objectiveCode: "wired", prompt: "INTENT: body" }),
    identity,
    async () => {
      throw new Error("queue store is locked");
    },
  );
  assert.match(prompts.complete, /INTENT: body/);
  assert.match(prompts.complete, /## Situation at launch\n\nUnavailable at launch \(queue store is locked\)/);
  assert.match(prompts.complete, /throne situation-brief --objective-code wired/);
});

test("an Alpha launched with no prompt text still receives the brief", async () => {
  const prompts = await createAgentOpeningPrompts(
    launchRequest({ role: "Alpha", objectiveCode: "wired" }),
    identity,
    recordingComposer([]),
  );
  assert.match(prompts.complete, /brief for wired/);
});
