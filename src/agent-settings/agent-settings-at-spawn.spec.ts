import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeComposerLine,
  claudeScreen,
  DIM_HINT,
} from "../../test/claude-screens.ts";
import type {
  AgentStatus,
  HerdrAgent,
} from "../herdr/herdr-inventory.service.ts";
import {
  fakeClaudeAgent,
  fakeVirtualClock,
} from "../herdr/herdr-send-test-fixtures.ts";
import type { SubmitToAgentDeps } from "../herdr/herdr-send.types.ts";
import {
  courtWith,
  shadowWithTheWrongColour,
} from "./agent-settings-tick.test-support.ts";
import {
  correctSettingsRightAfterSpawn,
  HARNESS_DID_NOT_REPORT_ITSELF_IDLE,
  HARNESS_READY_WAIT_AT_SPAWN_MILLISECONDS,
  waitUntilTheClaudePaneTakesACommand,
} from "./agent-settings-at-spawn.ts";

const EMPTY_TEXTBOX_SCREEN = claudeScreen(claudeComposerLine(DIM_HINT));
const STATUS_OF_A_PANE_STILL_STARTING: AgentStatus = "unknown";

interface StartingPane {
  readonly deps: SubmitToAgentDeps;
  statusReads: number;
}

function paneThatReportsIdleAfter(statusReadsBeforeIdle: number): StartingPane {
  const pane: StartingPane = {
    statusReads: 0,
    deps: {
      ...fakeVirtualClock(),
      getPaneProcessInfo: async (paneId: string) => ({
        paneId,
        foregroundProcesses: [{ name: "claude", argv: ["claude"] }],
      }),
      readVisibleAgentAnsi: async () => EMPTY_TEXTBOX_SCREEN,
      refreshRecipientIdentity: async (_name: string, initial: HerdrAgent) => {
        pane.statusReads += 1;
        return {
          ...initial,
          agentStatus:
            pane.statusReads > statusReadsBeforeIdle
              ? "idle"
              : STATUS_OF_A_PANE_STILL_STARTING,
        };
      },
    } as Partial<SubmitToAgentDeps> as SubmitToAgentDeps,
  };
  return pane;
}

test("a new pane with an empty textbox is waited for until its harness reports itself idle", async () => {
  const pane = paneThatReportsIdleAfter(2);

  await waitUntilTheClaudePaneTakesACommand(
    fakeClaudeAgent(),
    pane.deps.now() + HARNESS_READY_WAIT_AT_SPAWN_MILLISECONDS,
    pane.deps,
  );

  assert.equal(pane.statusReads, 3);
});

test("a new pane whose harness never reports itself idle stops being waited for at the deadline", async () => {
  const pane = paneThatReportsIdleAfter(Infinity);
  const deadline = pane.deps.now() + HARNESS_READY_WAIT_AT_SPAWN_MILLISECONDS;

  await assert.rejects(
    waitUntilTheClaudePaneTakesACommand(fakeClaudeAgent(), deadline, pane.deps),
    { message: HARNESS_DID_NOT_REPORT_ITSELF_IDLE },
  );

  assert.equal(pane.deps.now(), deadline);
});

test("the correction right after spawn does not wait on the pane of an agent whose mod takes commands", async () => {
  const court = await courtWith({ liveAgents: [shadowWithTheWrongColour("shadow-one")] });
  let paneWaits = 0;
  await correctSettingsRightAfterSpawn(fakeClaudeAgent(), "shadow-one", {
    check: court.deps,
    waitUntilThePaneTakesACommand: async () => {
      paneWaits += 1;
    },
    claudeModTakesCommands: async () => true,
    now: () => 0,
  });
  assert.equal(paneWaits, 0);
  assert.notDeepEqual(court.typed, []);
});
