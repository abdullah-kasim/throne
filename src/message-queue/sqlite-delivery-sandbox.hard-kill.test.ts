import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SANDBOX_HARD_KILL_EXIT_CODE } from "./sqlite-delivery-sandbox.ts";

const fixturePath = fileURLToPath(
  new URL("./sqlite-delivery-sandbox.hard-kill-fixture.ts", import.meta.url),
);
const typescriptRegisterPath = fileURLToPath(
  new URL("../../test/register-typescript.mjs", import.meta.url),
);

test("a delivery that hangs is killed instead of wedging the queue", async () => {
  const child = spawn(process.execPath, ["--import", typescriptRegisterPath, fixturePath], {
    env: { ...process.env, THRONE_TEST_HARD_KILL_TTL_MS: "100" },
  });
  const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

  assert.equal(signal, null);
  assert.equal(exitCode, SANDBOX_HARD_KILL_EXIT_CODE);
});
