import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BUILD_SKEW_ERROR_CODE,
  MODULE_LOAD_FAILURE_EXIT_CODE,
  runEntrypoint,
} from "./tools.ts";

test("source-path tooling invocation refuses with the compiled entrypoint instead of a retryable build-skew error", async () => {
  const originalArgv1 = process.argv[1];
  const output: string[] = [];
  process.argv[1] = fileURLToPath(import.meta.url).replace(
    /tools\.spec\.ts$/,
    "tools.ts",
  );

  try {
    const exitCode = await runEntrypoint({
      loadApplicationModule: () =>
        Promise.reject(new Error("compiled application is unavailable")),
      writeStderr: (text) => output.push(text),
    });

    assert.equal(exitCode, MODULE_LOAD_FAILURE_EXIT_CODE);
    assert.deepEqual(JSON.parse(output.join("")), {
      error: BUILD_SKEW_ERROR_CODE,
      retryable: false,
      message:
        "Source entrypoint invocation is unsupported; invoke dist/src/tools.js instead.",
    });
  } finally {
    process.argv[1] = originalArgv1;
  }
});
