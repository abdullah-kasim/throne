import assert from "node:assert/strict";
import test from "node:test";
import { prepareCreateAgentRequest } from "./request.ts";
import { baseDeps } from "./policy-test-fixtures.ts";
import { createAgentIdentity } from "./agent-record.ts";
import { identityText, SHADOWLESS_STANDING_INSTRUCTION } from "../agentdata/identity-data.service.ts";

async function run(args: string[]) {
  const stderr: string[] = [];
  const result = await prepareCreateAgentRequest(
    args,
    baseDeps({ writeStderr: (text) => stderr.push(text) }),
    "/tmp",
  );
  return { result, stderr: stderr.join("") };
}

test("--shadowless is refused for any role but Alpha and names where the authorization comes from", async () => {
  const { result, stderr } = await run([
    "--model",
    "sonnet",
    "--name",
    "shadow-shl-01",
    "--supervisor",
    "alpha-shl-01",
    "--role",
    "Shadow",
    "--cwd",
    "/tmp",
    "--non-campaign",
    "--shadowless",
  ]);
  assert.equal(result.ok, false);
  assert.match(stderr, /--shadowless is refused for role "Shadow"/);
  assert.match(stderr, /add-to-queue --shadowless/);
});

test("--shadowless on an Alpha is carried on the request and into the identity text", async () => {
  const { result, stderr } = await run([
    "--model",
    "sonnet",
    "--name",
    "alpha-shl-01",
    "--supervisor",
    "Regent",
    "--role",
    "Alpha",
    "--cwd",
    "/tmp",
    "--non-campaign",
    "--shadowless",
  ]);
  assert.doesNotMatch(stderr, /--shadowless is refused/);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.shadowless, true);
  const identity = createAgentIdentity(result.value as never, "Regent");
  assert.equal(identity.shadowless, true);
  const text = identityText("alpha-shl-01", identity);
  assert.ok(text.includes(SHADOWLESS_STANDING_INSTRUCTION));
});
