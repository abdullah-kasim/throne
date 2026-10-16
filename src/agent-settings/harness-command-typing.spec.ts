import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  claudeComposerLine,
  claudeScreen,
  DIM_HINT,
} from "../../test/claude-screens.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import {
  HERDR_PANE_NOT_FOUND_ERROR_CODE,
  HerdrCommandError,
} from "../herdr/herdr-client.ts";
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
  HARNESS_COMMAND_TYPING_OUTCOMES,
  typeHarnessCommandIntoIdleClaudePane,
} from "./harness-command-typing.ts";

const COLOUR_COMMAND = "/color red";
const HUMAN_DRAFT = "a sentence the human has not finished";
const ENTER_KEY = "Enter";
const ESCAPE_KEY = "Escape";

const EMPTY_TEXTBOX_SCREEN = claudeScreen(claudeComposerLine(DIM_HINT));
const HUMAN_DRAFT_SCREEN = claudeScreen(claudeComposerLine(HUMAN_DRAFT));
const NO_TEXTBOX_SCREEN = claudeScreen("a screen that shows no textbox");
const OPEN_DIALOG_SCREEN = await readFile(
  new URL(
    "../../test/fixtures/claude-live-fleet-interactive-select-menu.ansi",
    import.meta.url,
  ),
  "utf8",
);

type PaneInput =
  | { kind: "text"; text: string; whileHoldingLockOf: string | undefined }
  | { kind: "key"; key: string; whileHoldingLockOf: string | undefined };

interface FakeClaudePane {
  deps: SubmitToAgentDeps;
  inputs: PaneInput[];
  lockedPaneIds: string[];
  capturedScreenDiagnostics: string[];
}

interface FakeClaudePaneOptions {
  screen: string;
  liveAgentStatus?: AgentStatus;
  humanDraftAppearsAfterScreenReads?: number;
  screenAfterEnter?: string;
  paneClosesOnEnter?: boolean;
}

function fakeClaudePane(options: FakeClaudePaneOptions): FakeClaudePane {
  let screen = options.screen;
  let screenReads = 0;
  let paneIsClosed = false;
  let paneIdOfHeldLock: string | undefined;
  const inputs: PaneInput[] = [];
  const lockedPaneIds: string[] = [];
  const capturedScreenDiagnostics: string[] = [];
  const deps: Partial<SubmitToAgentDeps> = {
    ...fakeVirtualClock(),
    getPaneProcessInfo: async (paneId: string) => {
        if (paneIsClosed) {
          throw new HerdrCommandError(["pane", "process-info"], "pane not found", {
            code: HERDR_PANE_NOT_FOUND_ERROR_CODE,
          });
        }
        return {
          paneId,
          foregroundProcesses: [{ name: "claude", argv: ["claude"] }],
        };
      },
    readVisibleAgentAnsi: async () => {
      screenReads += 1;
      if (screenReads > (options.humanDraftAppearsAfterScreenReads ?? Infinity)) {
        screen = HUMAN_DRAFT_SCREEN;
      }
      return screen;
    },
    refreshRecipientIdentity: async (_name: string, initial: HerdrAgent) => ({
      ...initial,
      agentStatus: options.liveAgentStatus ?? initial.agentStatus,
    }),
    withRecipientPaneLock: async <Result>(
      paneId: string,
      action: () => Promise<Result>,
    ): Promise<Result> => {
      lockedPaneIds.push(paneId);
      paneIdOfHeldLock = paneId;
      try {
        return await action();
      } finally {
        paneIdOfHeldLock = undefined;
      }
    },
    sendText: async (_paneId: string, text: string) => {
      inputs.push({ kind: "text", text, whileHoldingLockOf: paneIdOfHeldLock });
      screen = claudeScreen(claudeComposerLine(text));
    },
    pressEnter: async () => {
      inputs.push({
        kind: "key",
        key: ENTER_KEY,
        whileHoldingLockOf: paneIdOfHeldLock,
      });
      screen = options.screenAfterEnter ?? EMPTY_TEXTBOX_SCREEN;
      paneIsClosed = options.paneClosesOnEnter ?? false;
    },
    pressPaneKey: async (_paneId: string, key: string) => {
      inputs.push({ kind: "key", key, whileHoldingLockOf: paneIdOfHeldLock });
    },
    captureComposerDiagnostic: async (recipient: string) => {
      capturedScreenDiagnostics.push(recipient);
      return undefined;
    },
  };
  return {
    deps: deps as SubmitToAgentDeps,
    inputs,
    lockedPaneIds,
    capturedScreenDiagnostics,
  };
}

function typedTexts(pane: FakeClaudePane): string[] {
  return pane.inputs.flatMap((input) =>
    input.kind === "text" ? [input.text] : [],
  );
}

function pressedKeys(pane: FakeClaudePane): string[] {
  return pane.inputs.flatMap((input) =>
    input.kind === "key" ? [input.key] : [],
  );
}

async function assertSkippedBusyWithNothingSent(
  pane: FakeClaudePane,
): Promise<void> {
  const result = await typeHarnessCommandIntoIdleClaudePane(
    fakeClaudeAgent(),
    COLOUR_COMMAND,
    pane.deps,
  );
  assert.deepEqual(result, {
    outcome: HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_BUSY,
  });
  assert.deepEqual(pane.inputs, []);
  assert.deepEqual(pane.capturedScreenDiagnostics, []);
}

