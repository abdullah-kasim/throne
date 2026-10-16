import assert from "node:assert/strict";
import { test } from "node:test";
import { REGENT_TAB_LABEL } from "../regent-state/regent-liveness.ts";
import { DESIRED_STATES } from "../regent-state/regent-state.service.ts";
import { COURT_LIVENESS_HOSTED_WORKER_NAME } from "../throne-backend/court-liveness.hosted-worker.ts";
import { resumeOrphan } from "../throne-startup/throne-startup-reconciliation.service.ts";
import { ONE_HOUR_IN_MILLISECONDS } from "./agent-revival-history.ts";
import {
  AGENT_REVIVAL_OUTCOMES,
  AGENT_REVIVAL_SKIP_REASONS,
  TAB_DISAPPEARED_BEFORE_THE_RESUME,
  type AgentRevivalOutcome,
} from "./agent-revival.ts";
import {
  FIVE_MINUTES_IN_MILLISECONDS,
  SHELL_PROCESS,
  TWO_LINE_PROMPT_WITH_NOTHING_TYPED,
  UNSTYLED_DOLLAR_PROMPT,
  court,
  courtWithOneDeadAgent,
  revivalHistoryWasWritten,
  sessionIdNumbered,
  type Court,
} from "./agent-revival.test-support.ts";

test("an agent whose tab is still there with one pane and no live harness is brought back in that same pane", async () => {
  const { world, pane } = await courtWithOneDeadAgent("alpha-ledger-01");

  const outcome = await world.revive("alpha-ledger-01");

  assert.deepEqual(outcome, {
    agentName: "alpha-ledger-01",
    kind: AGENT_REVIVAL_OUTCOMES.REVIVED,
    paneId: pane.paneId,
    sessionId: sessionIdNumbered(1),
  });
  assert.deepEqual(
    world.harnessStarts.map((start) => start.paneId),
    [pane.paneId],
  );
  assert.deepEqual(world.tabsOpened, []);
});

test("a revived agent resumes its own native session and keeps its herdr name", async () => {
  const { world, pane } = await courtWithOneDeadAgent("alpha-ledger-01");

  await world.revive("alpha-ledger-01");

  assert.equal(world.harnessStarts.length, 1);
  const [start] = world.harnessStarts;
  assert.equal(start!.agentName, "alpha-ledger-01");
  assert.deepEqual(start!.argv.slice(-2), ["--resume", sessionIdNumbered(1)]);
  assert.deepEqual(world.renames, [
    { paneId: pane.paneId, agentName: "alpha-ledger-01" },
  ]);
});

test("an agent whose spawn record holds no native session is reported and not started fresh", async () => {
  const world = await court();
  await world.recordAgent("alpha-ledger-01", undefined);
  world.addShellPane("alpha-ledger-01");

  const outcome = await world.revive("alpha-ledger-01");

  assert.deepEqual(outcome, {
    agentName: "alpha-ledger-01",
    kind: AGENT_REVIVAL_OUTCOMES.SKIPPED,
    reason: AGENT_REVIVAL_SKIP_REASONS.NO_RECORDED_SESSION,
  });
  assert.deepEqual(world.harnessStarts, []);
});

test("an agent with no tab is left alone and no tab is opened", async () => {
  const world = await court();
  await world.recordAgent("shadow-ledger-02-reaped", 1);

  const outcome = await world.revive("shadow-ledger-02-reaped");

  assert.deepEqual(outcome, {
    agentName: "shadow-ledger-02-reaped",
    kind: AGENT_REVIVAL_OUTCOMES.LEFT_ALONE,
  });
  await assert.rejects(
    resumeOrphan("shadow-ledger-02-reaped", world.resumeContract),
    { message: TAB_DISAPPEARED_BEFORE_THE_RESUME },
  );
  assert.deepEqual(world.harnessStarts, []);
  assert.deepEqual(world.tabsOpened, []);
});

test("a tab with more than one pane is reported and not touched", async () => {
  const { world, pane } = await courtWithOneDeadAgent("alpha-ledger-01");
  world.addShellPane("alpha-ledger-01", pane.tabId);

  const outcome = await world.revive("alpha-ledger-01");

  assert.deepEqual(outcome, {
    agentName: "alpha-ledger-01",
    kind: AGENT_REVIVAL_OUTCOMES.SKIPPED,
    reason: "its tab holds 2 panes",
  });
  assert.deepEqual(world.harnessStarts, []);
});

