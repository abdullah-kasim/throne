import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveAgentAcrossSessions,
} from "../src/herdr/herdr-runtime.service.ts";
import { listLiveAgentStatusesAcrossSessions } from "../src/agent-statuses/agent-statuses-herdr.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import type { LiveAgentStatus } from "../src/agent-statuses/agent-statuses-herdr.ts";

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

function fakeLiveAgentStatus(overrides: Partial<LiveAgentStatus> & { name: string }): LiveAgentStatus {
  return {
    agent: "claude",
    agentStatus: "idle",
    cwd: "/tmp",
    focused: false,
    paneId: `pane-${overrides.name}`,
    tabId: `tab-${overrides.name}`,
    terminalId: `term-${overrides.name}`,
    tabLabel: overrides.name,
    ...overrides,
  };
}

test("an agent addressed by name is found even when it lives in the throne-bot session", async () => {
  const throneAgents = [fakeHerdrAgent({ name: "alpha-throne-01" })];
  const throneBotAgents = [fakeHerdrAgent({ name: "bot-electronics-expert" })];
  const listAgentsForSession = async (sessionName: string) =>
    sessionName === "throne" ? throneAgents : throneBotAgents;

  const resolved = await resolveAgentAcrossSessions(
    "bot-electronics-expert",
    ["throne", "throne-bot"],
    listAgentsForSession,
  );

  assert.equal(resolved.name, "bot-electronics-expert");
  assert.equal(resolved.paneId, "pane-bot-electronics-expert");
});

test("addressing a name that exists in two sessions refuses instead of guessing", async () => {
  const sharedName = "regent";
  const throneAgents = [fakeHerdrAgent({ name: sharedName })];
  const throneBotAgents = [fakeHerdrAgent({ name: sharedName })];
  const listAgentsForSession = async (sessionName: string) =>
    sessionName === "throne" ? throneAgents : throneBotAgents;

  await assert.rejects(
    () => resolveAgentAcrossSessions(sharedName, ["throne", "throne-bot"], listAgentsForSession),
    /exists in more than one registered herdr session/,
  );
});

test("a name unique to a single session still resolves when only one registered session is queried", async () => {
  const throneAgents = [fakeHerdrAgent({ name: "alpha-throne-02" })];
  const listAgentsForSession = async () => throneAgents;

  const resolved = await resolveAgentAcrossSessions(
    "alpha-throne-02",
    ["throne"],
    listAgentsForSession,
  );

  assert.equal(resolved.name, "alpha-throne-02");
});

test("the agent-statuses roster includes a live agent that only exists in the throne-bot session", async () => {
  const throneAgents = [fakeLiveAgentStatus({ name: "alpha-throne-03" })];
  const throneBotAgents = [fakeLiveAgentStatus({ name: "bot-support" })];
  const listAgentsInSession = async (sessionName: string) =>
    sessionName === "throne" ? throneAgents : throneBotAgents;

  const roster = await listLiveAgentStatusesAcrossSessions(
    ["throne", "throne-bot"],
    listAgentsInSession,
  );

  assert.deepEqual(
    roster.map((agent) => agent.tabLabel).sort(),
    ["alpha-throne-03", "bot-support"],
  );
});

test("the agent-statuses roster refuses a name duplicated across sessions instead of merging silently", async () => {
  const sharedName = "regent";
  const throneAgents = [fakeLiveAgentStatus({ name: sharedName })];
  const throneBotAgents = [fakeLiveAgentStatus({ name: sharedName })];
  const listAgentsInSession = async (sessionName: string) =>
    sessionName === "throne" ? throneAgents : throneBotAgents;

  await assert.rejects(
    () => listLiveAgentStatusesAcrossSessions(["throne", "throne-bot"], listAgentsInSession),
    /exists in more than one registered herdr session/,
  );
});
