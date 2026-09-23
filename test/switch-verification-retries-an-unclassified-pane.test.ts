import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientVerificationReadiness } from "../src/switch-agent-model/transaction/recipe-verification.ts";

test("a pane whose status is not yet classified is retried, not failed", () => {
  assert.equal(
    isTransientVerificationReadiness({
      outcome: "refused",
      code: "status-rejects-input",
      reason: 'recipient "stager-fifth" is unknown and does not accept input',
    }),
    true,
  );
});

test("a recipient that is genuinely busy is a real refusal, never retried", () => {
  for (const status of ["working", "blocked"]) {
    assert.equal(
      isTransientVerificationReadiness({
        outcome: "refused",
        code: "status-rejects-input",
        reason: `recipient "stager-eighth" is ${status} and does not accept input`,
      }),
      false,
      status,
    );
  }
});

test("a cwd mismatch stays a real refusal", () => {
  assert.equal(
    isTransientVerificationReadiness({
      outcome: "refused",
      code: "cwd-mismatch",
      reason: 'running cwd "/tmp/example-checkout" is not the registered cwd "/x"',
    }),
    false,
  );
});
