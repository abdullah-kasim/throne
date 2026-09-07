import assert from "node:assert/strict";
import { test } from "node:test";

import { refuseTaskOnRuntimeModelMismatch } from "../src/send-agent/runtime-model-task-acceptance.ts";

function captureStderr() {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => { process.stderr.write = original; } };
}

test("an exempt Stager steered onto another model is delivered to, with a notice", async () => {
  const { lines, restore } = captureStderr();
  const exitCodeBefore = process.exitCode;
  try {
    const refused = await refuseTaskOnRuntimeModelMismatch("stager-second", async () => ({
      ok: true,
      outcome: "exempt-human-steered-role",
      role: "Stager",
      recordedModel: "opus",
      observedModels: ["opus", "claude-fable-5-1"],
      evidencePath: "/x/task-exempt.json",
    }));
    assert.equal(refused, false);
    assert.equal(process.exitCode, exitCodeBefore);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"stager-second" is a Stager observed on opus, claude-fable-5-1 \(recorded opus\)/);
    assert.match(lines[0], /delivering anyway; evidence at \/x\/task-exempt\.json/);
  } finally {
    restore();
  }
});

test("an exempt role still on its recorded model gets no notice", async () => {
  const { lines, restore } = captureStderr();
  try {
    const refused = await refuseTaskOnRuntimeModelMismatch("stager-second", async () => ({
      ok: true,
      outcome: "exempt-human-steered-role",
      role: "Stager",
      recordedModel: "opus",
      observedModels: ["opus"],
      evidencePath: "/x/task-exempt.json",
    }));
    assert.equal(refused, false);
    assert.deepEqual(lines, []);
  } finally {
    restore();
  }
});

test("a mismatched campaign role is still refused", async () => {
  const { lines, restore } = captureStderr();
  try {
    const refused = await refuseTaskOnRuntimeModelMismatch("alpha-x", async () => ({
      ok: false,
      outcome: "mismatch",
      detail: "observed claude-fable-5-1 instead of requested opus",
      evidencePath: "/x/task-quarantine.json",
    }));
    assert.equal(refused, true);
    assert.match(lines[0], /refusing task acceptance/);
  } finally {
    restore();
    process.exitCode = undefined;
  }
});
