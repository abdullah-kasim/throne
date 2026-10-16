import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { HARNESS_NAMES } from "../src/harness-routing/harness.ts";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";
import { fakeClaudeAgent, fakeVirtualClock } from "../src/herdr/herdr-send-test-fixtures.ts";
import { submitToAgentWhileLocked } from "../src/herdr/herdr-send-transaction.ts";
import { SubmitNotSentError, type SubmitToAgentDeps } from "../src/herdr/herdr-send.types.ts";
import { REGENT_NAME } from "../src/regent-state/regent-liveness.ts";
import { claudeComposerLine, claudeScreen, DIM_HINT, WHITE } from "./claude-screens.ts";

const TODAYS_FAILURE_TEXT =
  "active bottom composer could not be identified before the composer deadline; nothing was written";
const EMPTY_COMPOSER_SCREEN = claudeScreen(claudeComposerLine(DIM_HINT));
const SHORT_COMPOSER_WAIT = { composerWaitMilliseconds: 5_000 };

function fixture(name: string): Promise<string> {
  return readFile(path.join(import.meta.dirname, "fixtures", name), "utf8");
}

const usageTabDialog = await fixture("claude-settings-dialog-usage-tab.ansi");
const statusTabDialog = await fixture("claude-settings-dialog-status-tab.ansi");

function dialogHeaderQuotedAbove(screen: string): string {
  const dialogLines = usageTabDialog.split("\n");
  const tabLineIndex = dialogLines.findIndex((line) => line.includes("Settings"));
  return [dialogLines[tabLineIndex - 1], dialogLines[tabLineIndex], screen].join("\n");
}

function regentAgent(name: string = REGENT_NAME): HerdrAgent {
  return { ...fakeClaudeAgent(), name };
}

interface SimulatedPane {
  readonly deps: SubmitToAgentDeps;
  readonly keysPressed: string[];
  readonly textsWritten: string[];
}

function simulatedPane(
  agent: HerdrAgent,
  initialScreen: string,
  screenAfterEscape?: string,
): SimulatedPane {
  let screen = initialScreen;
  const keysPressed: string[] = [];
  const textsWritten: string[] = [];
  const readScreen = async (): Promise<string> => screen;
  const deps = {
    ...fakeVirtualClock(),
    getPaneProcessInfo: async () => ({
      paneId: agent.paneId,
      foregroundProcesses: [{ name: agent.agent, argv: [agent.agent] }],
    }),
    readVisibleAgentAnsi: readScreen,
    readRecentAgentAnsi: readScreen,
    pressPaneKey: async (_pane: string, key: string) => {
      keysPressed.push(key);
      if (key === "Escape" && screenAfterEscape !== undefined) screen = screenAfterEscape;
    },
    sendText: async (_pane: string, text: string) => {
      textsWritten.push(text);
      screen = claudeScreen(claudeComposerLine(`${WHITE}${text}`));
    },
    pressEnter: async () => {
      screen = EMPTY_COMPOSER_SCREEN;
    },
  } as SubmitToAgentDeps;
  return { deps, keysPressed, textsWritten };
}

function recordedLogLines(context: TestContext): () => string[] {
  const write = context.mock.method(process.stderr, "write", () => true);
  return () => write.mock.calls.map((call) => String(call.arguments[0]));
}

async function failureTextOfUndeliveredMessage(agent: HerdrAgent, pane: SimulatedPane): Promise<string> {
  const failure: unknown = await submitToAgentWhileLocked(
    agent,
    "sender",
    "hello",
    SHORT_COMPOSER_WAIT,
    pane.deps,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof SubmitNotSentError);
  assert.ok(failure.cause instanceof Error);
  return failure.cause.message;
}

test("the dialog on the Regent's pane is closed and the message then delivered", async (context) => {
  const logLines = recordedLogLines(context);
  const openDialogs = [
    { dialog: usageTabDialog, recipientName: REGENT_NAME },
    { dialog: statusTabDialog, recipientName: REGENT_NAME.toLowerCase() },
  ];
  for (const [index, { dialog, recipientName }] of openDialogs.entries()) {
    const agent = regentAgent(recipientName);
    const pane = simulatedPane(agent, dialog, EMPTY_COMPOSER_SCREEN);

    const delivered = await submitToAgentWhileLocked(agent, "sender", "hello", {}, pane.deps);

    assert.equal(delivered, "sender said: hello");
    assert.deepEqual(pane.textsWritten, ["sender said: hello"]);
    assert.deepEqual(pane.keysPressed, ["Escape"]);
    assert.equal(logLines().length, index + 1);
    assert.match(logLines()[index]!, new RegExp(`^send-agent: .*${recipientName}.*press 1 `, "u"));
  }
});

