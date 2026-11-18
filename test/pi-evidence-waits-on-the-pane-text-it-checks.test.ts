import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentWithoutTheLiveCourt, pollUntil, skippedLineReason } from "../scripts/pi-evidence/support.mjs";
import { toolTaskShown } from "../scripts/pi-evidence/lines/launch.mjs";
import { answeredWith, lines as runtimeLines, nativeShadowsVerdict } from "../scripts/pi-evidence/lines/runtime.mjs";

test("P1.1 does not count the task finished when the third provider request came but the command has not rendered", () => {
  assert.equal(toolTaskShown("pi is working\n", 3), false);
  assert.equal(toolTaskShown("$ cat stand-in-edit.txt\nwritten by the pi provider stand-in\n", 3), true);
  assert.equal(toolTaskShown("$ cat stand-in-edit.txt\n", 2), false);
});

test("waiting on pane text sees text that renders after the old fixed pause would have read", async () => {
  const started = Date.now();
  const read = async () => (Date.now() - started > 1_600 ? "$ cat stand-in-edit.txt" : "");
  const polled = await pollUntil(read, (text) => text.includes("$ cat"), 5_000, 100);
  assert.equal(polled.found, true);
});

test("waiting on pane text gives up at its deadline instead of hanging", async () => {
  const started = Date.now();
  const polled = await pollUntil(async () => "", (text) => text !== "", 500, 100);
  assert.equal(polled.found, false);
  assert.ok(Date.now() - started < 1_500);
});

test("P7.2 launches real Claude and Codex Shadows only when asked with --real-harnesses", () => {
  const line = runtimeLines.find((candidate) => candidate.id === "P7.2");
  assert.match(skippedLineReason(line, { realProvider: true, realHarnesses: false }) ?? "", /--real-harnesses/);
  assert.equal(skippedLineReason(line, { realProvider: false, realHarnesses: true }), null);
});

test("P7.2 counts a Shadow as answered only when the word shows beyond the message that asked for it", () => {
  assert.equal(answeredWith("> reply with only the word PONG42\n", "PONG42"), false);
  assert.equal(answeredWith("> reply with only the word PONG42\n● PONG42\n", "PONG42"), true);
});

test("P7.2 is NOT VERIFIED, never PASS, when a harness is not signed in on the host, and FAIL when a signed-in one does not answer", () => {
  const claude = { createCode: 0, paneFound: true, openingAnswered: true, sendCode: 0, answered: true, signInShown: false };
  const codexSignedOut = { createCode: 0, paneFound: true, openingAnswered: false, sendCode: 1, answered: false, signInShown: true };
  const codexSilent = { ...codexSignedOut, signInShown: false };
  assert.equal(nativeShadowsVerdict([claude, claude]), "PASS");
  assert.equal(nativeShadowsVerdict([claude, codexSignedOut]), "NOT VERIFIED");
  assert.equal(nativeShadowsVerdict([claude, codexSilent]), "FAIL");
});

test("isolated evidence commands carry none of the live court's herdr or agent variables", () => {
  const cleaned = environmentWithoutTheLiveCourt({ HERDR_SESSION: "throne", HERDR_PANE_ID: "w1:pEVIDENCE", THRONE_AGENT_NAME: "me", THRONE_DATA_HOME: "/x", PATH: "/bin" });
  assert.deepEqual(cleaned, { THRONE_DATA_HOME: "/x", PATH: "/bin" });
});
