import assert from "node:assert/strict";
import test from "node:test";
import { prepareCreateAgentRequest } from "./request.ts";
import { baseDeps } from "./policy-test-fixtures.ts";

const AUTHORIZATION_REFUSAL =
  "needs the Lord's explicit authorization for this invocation";

function oneShotArgs(extra: string[] = []): string[] {
  return [
    "--model",
    "sonnet",
    "--name",
    "one-shot-authorization-cell",
    "--supervisor",
    "stager-test",
    "--role",
    "Agent",
    "--cwd",
    "/tmp",
    "--non-campaign",
    "--bypass-preset-agent",
    "--harness-executable",
    "/bin/sh",
    "--run-custom-harness-to-exit",
    "--clear-environment",
    "--env",
    "HOME=/tmp",
    "--stdout-path",
    "/tmp/out",
    "--stderr-path",
    "/tmp/err",
    "--exit-status-path",
    "/tmp/rc",
    "--wall-time-path",
    "/tmp/wall",
    "--launcher-evidence-path",
    "/tmp/launcher.json",
    "--timeout-ms",
    "1000",
    ...extra,
    "--",
    "-c",
    "true",
  ];
}

async function run(args: string[]) {
  const stderr: string[] = [];
  const result = await prepareCreateAgentRequest(
    args,
    baseDeps({ writeStderr: (text) => stderr.push(text) }),
    "/tmp",
  );
  return { result, stderr: stderr.join("") };
}

test("a one-shot cell without the Lord's bypass is refused before anything launches", async () => {
  const { result, stderr } = await run(oneShotArgs());
  assert.equal(result.ok, false);
  assert.match(stderr, new RegExp(AUTHORIZATION_REFUSAL));
  assert.match(stderr, /--bypass-run-custom-harness-to-exit/);
  assert.match(stderr, /Nothing was launched/);
});

test("the bypass flag admits the one-shot cell past the authorization gate", async () => {
  const { stderr } = await run(
    oneShotArgs(["--bypass-run-custom-harness-to-exit"]),
  );
  assert.doesNotMatch(stderr, new RegExp(AUTHORIZATION_REFUSAL));
});

test("the bypass flag alone is refused as a one-shot-only flag", async () => {
  const { result, stderr } = await run([
    "--model",
    "sonnet",
    "--name",
    "resident-with-stray-bypass",
    "--supervisor",
    "stager-test",
    "--role",
    "Agent",
    "--cwd",
    "/tmp",
    "--non-campaign",
    "--bypass-run-custom-harness-to-exit",
  ]);
  assert.equal(result.ok, false);
  assert.match(
    stderr,
    /--bypass-run-custom-harness-to-exit require --run-custom-harness-to-exit/,
  );
});
