import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkAgentRuntimeModelAcceptance } from "../src/session/runtime-model-acceptance.ts";

const RECORDED_MODEL = "opus";
const STEERED_MODEL = "claude-fable-5-1";

async function agentFixture(role: string, name: string) {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-model-gate-"));
  const baseDir = path.join(root, "data");
  const projectsDir = path.join(root, "projects");
  const cwd = path.join(root, "work", name);
  await mkdir(path.join(baseDir, name), { recursive: true });
  await writeFile(
    path.join(baseDir, name, "identity.md"),
    `# ${name}\n\n- **Role:** ${role}\n`,
  );
  await writeFile(
    path.join(baseDir, name, "spawn.json"),
    JSON.stringify({ harness: "claude", model: RECORDED_MODEL, effort: 1, cwd, spawned_at: "2026-09-07T00:00:00Z" }),
  );
  const projectDirectory = path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
  await mkdir(projectDirectory, { recursive: true });
  const record = (model: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", model } });
  await writeFile(
    path.join(projectDirectory, "session.jsonl"),
    `${record(RECORDED_MODEL)}\n${record(STEERED_MODEL)}\n`,
  );
  return { baseDir, projectsDir, evidenceDir: path.join(baseDir, name, "runtime-model-evidence") };
}

for (const [role, name] of [["Stager", "stager-probe"], ["Regent", "regent-probe"]] as const) {
  test(`${role} steered onto another model is exempt, evidence still written`, async () => {
    const { baseDir, projectsDir, evidenceDir } = await agentFixture(role, name);
    const acceptance = await checkAgentRuntimeModelAcceptance(name, "task", baseDir, projectsDir);
    assert.equal(acceptance.ok, true);
    assert.equal(acceptance.outcome, "exempt-human-steered-role");
    if (acceptance.outcome !== "exempt-human-steered-role") return;
    assert.equal(acceptance.role, role);
    assert.ok(acceptance.observedModels.includes(STEERED_MODEL));
    assert.equal(acceptance.evidencePath, path.join(evidenceDir, "task-exempt.json"));
    const evidence = JSON.parse(await readFile(acceptance.evidencePath, "utf8"));
    assert.equal(evidence.exemptRole, role);
    assert.equal(evidence.attestation.status, "mismatch");
  });
}

test("the literal agent name regent is exempt even without an identity role", async () => {
  const { baseDir, projectsDir } = await agentFixture("Alpha", "regent");
  const acceptance = await checkAgentRuntimeModelAcceptance("regent", "task", baseDir, projectsDir);
  assert.equal(acceptance.outcome, "exempt-human-steered-role");
});

test("an Alpha on the wrong model is still quarantined", async () => {
  const { baseDir, projectsDir, evidenceDir } = await agentFixture("Alpha", "alpha-probe");
  const acceptance = await checkAgentRuntimeModelAcceptance("alpha-probe", "task", baseDir, projectsDir);
  assert.equal(acceptance.ok, false);
  assert.equal(acceptance.outcome, "mismatch");
  assert.equal(acceptance.evidencePath, path.join(evidenceDir, "task-quarantine.json"));
});
