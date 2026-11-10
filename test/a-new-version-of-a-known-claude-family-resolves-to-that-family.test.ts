import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_NAMES, resolveModel } from "../src/harness-routing/harness.ts";
import {
  MODEL_REGISTRY,
  registryEntry,
  resolveRegistryModel,
} from "../src/harness-routing/model-registry.ts";
import { resolveModelAlias } from "../src/harness-routing/registry-derivation.ts";
import { attestClaudeRuntimeModel } from "../src/session/claude-runtime-model-attestation.ts";

function familyByEveryLookup(modelId: string): (string | undefined)[] {
  return [
    resolveModel("claude", modelId),
    resolveRegistryModel(modelId).model,
    registryEntry(modelId)?.model,
    resolveModelAlias(MODEL_REGISTRY, "claude", modelId.toLowerCase()),
  ];
}

const laterVersions: [string, string][] = [
  [MODEL_NAMES.FABLE, "fable"],
  [MODEL_NAMES.OPUS, "opus"],
  [MODEL_NAMES.SONNET, "sonnet"],
  [MODEL_NAMES.HAIKU, "haiku"],
];

test("a new version of a known Claude family resolves to that family", () => {
  for (const modelId of ["claude-fable-5-2", "fable-5.2", "fable-5-2", " Claude-Fable-5-2 "]) {
    assert.deepEqual(familyByEveryLookup(modelId), Array(4).fill(MODEL_NAMES.FABLE), modelId);
  }
  for (const [family, word] of laterVersions) {
    for (const modelId of [`claude-${word}-9-7`, `${word}-9.7`, `${word}-9-7`]) {
      assert.deepEqual(familyByEveryLookup(modelId), Array(4).fill(family), modelId);
    }
  }
});

test("a dated Claude model id resolves to its family", () => {
  assert.deepEqual(familyByEveryLookup("claude-fable-5-2-20261101"), Array(4).fill(MODEL_NAMES.FABLE));
  assert.deepEqual(familyByEveryLookup("claude-sonnet-6-1-20270203"), Array(4).fill(MODEL_NAMES.SONNET));
});

test("a Claude model id of an unknown family still does not resolve", () => {
  for (const modelId of ["claude-lyric-5-2", "lyric-5.2", "claude-fable-5-2-2026", "fable-5.2-20261101", "gpt-5-5"]) {
    assert.throws(() => resolveModel("claude", modelId), modelId);
    assert.throws(() => resolveRegistryModel(modelId), modelId);
    assert.equal(registryEntry(modelId), undefined, modelId);
    assert.equal(resolveModelAlias(MODEL_REGISTRY, "claude", modelId), undefined, modelId);
  }
});

test("a Claude family version is not resolved under a non-Claude harness", () => {
  assert.equal(resolveModelAlias(MODEL_REGISTRY, "omp", "claude-fable-5-2"), undefined);
});

test("a seat requested as fable whose transcript reports a new fable version is accepted by the runtime model check", () => {
  const transcript = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-fable-5-2" },
  });
  const attestation = attestClaudeRuntimeModel("fable", transcript, "test-transcript");
  assert.equal(attestation.status, "matching");
  assert.deepEqual(attestation.observedModels, [MODEL_NAMES.FABLE]);
});
