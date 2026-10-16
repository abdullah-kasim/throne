import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  correctSettingsRightAfterSpawn,
  type SettingsAtSpawnDeps,
} from "../agent-settings/agent-settings-at-spawn.ts";
import { CORRECTION_TRIES_ALLOWED } from "../agent-settings/agent-settings-retry-history.ts";
import { runAgentSettingsTick } from "../agent-settings/agent-settings-tick.ts";
import {
  APPLIED,
  REAL_RUN,
  SKIPPED_BUSY,
  commandsTypedInto,
  courtWith,
  lineOf,
  shadowThatIsRight,
  type Court,
  type LiveAgentInTheCourt,
} from "../agent-settings/agent-settings-tick.test-support.ts";
import { HARNESS_NAMES, type Harness } from "../harness-routing/harness.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
} from "../message-queue/message-queue.store.ts";
import type { MessageDeliveryWorkItemPayload } from "../send-agent/message-delivery-enqueue.ts";
import type { CreateAgentDeps, PolicyResolution } from "./create.types.ts";
import {
  OPENING_PROMPT_IS_STILL_QUEUED,
  deliverAgentOpeningPrompt,
  type OpeningPromptDeliveryResult,
} from "./opening-prompt.ts";
import { baseDeps, baseRequest } from "./policy-test-fixtures.ts";

const NEW_AGENT = "shadow-ledger-02";
const OPENING_PROMPT = "You are shadow-ledger-02. Read your assignment.";
const OPENING_PROMPT_WAS_QUEUED = "the opening prompt was queued";
const OPENING_PROMPT_WAS_DELIVERED = "the opening prompt was delivered";
const COLOUR_STEP_BEGAN = "the colour step began";
const ALL_WORK_ITEM_STATES = Object.values(MessageQueueWorkItemState);
const HARNESS_WAS_LAUNCHED = true;
const HARNESS_WAS_ALREADY_RUNNING = false;

interface SpawnOptions {
  readonly newAgent: LiveAgentInTheCourt;
  readonly court?: Parameters<typeof courtWith>[0];
  readonly launchHarness?: Harness;
  readonly harnessWasLaunched?: boolean;
  readonly waitUntilThePaneTakesACommand?: SettingsAtSpawnDeps["waitUntilThePaneTakesACommand"];
  readonly correctSettingsRightAfterSpawn?: CreateAgentDeps["correctSettingsRightAfterSpawn"];
  readonly promptIsNeverDelivered?: boolean;
}

interface Spawn {
  readonly court: Court;
  readonly delivery: OpeningPromptDeliveryResult;
  readonly eventsInOrder: string[];
  readonly errorLines: string[];
  readonly readinessWaits: number;
  readonly promptsInTheQueue: { prompt: string; state: string }[];
}

function agentWithNeitherColourNorName(name: string): LiveAgentInTheCourt {
  return {
    ...shadowThatIsRight(name),
    session: { colour: undefined, sessionName: undefined },
  };
}

function agentWithItsNameButNoColour(name: string): LiveAgentInTheCourt {
  return {
    ...shadowThatIsRight(name),
    session: { colour: undefined, sessionName: name },
  };
}

async function registeredPaneOf(court: Court): Promise<HerdrAgent> {
  const [pane] = await court.deps.listPaneAgents();
  return pane!;
}

function queueStoreThatRecordsEnqueues(
  databasePath: string,
  eventsInOrder: string[],
): MessageQueueStore {
  const store = openMessageQueueStore(databasePath);
  const insertWorkItem = store.insertWorkItem.bind(store);
  store.insertWorkItem = (item) => {
    eventsInOrder.push(OPENING_PROMPT_WAS_QUEUED);
    return insertWorkItem(item);
  };
  return store;
}