test("two tabs with the same name are reported and not touched", async () => {
  const { world } = await courtWithOneDeadAgent("alpha-ledger-01");
  world.addShellPane("alpha-ledger-01", "tab-second-with-the-same-name");

  const outcome = await world.revive("alpha-ledger-01");

  assert.deepEqual(outcome, {
    agentName: "alpha-ledger-01",
    kind: AGENT_REVIVAL_OUTCOMES.SKIPPED,
    reason: "2 tabs carry its name",
  });
  assert.deepEqual(world.harnessStarts, []);
});

test("a dismissed Regent is not revived", async () => {
  const { world } = await courtWithOneDeadAgent(REGENT_TAB_LABEL);
  world.rosterEntries = [];
  world.desiredState = DESIRED_STATES.DISMISSED;

  const outcome = await world.revive(REGENT_TAB_LABEL);

  assert.deepEqual(outcome, {
    agentName: REGENT_TAB_LABEL,
    kind: AGENT_REVIVAL_OUTCOMES.SKIPPED,
    reason: AGENT_REVIVAL_SKIP_REASONS.REGENT_IS_DISMISSED,
  });
  assert.deepEqual(world.harnessStarts, []);
});

test("a running Regent is left to the existing resurrection", async () => {
  const { world } = await courtWithOneDeadAgent(REGENT_TAB_LABEL);
  world.rosterEntries = [];

  const outcome = await world.revive(REGENT_TAB_LABEL);

  assert.deepEqual(outcome, {
    agentName: REGENT_TAB_LABEL,
    kind: AGENT_REVIVAL_OUTCOMES.LEFT_TO_OWNER,
    owner: COURT_LIVENESS_HOSTED_WORKER_NAME,
  });
  assert.deepEqual(world.harnessStarts, []);
});

async function courtWithTwoDeadStagers(): Promise<Court> {
  const world = await court();
  await world.recordAgent("stager-eighth", 8, "2026-10-01T00:00:00Z");
  await world.recordAgent("stager-ninth", 9, "2026-10-09T00:00:00Z");
  world.addShellPane("stager-eighth");
  world.addShellPane("stager-ninth");
  return world;
}

test("the Stager the court already keeps alive is left to that worker", async () => {
  const world = await courtWithTwoDeadStagers();

  const outcome = await world.revive("stager-ninth");

  assert.deepEqual(outcome, {
    agentName: "stager-ninth",
    kind: AGENT_REVIVAL_OUTCOMES.LEFT_TO_OWNER,
    owner: COURT_LIVENESS_HOSTED_WORKER_NAME,
  });
  assert.deepEqual(world.harnessStarts, []);
});

test("a Stager the court is not about to bring back is revived like any other agent", async () => {
  const world = await courtWithTwoDeadStagers();

  const outcome = await world.revive("stager-eighth");

  assert.equal(outcome.kind, AGENT_REVIVAL_OUTCOMES.REVIVED);
  assert.deepEqual(
    world.harnessStarts.map((start) => [start.agentName, start.argv.at(-1)]),
    [["stager-eighth", sessionIdNumbered(8)]],
  );
});

test("a pane a human is typing in is never typed over", async () => {
  const { world, pane } = await courtWithOneDeadAgent("alpha-ledger-01");
  const paneIsInUse: AgentRevivalOutcome = {
    agentName: "alpha-ledger-01",
    kind: AGENT_REVIVAL_OUTCOMES.SKIPPED,
    reason: AGENT_REVIVAL_SKIP_REASONS.PANE_IS_IN_USE,
  };

  for (const draft of ["git push --for", "rm -rf "]) {
    pane.styledScreen = `${TWO_LINE_PROMPT_WITH_NOTHING_TYPED}${draft}`;
    assert.deepEqual(await world.revive("alpha-ledger-01"), paneIsInUse);
  }

  pane.styledScreen = TWO_LINE_PROMPT_WITH_NOTHING_TYPED;
  pane.foregroundProcesses = [SHELL_PROCESS, { name: "vim", argv: ["vim"] }];
  assert.deepEqual(await world.revive("alpha-ledger-01"), paneIsInUse);

  assert.deepEqual(world.harnessStarts, []);
  assert.equal(await revivalHistoryWasWritten(world, "alpha-ledger-01"), false);
});

