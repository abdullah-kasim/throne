import { test } from "node:test";
import assert from "node:assert/strict";
import { stateFromTurnEndMessage } from "../src/my-state/turn-end-marker.ts";

test("only a blocked marker that ends the turn message declares a wait, so a woken turn quoting its earlier marker stays working", () => {
  const woken = [
    "Summary:",
    ' - Idle message published as {"blocked":true} BLOCKED_BY_own-background-run (sleep run).',
    " - RUN-FINISHED arrived, sent the resume report once.",
  ].join("\n");
  assert.equal(stateFromTurnEndMessage(woken), null);
  assert.equal(stateFromTurnEndMessage('done {"blocked":true} BLOCKED_BY_own-background-run (suite)')?.state, "waiting-on-own-run");
  assert.deepEqual(stateFromTurnEndMessage('waiting\n{"blocked":true} __BLOCKED_BY_shadow-a__ __BLOCKED_BY_shadow-b__')?.blockedBy, ["shadow-a", "shadow-b"]);
});

test("a blocked marker that ends the turn message still declares a wait when wrapped in backticks, closed by a full stop, or describing its run with brackets", () => {
  assert.equal(stateFromTurnEndMessage('done.\n`{"blocked":true}` BLOCKED_BY_own-background-run (suite)')?.state, "waiting-on-own-run");
  assert.equal(stateFromTurnEndMessage('done.\n{"blocked":true} BLOCKED_BY_own-background-run (suite).')?.state, "waiting-on-own-run");
  assert.equal(stateFromTurnEndMessage('done {"blocked":true} BLOCKED_BY_own-background-run (suite (full))')?.state, "waiting-on-own-run");
});
