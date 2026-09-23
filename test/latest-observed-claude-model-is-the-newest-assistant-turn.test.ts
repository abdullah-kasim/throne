import assert from "node:assert/strict";
import { test } from "node:test";
import { latestObservedClaudeModel } from "../src/session/claude-runtime-model-attestation.ts";

function assistantTurn(model: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", model } });
}

test("the newest assistant turn decides the observed model, not the majority", () => {
  const transcript = [
    assistantTurn("claude-opus-5"),
    assistantTurn("claude-opus-5"),
    JSON.stringify({ type: "user", message: { role: "user" } }),
    assistantTurn("claude-fable-5-1"),
  ].join("\n");
  assert.equal(latestObservedClaudeModel(transcript), "fable");
});

test("placeholder model ids and non-assistant records are ignored", () => {
  const transcript = [assistantTurn("claude-opus-5"), assistantTurn("<synthetic>")].join("\n");
  assert.equal(latestObservedClaudeModel(transcript), "opus");
  assert.equal(latestObservedClaudeModel(""), undefined);
});
