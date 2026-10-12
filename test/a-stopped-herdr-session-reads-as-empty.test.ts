import assert from "node:assert/strict";
import { test } from "node:test";
import { HerdrCommandError } from "../src/herdr/herdr-client.ts";
import { resolveAgentAcrossSessions } from "../src/herdr/herdr-runtime.service.ts";
import {
  listLiveAgentStatusesAcrossSessions,
  type LiveAgentStatus,
} from "../src/agent-statuses/agent-statuses-herdr.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";

const REGISTERED_SESSION_NAMES = ["throne", "throne-bot"];
const THRONE_AGENT_NAME = "alpha-throne-01";

function agentListFailure(sessionName: string, code?: string): HerdrCommandError {
  return new HerdrCommandError(
    ["--session", sessionName, "agent", "list"],
    "no herdr server is running",
    { code },
  );
}

const FAILURES_OTHER_THAN_A_STOPPED_SERVER: ReadonlyArray<{
  readonly situation: string;
  readonly failure: Error;
}> = [
  {
    situation: "a different herdr error code",
    failure: agentListFailure("throne-bot", "protocol_mismatch"),
  },
  {
    situation: "a herdr failure with no error code",
    failure: agentListFailure("throne-bot"),
  },
  {
    situation: "a failure that only mentions server_not_running in its text",
    failure: new Error("herdr agent list failed (server_not_running)"),
  },
  {
    situation: "malformed agent list output",
    failure: new Error("herdr agent list: output was not valid JSON"),
  },
];

function throneHerdrAgent(): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "idle",
    cwd: "/tmp",
    focused: false,
    name: THRONE_AGENT_NAME,
    paneId: "pane-1",
    tabId: "tab-1",
    terminalId: "terminal-1",
  };
}

function throneLiveAgentStatus(): LiveAgentStatus {
  return {
    agent: "claude",
    agentStatus: "idle",
    cwd: "/tmp",
    focused: false,
    name: THRONE_AGENT_NAME,
    paneId: "pane-1",
    tabId: "tab-1",
    tabLabel: THRONE_AGENT_NAME,
    terminalId: "terminal-1",
  };
}

function listerWhereThroneBotFailsWith<Agent>(
  throneAgents: Agent[],
  failure: Error,
): (sessionName: string) => Promise<Agent[]> {
  return async (sessionName) => {
    if (sessionName === "throne") return throneAgents;
    throw failure;
  };
}

test("agents in the throne session are still listed when the throne-bot session is not running", async () => {
  const roster = await listLiveAgentStatusesAcrossSessions(
    REGISTERED_SESSION_NAMES,
    listerWhereThroneBotFailsWith(
      [throneLiveAgentStatus()],
      agentListFailure("throne-bot", "server_not_running"),
    ),
  );

  assert.deepEqual(
    roster.map((agent) => agent.tabLabel),
    [THRONE_AGENT_NAME],
  );
});

test("an agent in the throne session is still resolved by name when the throne-bot session is not running", async () => {
  const resolved = await resolveAgentAcrossSessions(
    THRONE_AGENT_NAME,
    REGISTERED_SESSION_NAMES,
    listerWhereThroneBotFailsWith(
      [throneHerdrAgent()],
      agentListFailure("throne-bot", "server_not_running"),
    ),
  );

  assert.equal(resolved.name, THRONE_AGENT_NAME);
  assert.equal(resolved.herdrSessionName, "throne");
});

test("a herdr session that fails for any other reason still fails the across-session listing", async () => {
  for (const { situation, failure } of FAILURES_OTHER_THAN_A_STOPPED_SERVER) {
    await assert.rejects(
      () =>
        listLiveAgentStatusesAcrossSessions(
          REGISTERED_SESSION_NAMES,
          listerWhereThroneBotFailsWith([throneLiveAgentStatus()], failure),
        ),
      (rejection) => rejection === failure,
      situation,
    );
  }
});

test("a herdr session that fails for any other reason still fails resolving an agent by name", async () => {
  for (const { situation, failure } of FAILURES_OTHER_THAN_A_STOPPED_SERVER) {
    await assert.rejects(
      () =>
        resolveAgentAcrossSessions(
          THRONE_AGENT_NAME,
          REGISTERED_SESSION_NAMES,
          listerWhereThroneBotFailsWith([throneHerdrAgent()], failure),
        ),
      (rejection) => rejection === failure,
      situation,
    );
  }
});