test("a harness command reaches an idle empty Claude Code textbox exactly as written", async () => {
  const pane = fakeClaudePane({ screen: EMPTY_TEXTBOX_SCREEN });
  await typeHarnessCommandIntoIdleClaudePane(
    fakeClaudeAgent(),
    COLOUR_COMMAND,
    pane.deps,
  );
  assert.deepEqual(typedTexts(pane), [COLOUR_COMMAND]);
  assert.deepEqual(pane.inputs[0], {
    kind: "text",
    text: COLOUR_COMMAND,
    whileHoldingLockOf: fakeClaudeAgent().paneId,
  });
  assert.deepEqual([...new Set(pressedKeys(pane))], [ENTER_KEY]);
});

test("a harness command is never wrapped as a message from another agent", async () => {
  const pane = fakeClaudePane({ screen: EMPTY_TEXTBOX_SCREEN });
  await typeHarnessCommandIntoIdleClaudePane(
    fakeClaudeAgent(),
    COLOUR_COMMAND,
    pane.deps,
  );
  const [typed] = typedTexts(pane);
  assert.equal(typed?.startsWith("/"), true);
  assert.equal(typed?.includes(" said: "), false);
  assert.equal(typed?.includes("[message"), false);
});

test("nothing is typed into a pane whose agent is not idle", async () => {
  await assertSkippedBusyWithNothingSent(
    fakeClaudePane({ screen: EMPTY_TEXTBOX_SCREEN, liveAgentStatus: "working" }),
  );
});

test("a resident human draft is never overwritten or submitted", async () => {
  await assertSkippedBusyWithNothingSent(
    fakeClaudePane({ screen: HUMAN_DRAFT_SCREEN }),
  );
});

test("a human draft that appears after the pane was judged safe is still never submitted", async () => {
  await assertSkippedBusyWithNothingSent(
    fakeClaudePane({
      screen: EMPTY_TEXTBOX_SCREEN,
      humanDraftAppearsAfterScreenReads: 1,
    }),
  );
});

test("nothing is typed while a dialog or prompt is showing", async () => {
  await assertSkippedBusyWithNothingSent(
    fakeClaudePane({ screen: OPEN_DIALOG_SCREEN }),
  );
});

test("nothing is typed when the composer cannot be recognised", async () => {
  await assertSkippedBusyWithNothingSent(
    fakeClaudePane({ screen: NO_TEXTBOX_SCREEN }),
  );
});

test("a pane that is not Claude Code is skipped and nothing is typed", async () => {
  const pane = fakeClaudePane({ screen: EMPTY_TEXTBOX_SCREEN });
  const result = await typeHarnessCommandIntoIdleClaudePane(
    { ...fakeClaudeAgent(), agent: HARNESS_NAMES.CODEX },
    COLOUR_COMMAND,
    pane.deps,
  );
  assert.deepEqual(result, {
    outcome: HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_NOT_CLAUDE,
  });
  assert.deepEqual(pane.inputs, []);
  assert.deepEqual(pane.lockedPaneIds, []);
});

test("a command is typed only while holding the same pane lock message delivery uses", async () => {
  const agent = fakeClaudeAgent();
  const pane = fakeClaudePane({ screen: EMPTY_TEXTBOX_SCREEN });
  await typeHarnessCommandIntoIdleClaudePane(agent, COLOUR_COMMAND, pane.deps);
  assert.deepEqual(pane.lockedPaneIds, [agent.paneId]);
  assert.notDeepEqual(pane.inputs, []);
  assert.deepEqual(
    [...new Set(pane.inputs.map((input) => input.whileHoldingLockOf))],
    [agent.paneId],
  );
});

test("a command that leaves the textbox empty again is reported as applied", async () => {
  const pane = fakeClaudePane({ screen: EMPTY_TEXTBOX_SCREEN });
  const result = await typeHarnessCommandIntoIdleClaudePane(
    fakeClaudeAgent(),
    COLOUR_COMMAND,
    pane.deps,
  );
  assert.deepEqual(result, {
    outcome: HARNESS_COMMAND_TYPING_OUTCOMES.APPLIED,
  });
});

test("a command that leaves a picker open gets one Escape and is reported as failed", async () => {
  const pane = fakeClaudePane({
    screen: EMPTY_TEXTBOX_SCREEN,
    screenAfterEnter: OPEN_DIALOG_SCREEN,
  });
  const result = await typeHarnessCommandIntoIdleClaudePane(
    fakeClaudeAgent(),
    COLOUR_COMMAND,
    pane.deps,
  );
  assert.equal(result.outcome, HARNESS_COMMAND_TYPING_OUTCOMES.FAILED);
  assert.deepEqual(pressedKeys(pane), [ENTER_KEY, ESCAPE_KEY]);
});

test("a pane that closes while a command waits for an empty textbox ends the wait at once", async () => {
  const pane = fakeClaudePane({
    screen: EMPTY_TEXTBOX_SCREEN,
    paneClosesOnEnter: true,
  });
  const startedAt = pane.deps.now();
  const result = await typeHarnessCommandIntoIdleClaudePane(
    fakeClaudeAgent(),
    COLOUR_COMMAND,
    pane.deps,
  );
  assert.deepEqual(result, {
    outcome: HARNESS_COMMAND_TYPING_OUTCOMES.PANE_CLOSED,
  });
  assert.ok(pane.deps.now() - startedAt <= 2_000);
  assert.deepEqual(pressedKeys(pane), [ENTER_KEY]);
});