function deliverEveryQueuedPrompt(databasePath: string, eventsInOrder: string[]): void {
  const store = openMessageQueueStore(databasePath);
  try {
    for (const item of store.listWorkItemsByStates([MessageQueueWorkItemState.Queued])) {
      store.claimDueWorkItem(item.id);
      store.transitionWorkItemState(item.id, MessageQueueWorkItemState.Delivered);
      eventsInOrder.push(OPENING_PROMPT_WAS_DELIVERED);
    }
  } finally {
    store.close();
  }
}

async function withSpawnOf(
  options: SpawnOptions,
  inspect: (spawn: Spawn) => Promise<void>,
): Promise<void> {
  const scratchRoot = await mkdtemp(path.join(tmpdir(), "settings-at-spawn-"));
  const databasePath = path.join(scratchRoot, "queue.sqlite3");
  const eventsInOrder: string[] = [];
  const errorLines: string[] = [];
  let readinessWaits = 0;
  try {
    const court = await courtWith({
      ...options.court,
      liveAgents: [options.newAgent],
      agentDataRoot: scratchRoot,
    });
    const typeHarnessCommand = court.deps.typeHarnessCommand;
    const settingsAtSpawnDeps: SettingsAtSpawnDeps = {
      check: {
        ...court.deps,
        typeHarnessCommand: (paneAgent, commandText) => {
          eventsInOrder.push(commandText);
          return typeHarnessCommand(paneAgent, commandText);
        },
      },
      waitUntilThePaneTakesACommand: async (agent, deadline) => {
        readinessWaits += 1;
        await options.waitUntilThePaneTakesACommand?.(agent, deadline);
      },
      now: () => 0,
    };
    const pane = await registeredPaneOf(court);
    const delivery = await deliverAgentOpeningPrompt(
      baseRequest({
        name: options.newAgent.name,
        launchHarness: options.launchHarness ?? HARNESS_NAMES.CLAUDE,
      }) as PolicyResolution,
      baseDeps({
        resolveAgent: async () => pane,
        openMessageQueueStore: () =>
          queueStoreThatRecordsEnqueues(databasePath, eventsInOrder),
        sleep: async () => {
          if (!options.promptIsNeverDelivered) {
            deliverEveryQueuedPrompt(databasePath, eventsInOrder);
          }
        },
        writeStderr: (text) => errorLines.push(text),
        correctSettingsRightAfterSpawn: (agent, agentName) => {
          eventsInOrder.push(COLOUR_STEP_BEGAN);
          return options.correctSettingsRightAfterSpawn
            ? options.correctSettingsRightAfterSpawn(agent, agentName)
            : correctSettingsRightAfterSpawn(agent, agentName, settingsAtSpawnDeps);
        },
      }),
      OPENING_PROMPT,
      options.harnessWasLaunched ?? HARNESS_WAS_LAUNCHED,
    );
    const store = openMessageQueueStore(databasePath);
    try {
      await inspect({
        court,
        delivery,
        eventsInOrder,
        errorLines,
        readinessWaits,
        promptsInTheQueue: store
          .listWorkItemsByStates(ALL_WORK_ITEM_STATES)
          .map((item) => ({
            prompt: (item.payload as MessageDeliveryWorkItemPayload).prompt,
            state: item.state,
          })),
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

function assertTheOpeningPromptWasStillDelivered(spawn: Spawn): void {
  assert.equal(spawn.delivery.delivered, true);
  assert.deepEqual(
    spawn.promptsInTheQueue.map((item) => item.prompt),
    [OPENING_PROMPT],
  );
}

test("the opening prompt is queued before the new session is coloured", async () => {
  await withSpawnOf(
    { newAgent: agentWithNeitherColourNorName(NEW_AGENT) },
    async (spawn) => {
      assert.deepEqual(spawn.eventsInOrder, [
        OPENING_PROMPT_WAS_QUEUED,
        OPENING_PROMPT_WAS_DELIVERED,
        COLOUR_STEP_BEGAN,
        "/color purple",
      ]);
      assert.equal(spawn.readinessWaits, 1);
      assert.deepEqual(spawn.errorLines, []);
      assertTheOpeningPromptWasStillDelivered(spawn);
    },
  );
});

test("a newly started agent that was launched with its name is not renamed at spawn", async () => {
  await withSpawnOf(
    { newAgent: agentWithNeitherColourNorName(NEW_AGENT) },
    async (spawn) => {
      assert.deepEqual(commandsTypedInto(spawn.court, NEW_AGENT), [
        "/color purple",
      ]);
      assertTheOpeningPromptWasStillDelivered(spawn);
      await runAgentSettingsTick(REAL_RUN, spawn.court.deps);
      assert.deepEqual(commandsTypedInto(spawn.court, NEW_AGENT), [
        "/color purple",
        `/rename ${NEW_AGENT}`,
      ]);
    },
  );
});

test("a newly started agent whose recorded name is wrong is still renamed at spawn", async () => {
  await withSpawnOf(
    {
      newAgent: {
        ...shadowThatIsRight(NEW_AGENT),
        session: { colour: "purple", sessionName: "a-name-from-an-earlier-session" },
      },
    },
    async (spawn) => {
      assert.deepEqual(commandsTypedInto(spawn.court, NEW_AGENT), [
        `/rename ${NEW_AGENT}`,
      ]);
      assertTheOpeningPromptWasStillDelivered(spawn);
    },
  );
});

test("a newly started agent whose textbox is not safe to type into is left for the next check and still gets its opening prompt", async () => {
  const newAgent = agentWithItsNameButNoColour(NEW_AGENT);
  let textboxIsSafe = false;
  await withSpawnOf(
    {
      newAgent,
      court: { typingResult: () => (textboxIsSafe ? APPLIED : SKIPPED_BUSY) },
    },
    async (spawn) => {
      assert.equal(commandsTypedInto(spawn.court, NEW_AGENT).length, 1);
      assert.equal(newAgent.session.colour, undefined);
      assertTheOpeningPromptWasStillDelivered(spawn);
      textboxIsSafe = true;
      const nextCheck = await runAgentSettingsTick(REAL_RUN, spawn.court.deps);
      assert.match(lineOf(nextCheck, NEW_AGENT), /set to purple \(try 1 of 3\)/);
    },
  );
});

test("a newly started agent whose harness never becomes ready is left for the next check and still gets its opening prompt", async () => {
  await withSpawnOf(
    {
      newAgent: agentWithNeitherColourNorName(NEW_AGENT),
      waitUntilThePaneTakesACommand: async () => {
        throw new Error("startup did not settle before the deadline");
      },
    },
    async (spawn) => {
      assert.equal(spawn.readinessWaits, 1);
      assert.deepEqual(spawn.court.typed, []);
      assert.equal(spawn.errorLines.length, 1);
      assert.match(spawn.errorLines[0]!, /left for the next agent-settings check/);
      assertTheOpeningPromptWasStillDelivered(spawn);
    },
  );
});

test("a failure while correcting a newly started agent does not fail the spawn", async () => {
  let correctionAttempts = 0;
  await withSpawnOf(
    {
      newAgent: agentWithNeitherColourNorName(NEW_AGENT),
      correctSettingsRightAfterSpawn: async () => {
        correctionAttempts += 1;
        throw new Error("the correction broke");
      },
    },
    async (spawn) => {
      assert.equal(correctionAttempts, 1);
      assert.equal(spawn.errorLines.length, 1);
      assert.match(spawn.errorLines[0]!, /the correction broke/);
      assert.deepEqual(spawn.delivery, {
        delivered: true,
        outcome: "not-applicable",
      });
      assertTheOpeningPromptWasStillDelivered(spawn);
    },
  );
});

test("a newly started agent that is not Claude Code has nothing typed into it", async () => {
  await withSpawnOf(
    {
      newAgent: {
        ...agentWithNeitherColourNorName(NEW_AGENT),
        harness: HARNESS_NAMES.CODEX,
      },
      launchHarness: HARNESS_NAMES.CODEX,
    },
    async (spawn) => {
      assert.equal(spawn.readinessWaits, 0);
      assert.deepEqual(spawn.court.typed, []);
      assertTheOpeningPromptWasStillDelivered(spawn);
    },
  );
});

test("an agent whose harness was already running has nothing typed into it at spawn", async () => {
  await withSpawnOf(
    {
      newAgent: agentWithNeitherColourNorName(NEW_AGENT),
      harnessWasLaunched: HARNESS_WAS_ALREADY_RUNNING,
    },
    async (spawn) => {
      assert.equal(spawn.readinessWaits, 0);
      assert.deepEqual(spawn.court.typed, []);
      assert.deepEqual(spawn.promptsInTheQueue, []);
      assert.equal(spawn.delivery.delivered, true);
    },
  );
});

test("the correction at spawn and the regular check share one count of tries", async () => {
  await withSpawnOf(
    {
      newAgent: agentWithItsNameButNoColour(NEW_AGENT),
      court: { commandsStick: false },
    },
    async (spawn) => {
      const linesOfLaterChecks: string[] = [];
      for (let check = 0; check < CORRECTION_TRIES_ALLOWED; check += 1) {
        linesOfLaterChecks.push(
          lineOf(await runAgentSettingsTick(REAL_RUN, spawn.court.deps), NEW_AGENT),
        );
      }
      assert.match(linesOfLaterChecks[0]!, /set to purple \(try 2 of 3\)/);
      assert.match(linesOfLaterChecks[1]!, /set to purple \(try 3 of 3\)/);
      assert.match(linesOfLaterChecks[2]!, /gave up after 3 tries/);
      assert.equal(
        commandsTypedInto(spawn.court, NEW_AGENT).length,
        CORRECTION_TRIES_ALLOWED,
      );
    },
  );
});

test("nothing is typed at spawn when the settings check is switched off", async () => {
  await withSpawnOf(
    {
      newAgent: agentWithNeitherColourNorName(NEW_AGENT),
      court: { checkEnabled: false },
    },
    async (spawn) => {
      assert.deepEqual(spawn.court.typed, []);
      assert.deepEqual(spawn.errorLines, []);
      assertTheOpeningPromptWasStillDelivered(spawn);
    },
  );
});

test("a slow or failing colour step does not delay the opening prompt", async () => {
  await withSpawnOf(
    {
      newAgent: agentWithNeitherColourNorName(NEW_AGENT),
      correctSettingsRightAfterSpawn: async () => {
        throw new Error("the colour step broke");
      },
    },
    async (spawn) => {
      assert.deepEqual(spawn.eventsInOrder, [
        OPENING_PROMPT_WAS_QUEUED,
        OPENING_PROMPT_WAS_DELIVERED,
        COLOUR_STEP_BEGAN,
      ]);
      assert.match(spawn.errorLines[0]!, /the colour step broke/);
      assertTheOpeningPromptWasStillDelivered(spawn);
    },
  );
});

test("nothing is typed into a new session while its opening prompt still waits in the queue", async () => {
  await withSpawnOf(
    {
      newAgent: agentWithNeitherColourNorName(NEW_AGENT),
      promptIsNeverDelivered: true,
    },
    async (spawn) => {
      assert.deepEqual(spawn.court.typed, []);
      assert.equal(spawn.readinessWaits, 0);
      assert.equal(spawn.errorLines.length, 1);
      assert.ok(spawn.errorLines[0]!.includes(OPENING_PROMPT_IS_STILL_QUEUED));
      assert.deepEqual(spawn.promptsInTheQueue, [
        { prompt: OPENING_PROMPT, state: MessageQueueWorkItemState.Queued },
      ]);
      assert.equal(spawn.delivery.delivered, true);
    },
  );
});
