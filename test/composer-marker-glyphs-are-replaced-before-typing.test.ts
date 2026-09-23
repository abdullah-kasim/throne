import assert from "node:assert/strict";
import { test } from "node:test";
import { submittedPayload } from "../src/herdr/herdr-send.helpers.ts";
import { inspectSupportedAgentScreen } from "../src/codex-screen/composer/composer.service.ts";

const blockedPage = [
  "shadow-publishread-99b-verify is held up by an interactive prompt in its pane.",
  "Prompt (claude permission): Do you want to proceed?",
  "Options (option 1 is selected):",
  "❯ 1. Yes",
  "  2. No",
  "Clear it with: throne mcq --agent shadow-publishread-99b-verify --answer <n>",
].join("\n");

test("a line-start selected-option glyph is typed as a plain greater-than sign", () => {
  const typed = submittedPayload("blocked-paging", blockedPage, { messageId: 3759 });
  assert.match(typed, /^> 1\. Yes$/mu);
  assert.doesNotMatch(typed, /^\s*[❯›┃╰]/mu);
});

test("every harness composer glyph at a line start is replaced, keeping its indentation", () => {
  const typed = submittedPayload("", "a\n❯ one\n  › two\n┃ three\n╰ four", { omitSenderAttribution: true });
  assert.equal(typed, "a\n> one\n  > two\n> three\n> four");
});

test("a composer glyph in the middle of a line is left alone", () => {
  assert.equal(submittedPayload("", "press ❯ then › here", {}), "press ❯ then › here");
});

test("a Claude pane holding the rewritten page reads as a resident draft", () => {
  const typed = submittedPayload("alpha", blockedPage, {});
  const lines = typed.split("\n");
  const rule = "─".repeat(60);
  const frame = [
    rule,
    `❯ ${lines[0]}`,
    ...lines.slice(1).map((line) => `  ${line}`),
    rule,
    "\u001b[2m  Opus · ~/throne\u001b[22m",
  ].join("\n");
  const composer = inspectSupportedAgentScreen("claude", frame).activeComposer;
  assert.equal(composer.state, "draft");
});

test("the same page with the original glyph is unreadable, which is the defect", () => {
  const lines = `alpha said: ${blockedPage}`.split("\n");
  const rule = "─".repeat(60);
  const frame = [
    rule,
    `❯ ${lines[0]}`,
    ...lines.slice(1).map((line) => `  ${line}`),
    rule,
    "\u001b[2m  Opus · ~/throne\u001b[22m",
  ].join("\n");
  assert.equal(inspectSupportedAgentScreen("claude", frame).activeComposer.state, "unavailable");
});