test("the same dialog on a Stager's, an Alpha's or a Shadow's pane gets no key", async (context) => {
  const logLines = recordedLogLines(context);
  for (const recipientName of ["stager-one", "alpha-example-01", "shadow-example-01-part"]) {
    for (const dialog of [usageTabDialog, statusTabDialog]) {
      const agent = regentAgent(recipientName);
      const pane = simulatedPane(agent, dialog, EMPTY_COMPOSER_SCREEN);

      assert.equal(await failureTextOfUndeliveredMessage(agent, pane), TODAYS_FAILURE_TEXT);
      assert.deepEqual(pane.keysPressed, []);
      assert.deepEqual(pane.textsWritten, []);
    }
  }
  assert.deepEqual(logLines(), []);
});

test("the same dialog on a codex or an opencode pane named Regent gets no key", async (context) => {
  const logLines = recordedLogLines(context);
  for (const harness of [HARNESS_NAMES.CODEX, HARNESS_NAMES.OPENCODE]) {
    const agent = { ...regentAgent(), agent: harness };
    const pane = simulatedPane(agent, usageTabDialog, EMPTY_COMPOSER_SCREEN);

    await assert.rejects(
      submitToAgentWhileLocked(agent, "sender", "hello", SHORT_COMPOSER_WAIT, pane.deps),
      SubmitNotSentError,
    );
    assert.deepEqual(pane.keysPressed, []);
    assert.deepEqual(pane.textsWritten, []);
  }
  assert.deepEqual(logLines(), []);
});

test("a Regent pane mid-turn, with a permission prompt, or with a draft gets no key", async (context) => {
  const logLines = recordedLogLines(context);
  const agent = regentAgent();

  const midTurn = simulatedPane(
    agent,
    dialogHeaderQuotedAbove(await fixture("claude-live-fleet-busy-midtool-tool-running.ansi")),
  );
  await submitToAgentWhileLocked(agent, "sender", "hello", {}, midTurn.deps);
  assert.deepEqual(midTurn.keysPressed, []);
  assert.deepEqual(midTurn.textsWritten, ["sender said: hello"]);

  const permissionPrompt = simulatedPane(
    agent,
    dialogHeaderQuotedAbove(await fixture("claude-live-fleet-interactive-select-menu.ansi")),
  );
  await assert.rejects(
    submitToAgentWhileLocked(agent, "sender", "hello", SHORT_COMPOSER_WAIT, permissionPrompt.deps),
    SubmitNotSentError,
  );
  assert.deepEqual(permissionPrompt.keysPressed, []);
  assert.deepEqual(permissionPrompt.textsWritten, []);

  const draft = simulatedPane(
    agent,
    dialogHeaderQuotedAbove(await fixture("claude-live-fleet-resident-draft.ansi")),
  );
  await submitToAgentWhileLocked(agent, "sender", "hello", {}, draft.deps);
  assert.deepEqual(draft.keysPressed, []);
  assert.deepEqual(draft.textsWritten, ["sender said: hello"]);

  assert.deepEqual(logLines(), []);
});

test("a dialog that does not close stops after 2 presses and fails with the extended message", async (context) => {
  const logLines = recordedLogLines(context);
  for (const [index, dialog] of [usageTabDialog, statusTabDialog].entries()) {
    const agent = regentAgent();
    const pane = simulatedPane(agent, dialog);

    assert.equal(
      await failureTextOfUndeliveredMessage(agent, pane),
      `${TODAYS_FAILURE_TEXT}; the settings dialog was seen on the pane and Escape was pressed 2 times`,
    );
    assert.deepEqual(pane.keysPressed, ["Escape", "Escape"]);
    assert.deepEqual(pane.textsWritten, []);
    const pressLines = logLines().slice(index * 2);
    assert.equal(pressLines.length, 2);
    assert.match(pressLines[0]!, new RegExp(`^send-agent: .*${REGENT_NAME}.*press 1 `, "u"));
    assert.match(pressLines[1]!, new RegExp(`^send-agent: .*${REGENT_NAME}.*press 2 `, "u"));
  }
});

test("prose containing the five tab names does not match", async (context) => {
  const logLines = recordedLogLines(context);
  const agent = regentAgent();
  const screensWithoutComposer = [
    "The dialog has the tabs Settings  Status   Config   Usage   Stats in that order.",
    "Settings, Status, Config, Usage, Stats",
    "an ordinary line\n   Settings  Status   Config   Usage   Stats",
    `${"▔".repeat(40)}\n   Settings  Status   Config   Stats   Usage`,
    `${"▔".repeat(40)}\nOpen Settings  Status   Config   Usage   Stats`,
  ];
  for (const screen of screensWithoutComposer) {
    const pane = simulatedPane(agent, screen, EMPTY_COMPOSER_SCREEN);

    assert.equal(await failureTextOfUndeliveredMessage(agent, pane), TODAYS_FAILURE_TEXT);
    assert.deepEqual(pane.keysPressed, []);
    assert.deepEqual(pane.textsWritten, []);
  }
  assert.deepEqual(logLines(), []);
});
