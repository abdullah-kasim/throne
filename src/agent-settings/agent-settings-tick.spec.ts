import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { CronExpression } from "@nestjs/schedule";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { HOSTED_WORKERS } from "../throne-backend/hosted-worker.types.ts";
import { ThroneBackendModule } from "../throne-backend/throne-backend.module.ts";
import { AGENT_REVIVAL_OUTCOMES } from "./agent-revival.ts";
import {
  AGENT_SETTINGS_CHECK_IS_SWITCHED_OFF,
  TAB_NAME_MATCHES_NO_RECORDED_AGENT,
  runAgentSettingsTick,
} from "./agent-settings-tick.ts";
import {
  APPLIED,
  DRY_RUN,
  REAL_RUN,
  SKIPPED_BUSY,
  commandsTypedInto,
  courtWith,
  lineOf,
  shadowThatIsRight,
  shadowWithTheWrongColour,
} from "./agent-settings-tick.test-support.ts";
import {
  AGENT_SETTINGS_HOSTED_WORKER_NAME,
  AgentSettingsHostedWorker,
} from "./agent-settings.hosted-worker.ts";
import { HARNESS_COMMAND_TYPING_OUTCOMES } from "./harness-command-typing.ts";

test("each live Claude Code agent gets the colour of its kind and the name of its tab", async () => {
  const court = await courtWith({
    liveAgents: [
      {
        name: "regent",
        role: "Grandmaster of the Shadows",
        session: { colour: undefined, sessionName: undefined },
      },
      {
        name: "stager-ninth",
        role: "Stager",
        session: { colour: "red", sessionName: "old-name" },
      },
      {
        name: "alpha-ledger-01",
        role: "Alpha",
        session: { colour: undefined, sessionName: "alpha-ledger-01" },
      },
      {
        name: "shadow-ledger-02",
        role: "Shadow",
        session: { colour: "purple", sessionName: undefined },
      },
    ],
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(court.typed, [
    { agentName: "regent", commandText: "/color red" },
    { agentName: "regent", commandText: "/rename regent" },
    { agentName: "stager-ninth", commandText: "/color green" },
    { agentName: "stager-ninth", commandText: "/rename stager-ninth" },
    { agentName: "alpha-ledger-01", commandText: "/color blue" },
    { agentName: "shadow-ledger-02", commandText: "/rename shadow-ledger-02" },
  ]);
  assert.equal(lines.length, 4);
  assert.equal(
    lineOf(lines, "stager-ninth"),
    "stager-ninth: colour is red, set to green (try 1 of 3); name is old-name, set to stager-ninth (try 1 of 3)",
  );
});

test("an agent that is already right is reported as right and nothing is typed", async () => {
  const court = await courtWith({
    liveAgents: [shadowThatIsRight("shadow-ledger-02")],
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(lines, [
    "shadow-ledger-02: colour purple is right; name shadow-ledger-02 is right",
  ]);
  assert.deepEqual(court.typed, []);
});

test("a busy agent is skipped this tick and the line says why", async () => {
  let agentIsBusy = true;
  const court = await courtWith({
    liveAgents: [shadowWithTheWrongColour("shadow-ledger-02")],
    typingResult: () => (agentIsBusy ? SKIPPED_BUSY : APPLIED),
  });

  const busyLines = await runAgentSettingsTick(REAL_RUN, court.deps);
  agentIsBusy = false;
  const idleLines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(busyLines, [
    "shadow-ledger-02: colour is blue, not set to purple: skipped-busy; name shadow-ledger-02 is right",
  ]);
  assert.match(idleLines[0]!, /set to purple \(try 1 of 3\)/);
});

test("an agent whose harness is not Claude Code is reported and nothing is typed", async () => {
  const court = await courtWith({
    liveAgents: [
      {
        ...shadowWithTheWrongColour("shadow-ledger-02"),
        harness: HARNESS_NAMES.CODEX,
      },
    ],
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(lines, [
    `shadow-ledger-02: runs ${HARNESS_NAMES.CODEX}, not Claude Code; nothing is typed`,
  ]);
  assert.deepEqual(court.typed, []);
});

test("a tab name that matches no recorded agent is reported and never renamed", async () => {
  const court = await courtWith({
    liveAgents: [
      {
        name: "scratch",
        role: undefined,
        isRecorded: false,
        session: { colour: undefined, sessionName: "something-else" },
      },
    ],
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(lines, [`scratch: ${TAB_NAME_MATCHES_NO_RECORDED_AGENT}`]);
  assert.deepEqual(court.typed, []);
});

test("a correction that keeps failing to stick is tried three times and then left alone", async () => {
  const court = await courtWith({
    liveAgents: [shadowWithTheWrongColour("shadow-ledger-02")],
    commandsStick: false,
  });

  const linesOfEveryTick: string[] = [];
  for (let tick = 1; tick <= 5; tick += 1) {
    linesOfEveryTick.push(
      ...(await runAgentSettingsTick(REAL_RUN, court.deps)),
    );
  }

  assert.deepEqual(commandsTypedInto(court, "shadow-ledger-02"), [
    "/color purple",
    "/color purple",
    "/color purple",
  ]);
  assert.match(linesOfEveryTick[3]!, /not set to purple: gave up after 3 tries/);
  assert.match(linesOfEveryTick[4]!, /not set to purple: left alone after 3 tries/);
});

test("an agent left alone after three tries is corrected again once its harness process changes", async () => {
  const shadow = shadowWithTheWrongColour("shadow-ledger-02");
  const court = await courtWith({ liveAgents: [shadow], commandsStick: false });
  for (let tick = 1; tick <= 4; tick += 1) {
    await runAgentSettingsTick(REAL_RUN, court.deps);
  }

  shadow.sessionId = "session-of-a-new-harness-process";
  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.equal(commandsTypedInto(court, "shadow-ledger-02").length, 4);
  assert.match(lines[0]!, /set to purple \(try 1 of 3\)/);
});

test("a colour name the harness refused is not tried again", async () => {
  const court = await courtWith({
    liveAgents: [shadowWithTheWrongColour("shadow-ledger-02")],
    typingResult: () => ({
      outcome: HARNESS_COMMAND_TYPING_OUTCOMES.FAILED,
      reason: "the command left a dialog open",
    }),
  });

  const firstLines = await runAgentSettingsTick(REAL_RUN, court.deps);
  const secondLines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(commandsTypedInto(court, "shadow-ledger-02"), [
    "/color purple",
  ]);
  assert.match(firstLines[0]!, /failed: the command left a dialog open/);
  assert.match(secondLines[0]!, /the harness refused that value/);
});

test("a pane that closed is not recorded as the harness refusing the setting", async () => {
  let paneIsClosed = true;
  const court = await courtWith({
    liveAgents: [shadowWithTheWrongColour("shadow-ledger-02")],
    typingResult: () =>
      paneIsClosed
        ? { outcome: HARNESS_COMMAND_TYPING_OUTCOMES.PANE_CLOSED }
        : APPLIED,
  });

  const firstLines = await runAgentSettingsTick(REAL_RUN, court.deps);
  paneIsClosed = false;
  const secondLines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.match(firstLines[0]!, /not set to purple: herdr no longer lists its pane/);
  assert.doesNotMatch(firstLines[0]!, /not tried again/);
  assert.match(secondLines[0]!, /set to purple \(try 1 of 3\)/);
});

test("a session whose name is unknown says so in its line", async () => {
  const court = await courtWith({
    liveAgents: [
      {
        name: "shadow-ledger-02",
        role: "Shadow",
        session: { colour: "purple", sessionName: undefined },
      },
    ],
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(lines, [
    "shadow-ledger-02: colour purple is right; name is unknown, set to shadow-ledger-02 (try 1 of 3)",
  ]);
});

test("a dead agent whose tab is still there is brought back", async () => {
  const court = await courtWith({
    deadAgentRevivals: {
      "shadow-ledger-02": {
        agentName: "shadow-ledger-02",
        kind: AGENT_REVIVAL_OUTCOMES.REVIVED,
        paneId: "pane-7",
        sessionId: "session-7",
      },
    },
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(lines, [
    "shadow-ledger-02: dead; its harness was brought back in pane pane-7, resuming session session-7; colour and name follow once it is idle",
  ]);
  assert.equal(court.revivalRequests.length, 1);
  assert.equal(court.revivalRequests[0]!.dryRun, false);
  assert.equal(court.revivalRequests[0]!.rosterEntries.length, 1);
});

test("a dead agent with no tab is reported and left alone", async () => {
  const court = await courtWith({
    deadAgentRevivals: {
      "shadow-ledger-02": {
        agentName: "shadow-ledger-02",
        kind: AGENT_REVIVAL_OUTCOMES.LEFT_ALONE,
      },
    },
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(lines, ["shadow-ledger-02: dead with no tab; left alone"]);
});

test("a dry run prints what would change and changes nothing", async () => {
  const court = await courtWith({
    liveAgents: [shadowWithTheWrongColour("shadow-ledger-02")],
    deadAgentRevivals: {
      "shadow-ledger-03": {
        agentName: "shadow-ledger-03",
        kind: AGENT_REVIVAL_OUTCOMES.WOULD_REVIVE,
        paneId: "pane-7",
        sessionId: "session-7",
      },
    },
  });

  const lines = await runAgentSettingsTick(DRY_RUN, court.deps);

  assert.deepEqual(lines, [
    "shadow-ledger-02: colour is blue, would be set to purple; name shadow-ledger-02 is right",
    "shadow-ledger-03: dead; its harness would be brought back in pane pane-7, resuming session session-7",
  ]);
  assert.deepEqual(court.typed, []);
  assert.deepEqual(
    court.revivalRequests.map((request) => request.dryRun),
    [true],
  );
  assert.deepEqual(await readdir(court.agentDataRoot), []);
});

test("a manual tick does not reset the retry count", async () => {
  const shadow = shadowWithTheWrongColour("shadow-ledger-02");
  const timedCourt = await courtWith({
    liveAgents: [shadow],
    commandsStick: false,
  });
  const manualCourt = await courtWith({
    liveAgents: [shadow],
    commandsStick: false,
    agentDataRoot: timedCourt.agentDataRoot,
  });
  const timedWorker = new AgentSettingsHostedWorker({
    runTick: () => runAgentSettingsTick(REAL_RUN, timedCourt.deps),
    log: () => undefined,
  });

  await timedWorker.runOnce();
  await timedWorker.runOnce();
  await runAgentSettingsTick(REAL_RUN, manualCourt.deps);
  const manualLines = await runAgentSettingsTick(REAL_RUN, manualCourt.deps);
  await timedWorker.runOnce();

  assert.equal(timedCourt.typed.length + manualCourt.typed.length, 3);
  assert.match(manualLines[0]!, /gave up after 3 tries/);
});

test("one agent's failure does not stop the others from being checked", async () => {
  const court = await courtWith({
    liveAgents: [
      shadowWithTheWrongColour("shadow-ledger-02"),
      shadowWithTheWrongColour("shadow-ledger-03"),
    ],
    agentWhoseSpawnRecordCannotBeRead: "shadow-ledger-02",
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.equal(
    lineOf(lines, "shadow-ledger-02"),
    "shadow-ledger-02: failed: the spawn record is unreadable",
  );
  assert.deepEqual(commandsTypedInto(court, "shadow-ledger-03"), [
    "/color purple",
  ]);
});

test("the worker does nothing when the config switch is off", async () => {
  const court = await courtWith({
    liveAgents: [shadowWithTheWrongColour("shadow-ledger-02")],
    deadAgentRevivals: {
      "shadow-ledger-03": {
        agentName: "shadow-ledger-03",
        kind: AGENT_REVIVAL_OUTCOMES.REVIVED,
        paneId: "pane-7",
        sessionId: "session-7",
      },
    },
    checkEnabled: false,
  });
  const logged: string[] = [];
  const worker = new AgentSettingsHostedWorker({
    runTick: () => runAgentSettingsTick(REAL_RUN, court.deps),
    log: (line) => logged.push(line),
  });

  await worker.runOnce();

  assert.equal(court.rosterReads, 0);
  assert.deepEqual(court.typed, []);
  assert.deepEqual(court.revivalRequests, []);
  assert.deepEqual(logged, [AGENT_SETTINGS_CHECK_IS_SWITCHED_OFF]);
});

interface HostedWorkersProvider {
  readonly provide: unknown;
  readonly inject: unknown[];
  readonly useFactory: (...workers: unknown[]) => unknown[];
}

test("the agent settings worker is hosted in the backend beside the other workers", () => {
  const providers: Partial<HostedWorkersProvider>[] = Reflect.getMetadata(
    "providers",
    ThroneBackendModule,
  );
  const hostedWorkers = providers.find(
    (provider) => provider.provide === HOSTED_WORKERS,
  ) as HostedWorkersProvider;
  const worker = new AgentSettingsHostedWorker();

  assert.ok(
    hostedWorkers
      .useFactory(...hostedWorkers.inject)
      .includes(AgentSettingsHostedWorker),
  );
  assert.equal(worker.kind, "cron");
  assert.equal(worker.workerName, AGENT_SETTINGS_HOSTED_WORKER_NAME);
  assert.equal(worker.workerName, "agent-settings");
  assert.equal(worker.cronExpression, CronExpression.EVERY_5_MINUTES);
});
