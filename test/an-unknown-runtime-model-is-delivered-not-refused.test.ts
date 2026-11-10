import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkAgentRuntimeModelAcceptance } from "../src/session/runtime-model-acceptance.ts";
import {
  refuseTaskOnRuntimeModelMismatch,
  tellRegentOnceAboutUnknownModel,
} from "../src/send-agent/runtime-model-task-acceptance.ts";

const RECORDED_MODEL = "opus";
const UNKNOWN_MODEL = "claude-nimbus-9-1";

async function agentFixture(role: string, name: string, transcriptModels: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "unknown-runtime-model-"));
  const baseDir = path.join(root, "data");
  const projectsDir = path.join(root, "projects");
  const cwd = path.join(root, "work", name);
  await mkdir(path.join(baseDir, name), { recursive: true });
  await writeFile(path.join(baseDir, name, "identity.md"), `# ${name}\n\n- **Role:** ${role}\n`);
  await writeFile(
    path.join(baseDir, name, "spawn.json"),
    JSON.stringify({ harness: "claude", model: RECORDED_MODEL, effort: 1, cwd, spawned_at: "2026-11-10T00:00:00Z" }),
  );
  const projectDirectory = path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
  await mkdir(projectDirectory, { recursive: true });
  const record = (model: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", model } });
  await writeFile(path.join(projectDirectory, "session.jsonl"), `${transcriptModels.map(record).join("\n")}\n`);
  return { baseDir, projectsDir };
}

function captureStderr() {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => { process.stderr.write = original; } };
}

test("a seat whose transcript reports a different known model is still refused", async () => {
  const { baseDir, projectsDir } = await agentFixture("Alpha", "alpha-known", [RECORDED_MODEL, "claude-fable-5-2"]);
  const acceptance = await checkAgentRuntimeModelAcceptance("alpha-known", "task", baseDir, projectsDir);
  assert.equal(acceptance.ok, false);
  assert.equal(acceptance.outcome, "mismatch");
  const { restore } = captureStderr();
  try {
    assert.equal(await refuseTaskOnRuntimeModelMismatch("alpha-known", async () => acceptance), true);
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test("a seat whose transcript reports a model the registry does not know is delivered with a warning naming it", async () => {
  const { baseDir, projectsDir } = await agentFixture("Alpha", "alpha-unknown", [RECORDED_MODEL, UNKNOWN_MODEL]);
  const acceptance = await checkAgentRuntimeModelAcceptance("alpha-unknown", "task", baseDir, projectsDir);
  assert.equal(acceptance.ok, true);
  assert.equal(acceptance.outcome, "unknown-model");
  const { lines, restore } = captureStderr();
  const exitCodeBefore = process.exitCode;
  try {
    assert.equal(await refuseTaskOnRuntimeModelMismatch("alpha-unknown", async () => acceptance), false);
  } finally {
    restore();
  }
  assert.equal(process.exitCode, exitCodeBefore);
  assert.match(lines.join(""), new RegExp(`warning: "alpha-unknown" reports ${UNKNOWN_MODEL}, which the model registry does not know`));
});

test("the evidence of an unknown model is preserved", async () => {
  const { baseDir, projectsDir } = await agentFixture("Alpha", "alpha-evidence", [UNKNOWN_MODEL]);
  const acceptance = await checkAgentRuntimeModelAcceptance("alpha-evidence", "task", baseDir, projectsDir);
  assert.equal(acceptance.outcome, "unknown-model");
  if (acceptance.outcome !== "unknown-model") return;
  assert.equal(acceptance.evidencePath, path.join(baseDir, "alpha-evidence", "runtime-model-evidence", "task-quarantine.json"));
  const evidence = JSON.parse(await readFile(acceptance.evidencePath, "utf8"));
  assert.deepEqual(evidence.attestation.unknownModels, [UNKNOWN_MODEL]);
});

test("the Regent is told once per unknown model id, not once per message", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "unknown-model-notices-"));
  const regentMessages: string[] = [];
  const tellRegent = (modelId: string) =>
    tellRegentOnceAboutUnknownModel(modelId, async (prompt) => { regentMessages.push(prompt); }, baseDir);
  const acceptance = async () => ({
    ok: true as const,
    outcome: "unknown-model" as const,
    requestedModel: RECORDED_MODEL,
    unknownModels: [UNKNOWN_MODEL],
    evidencePath: "/x/task-quarantine.json",
  });
  const { restore } = captureStderr();
  try {
    for (let message = 0; message < 3; message += 1) {
      assert.equal(await refuseTaskOnRuntimeModelMismatch("alpha-unknown", acceptance, tellRegent), false);
    }
    await tellRegent("claude-nimbus-9-2");
  } finally {
    restore();
  }
  assert.equal(regentMessages.length, 2);
  assert.match(regentMessages[0], new RegExp(UNKNOWN_MODEL));
  assert.match(regentMessages[1], /claude-nimbus-9-2/);
});

test("a human-steered role is delivered as before whatever its model", async () => {
  for (const model of [UNKNOWN_MODEL, "claude-fable-5-2"]) {
    const { baseDir, projectsDir } = await agentFixture("Stager", "stager-probe", [RECORDED_MODEL, model]);
    const acceptance = await checkAgentRuntimeModelAcceptance("stager-probe", "task", baseDir, projectsDir);
    assert.equal(acceptance.ok, true);
    assert.equal(acceptance.outcome, "exempt-human-steered-role");
  }
});

test("a notice the Regent never received is sent again on the next message", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "unknown-model-notices-"));
  const regentMessages: string[] = [];
  await assert.rejects(
    tellRegentOnceAboutUnknownModel(UNKNOWN_MODEL, async () => { throw new Error("Regent unreachable"); }, baseDir),
  );
  await tellRegentOnceAboutUnknownModel(UNKNOWN_MODEL, async (prompt) => { regentMessages.push(prompt); }, baseDir);
  assert.equal(regentMessages.length, 1);
});
