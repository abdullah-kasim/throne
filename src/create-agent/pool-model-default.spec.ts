import assert from "node:assert/strict";
import test from "node:test";
import { prepareCreateAgentRequest } from "./request.ts";
import { baseDeps } from "./policy-test-fixtures.ts";
import { planRolePool } from "../config.ts";

async function run(args: string[]) {
  const stderr: string[] = [];
  const result = await prepareCreateAgentRequest(
    args,
    baseDeps({ writeStderr: (text) => stderr.push(text) }),
    "/tmp",
  );
  return { result, stderr: stderr.join("") };
}

test("a Shadow asked for with no model gets its pool's model", async () => {
  const poolFirst = planRolePool("Shadow", "AnthropicOnly")[0];
  const { result, stderr } = await run([
    "--role",
    "Shadow",
    "--name",
    "pooldefault-01-work",
    "--supervisor",
    "alpha-pooldefault-01",
  ]);
  assert.equal(result.ok, true, stderr);
  if (!result.ok) return;
  assert.equal(result.value.model, poolFirst?.model);
  assert.equal(result.value.harness, poolFirst?.harness);
  assert.match(stderr, /first model of the Shadow pool/);
});

test("a role with no pool asked for with no model is refused", async () => {
  const { result, stderr } = await run([
    "--role",
    "Agent",
    "--name",
    "nopool",
    "--supervisor",
    "Regent",
    "--bypass-preset-agent",
  ]);
  assert.deepEqual(result, { ok: false, code: 1 });
  assert.match(stderr, /--model is required for role "Agent"/);
});