test("an agent behind a two-line prompt that does not end in a dollar sign is brought back when nothing is typed", async () => {
  const { world, pane } = await courtWithOneDeadAgent("alpha-ledger-01");
  pane.styledScreen = TWO_LINE_PROMPT_WITH_NOTHING_TYPED;

  const outcome = await world.revive("alpha-ledger-01");

  assert.equal(outcome.kind, AGENT_REVIVAL_OUTCOMES.REVIVED);
  assert.equal(world.harnessStarts.length, 1);
});

test("a prompt the pane does not style cannot be told from typed text and is skipped", async () => {
  const { world, pane } = await courtWithOneDeadAgent("alpha-ledger-01");

  for (const unstyledPrompt of [UNSTYLED_DOLLAR_PROMPT, "theuser@host:~/work$ "]) {
    pane.styledScreen = unstyledPrompt;
    assert.deepEqual(await world.revive("alpha-ledger-01"), {
      agentName: "alpha-ledger-01",
      kind: AGENT_REVIVAL_OUTCOMES.SKIPPED,
      reason: AGENT_REVIVAL_SKIP_REASONS.PANE_IS_IN_USE,
    });
  }
  assert.deepEqual(world.harnessStarts, []);
});

async function reviveEveryFiveMinutes(
  world: Court,
  agentName: string,
  times: number,
): Promise<string[]> {
  const kinds: string[] = [];
  for (let tick = 0; tick < times; tick += 1) {
    world.now += FIVE_MINUTES_IN_MILLISECONDS;
    kinds.push((await world.revive(agentName)).kind);
  }
  return kinds;
}

test("an agent is revived at most three times in an hour", async () => {
  const { world } = await courtWithOneDeadAgent("alpha-ledger-01");
  const { REVIVED, LIMIT_REACHED } = AGENT_REVIVAL_OUTCOMES;

  assert.deepEqual(await reviveEveryFiveMinutes(world, "alpha-ledger-01", 2), [
    REVIVED,
    REVIVED,
  ]);
  world.now += ONE_HOUR_IN_MILLISECONDS;
  assert.deepEqual(await reviveEveryFiveMinutes(world, "alpha-ledger-01", 3), [
    REVIVED,
    REVIVED,
    REVIVED,
  ]);
  assert.equal(world.harnessStarts.length, 5);

  world.now += FIVE_MINUTES_IN_MILLISECONDS;
  assert.deepEqual(await world.revive("alpha-ledger-01"), {
    agentName: "alpha-ledger-01",
    kind: LIMIT_REACHED,
    alreadyReported: false,
  });
  world.now += 2 * ONE_HOUR_IN_MILLISECONDS;
  assert.deepEqual(await world.revive("alpha-ledger-01"), {
    agentName: "alpha-ledger-01",
    kind: LIMIT_REACHED,
    alreadyReported: true,
  });
  assert.equal(world.harnessStarts.length, 5);
});

test("an agent that reached the revival limit is revived again once its tab changes", async () => {
  const { world } = await courtWithOneDeadAgent("alpha-ledger-01");
  const { REVIVED, LIMIT_REACHED } = AGENT_REVIVAL_OUTCOMES;
  assert.deepEqual(await reviveEveryFiveMinutes(world, "alpha-ledger-01", 4), [
    REVIVED,
    REVIVED,
    REVIVED,
    LIMIT_REACHED,
  ]);

  world.panes.length = 0;
  const reopened = world.addShellPane("alpha-ledger-01", "tab-reopened");
  const outcome = await world.revive("alpha-ledger-01");

  assert.equal(outcome.kind, REVIVED);
  assert.equal(world.harnessStarts.at(-1)!.paneId, reopened.paneId);
  assert.equal(world.harnessStarts.length, 4);
});

test("a dry run says what would be revived and revives nothing", async () => {
  const { world, pane } = await courtWithOneDeadAgent("alpha-ledger-01");

  const outcome = await world.revive("alpha-ledger-01", true);

  assert.deepEqual(outcome, {
    agentName: "alpha-ledger-01",
    kind: AGENT_REVIVAL_OUTCOMES.WOULD_REVIVE,
    paneId: pane.paneId,
    sessionId: sessionIdNumbered(1),
  });
  assert.deepEqual(world.harnessStarts, []);
  assert.deepEqual(world.renames, []);
  assert.equal(await revivalHistoryWasWritten(world, "alpha-ledger-01"), false);
});
