// The 2026-08-25 renumber (Lord's direct order) inserted a conformance gate at
// `99a` and pushed verify to `99b` and delivery to `99c`. That makes the bare
// letter `99b` mean two different roles depending on when the bundle was
// authored, so classification moved onto the slice's ROLE WORD. These tests pin
// exactly that: the same letter, two generations, two correct answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTerminalDeliveryShadowName,
  isTerminalGateShadowName,
  terminalGateRoleFromShadowName,
} from "../src/merge-git-tree/terminal-gate-shadow.ts";

test("the three-gate chain classifies conform, verify and deliver by role word", () => {
  assert.equal(
    terminalGateRoleFromShadowName("shadow-abc-99a-conform-widgets"),
    "verdict",
  );
  assert.equal(
    terminalGateRoleFromShadowName("shadow-abc-99b-verify-widgets"),
    "verdict",
  );
  assert.equal(
    terminalGateRoleFromShadowName("shadow-abc-99c-deliver-widgets"),
    "delivery",
  );
});

test("a post-renumber 99b verify gate is NOT the delivery gate", () => {
  // Under the bare-letter rule this returned "delivery", which would subject a
  // legitimately empty verify diff to the delivery precondition and refuse it.
  assert.equal(isTerminalDeliveryShadowName("shadow-abc-99b-verify-widgets"), false);
  assert.equal(isTerminalGateShadowName("shadow-abc-99b-verify-widgets"), true);
});

test("pre-renumber delivery gates keep their authored meaning", () => {
  // Two-gate chain: delivery was 99b. Five-gate chain: delivery was 99e.
  assert.equal(isTerminalDeliveryShadowName("shadow-abc-99b-deliver-widgets"), true);
  assert.equal(isTerminalDeliveryShadowName("shadow-hdl-99e-deliver-hdl"), true);
  // Bare, role-word-free legacy names fall back to the letter table.
  assert.equal(isTerminalDeliveryShadowName("shadow-abc-99b"), true);
  assert.equal(isTerminalDeliveryShadowName("shadow-abc-99e"), true);
  // Pre-renumber non-delivery gates stay verdict-shaped.
  assert.equal(terminalGateRoleFromShadowName("shadow-abc-99c"), "verdict");
  assert.equal(terminalGateRoleFromShadowName("shadow-abc-99d-validate"), "verdict");
});

test("underscored slice ids classify the same as hyphenated ones", () => {
  assert.equal(
    terminalGateRoleFromShadowName("shadow-abc-99c_deliver_widgets"),
    "delivery",
  );
  assert.equal(
    terminalGateRoleFromShadowName("shadow-abc-99a_conform_widgets"),
    "verdict",
  );
});

test("non-gate and malformed names are not terminal gates at all", () => {
  assert.equal(terminalGateRoleFromShadowName("shadow-abc-01-build"), undefined);
  assert.equal(terminalGateRoleFromShadowName("alpha-abc-99c-deliver"), undefined);
  assert.equal(terminalGateRoleFromShadowName("shadow-abc-99az"), undefined);
});
