import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { fakeClaudeAgent, fakeVirtualClock } from "../herdr/herdr-send-test-fixtures.ts";
import type { SubmitToAgentDeps } from "../herdr/herdr-send.types.ts";
import {
  HARNESS_COMMAND_TYPING_OUTCOMES,
  sendHarnessCommandToThePiExtension,
} from "./harness-command-typing.ts";

const COLOUR_COMMAND = "/color green";
const RULE = "─".repeat(60);

function piScreen(composerText: string): string {
  return ["pi v1.5.2", "", RULE, composerText, `${"─".repeat(46)} night-baker ─`, "~/work (main)"].join("\n");
}

function piAgent(): HerdrAgent {
  return { ...fakeClaudeAgent(), agent: HARNESS_NAMES.PI };
}

function fakePiPane(startingText: string) {
  let screen = piScreen(startingText);
  const typed: string[] = [];
  const keys: string[] = [];
  const deps: Partial<SubmitToAgentDeps> = {
    ...fakeVirtualClock(),
    getPaneProcessInfo: async (paneId: string) => ({ paneId, foregroundProcesses: [{ name: "pi", argv: ["pi"] }] }),
    readVisibleAgentAnsi: async () => screen,
    refreshRecipientIdentity: async (_name: string, initial: HerdrAgent) => initial,
    withRecipientPaneLock: async <Result>(_paneId: string, action: () => Promise<Result>) => action(),
    sendText: async (_paneId: string, text: string) => {
      typed.push(text);
      screen = piScreen(text);
    },
    pressEnter: async () => {
      keys.push("Enter");
      screen = piScreen("");
    },
    pressPaneKey: async (_paneId: string, key: string) => {
      keys.push(key);
    },
    captureComposerDiagnostic: async () => undefined,
  };
  return { deps: deps as SubmitToAgentDeps, typed, keys };
}

async function socketNobodyAnswers(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "pi-no-commands-")), "delivery.sock");
}

test("the settings tick types the command into an idle empty pi pane when its extension takes no commands", async () => {
  const pane = fakePiPane("");
  const result = await sendHarnessCommandToThePiExtension(piAgent(), COLOUR_COMMAND, await socketNobodyAnswers(), pane.deps);
  assert.deepEqual(result, { outcome: HARNESS_COMMAND_TYPING_OUTCOMES.APPLIED });
  assert.deepEqual(pane.typed, [COLOUR_COMMAND]);
  assert.ok(pane.keys.includes("Enter"));
});

test("the settings tick types nothing into a pi pane holding a draft", async () => {
  const pane = fakePiPane("a sentence the human has not finished");
  const result = await sendHarnessCommandToThePiExtension(piAgent(), COLOUR_COMMAND, await socketNobodyAnswers(), pane.deps);
  assert.deepEqual(result, { outcome: HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_BUSY });
  assert.deepEqual(pane.typed, []);
  assert.deepEqual(pane.keys, []);
});
