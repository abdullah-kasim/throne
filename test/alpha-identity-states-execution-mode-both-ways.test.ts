import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  type AgentIdentity,
  identityText,
  SHADOWED_LINE,
  SHADOWED_STANDING_INSTRUCTION,
  SHADOWLESS_LINE,
  SHADOWLESS_STANDING_INSTRUCTION,
  writeIdentity,
} from "../src/agentdata/identity-data.service.ts";

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function writtenIdentity(name: string, identity: AgentIdentity): Promise<string> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "identity-mode-"));
  scratch.push(baseDir);
  await writeIdentity(name, identity, baseDir);
  return readFile(path.join(baseDir, name, "identity.md"), "utf8");
}

const alpha: AgentIdentity = { supervisor: "Regent", escalation: "Regent", role: "Alpha", objectiveCode: "abc" };

test("an Alpha filed without --shadowless is told, in its header and its standing instruction, that it is shadowed", async () => {
  const text = identityText("alpha-abc-01", alpha);
  assert.ok(text.includes(SHADOWED_STANDING_INSTRUCTION));
  assert.ok(!text.includes(SHADOWLESS_STANDING_INSTRUCTION));
  const file = await writtenIdentity("alpha-abc-01", alpha);
  assert.ok(file.includes(SHADOWED_LINE));
  assert.ok(!file.includes(SHADOWLESS_LINE));
});

test("an Alpha filed with --shadowless keeps the shadowless line and instruction and gets no shadowed ones", async () => {
  const shadowless: AgentIdentity = { ...alpha, shadowless: true };
  const text = identityText("alpha-abc-02", shadowless);
  assert.ok(text.includes(SHADOWLESS_STANDING_INSTRUCTION));
  assert.ok(!text.includes(SHADOWED_STANDING_INSTRUCTION));
  const file = await writtenIdentity("alpha-abc-02", shadowless);
  assert.ok(file.includes(SHADOWLESS_LINE));
  assert.ok(!file.includes(SHADOWED_LINE));
});

test("a differently cased role still reads as an Alpha for the mode line", async () => {
  const file = await writtenIdentity("alpha-abc-03", { ...alpha, role: "alpha" });
  assert.ok(file.includes(SHADOWED_LINE));
});

test("Shadows and Stagers carry no execution-mode line or instruction", async () => {
  for (const role of ["Shadow", "Stager", "Regent"]) {
    const identity: AgentIdentity = { supervisor: "Regent", escalation: "Regent", role };
    const text = identityText(`${role.toLowerCase()}-x`, identity);
    assert.ok(!text.includes(SHADOWED_STANDING_INSTRUCTION), role);
    assert.ok(!text.includes(SHADOWLESS_STANDING_INSTRUCTION), role);
    const file = await writtenIdentity(`${role.toLowerCase()}-x`, identity);
    assert.ok(!file.includes("**Execution mode:**"), role);
  }
});
