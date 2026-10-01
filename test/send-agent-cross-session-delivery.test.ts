import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentAcrossSessions } from "../src/herdr/herdr-runtime.service.ts";
import {
  submitToAgent,
  defaultSubmitToAgentDeps,
  REAL_SUBMIT_TO_AGENT_DEPS,
} from "../src/herdr/herdr-send.service.ts";
import { buildSubmitToAgentDeps } from "../src/herdr/herdr-send-enter-until-empty.ts";
import { THRONE_HERDR_SESSION_NAME } from "../src/herdr/herdr-client.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import type { HerdrProcessBoundary } from "../src/herdr/herdr-client.ts";

function fakeHerdrAgent(overrides: Partial<HerdrAgent> & { name: string }): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "idle",
    cwd: "/tmp",
    focused: false,
    paneId: `pane-${overrides.name}`,
    tabId: `tab-${overrides.name}`,
    terminalId: `term-${overrides.name}`,
    ...overrides,
  };
}

function recordingProcessBoundary(): {
  boundary: HerdrProcessBoundary;
  invocations: { executablePath: string; args: readonly string[] }[];
} {
  const invocations: { executablePath: string; args: readonly string[] }[] = [];
  return {
    invocations,
    boundary: {
      execute: async (executablePath, args) => {
        invocations.push({ executablePath, args });
        return { stdout: "", stderr: "" };
      },
    },
  };
}

test("an agent resolved in the throne-bot session is delivered there, not against the default session", async () => {
  const throneAgents = [fakeHerdrAgent({ name: "alpha-throne-01" })];
  const throneBotAgents = [fakeHerdrAgent({ name: "electronics-expert" })];
  const listAgentsForSession = async (sessionName: string) =>
    sessionName === THRONE_HERDR_SESSION_NAME ? throneAgents : throneBotAgents;

  const recipient = await resolveAgentAcrossSessions(
    "electronics-expert",
    [THRONE_HERDR_SESSION_NAME, "throne-bot"],
    listAgentsForSession,
  );
  assert.equal(recipient.herdrSessionName, "throne-bot");

  const { boundary, invocations } = recordingProcessBoundary();
  const deps = buildSubmitToAgentDeps(recipient.herdrSessionName!, boundary);

  await submitToAgent(recipient, "regent", "DONE eesmoke01: ...", { forceImmediate: true }, deps);

  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.deepEqual(invocation.args.slice(0, 2), ["--session", "throne-bot"]);
  }
  assert.deepEqual(invocations[0]!.args.slice(2, 4), ["pane", "send-text"]);
  assert.deepEqual(invocations[1]!.args.slice(2, 4), ["pane", "send-keys"]);
});

test("an agent resolved in the default throne session dispatches through the exact unmodified default deps", async () => {
  const throneAgents = [fakeHerdrAgent({ name: "regent" })];
  const listAgentsForSession = async () => throneAgents;

  const recipient = await resolveAgentAcrossSessions(
    "regent",
    [THRONE_HERDR_SESSION_NAME],
    listAgentsForSession,
  );
  assert.equal(recipient.herdrSessionName, THRONE_HERDR_SESSION_NAME);

  assert.equal(defaultSubmitToAgentDeps(recipient), REAL_SUBMIT_TO_AGENT_DEPS);
});

test("an agent with no recorded session (every pre-existing caller) dispatches through the exact unmodified default deps", () => {
  const recipient = fakeHerdrAgent({ name: "regent" });
  assert.equal(recipient.herdrSessionName, undefined);
  assert.equal(defaultSubmitToAgentDeps(recipient), REAL_SUBMIT_TO_AGENT_DEPS);
});
