import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { LAUNCH_READY_BODY, REAL_SPEC_ID, makeSpecCitationFixture } from "../lint-queue-plan/spec-citation.test-support.ts";
import { run } from "./add-to-queue-runtime.ts";

const fixture = await makeSpecCitationFixture();
after(() => fixture.remove());

async function fileRow(objectiveCode: string, targetRepo: string, body: string) {
  const queueFile = path.join(fixture.scratch, `${objectiveCode}.sqlite3`);
  const errors: string[] = [];
  const writeError = process.stderr.write.bind(process.stderr);
  const writeOutput = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const exitCode = await run([
      "--objective-code", objectiveCode,
      "--base-commit", "fedcba9876543210fedcba9876543210fedcba98",
      "--target-branch", "main",
      "--target-repo", targetRepo,
      "--alpha-name", `alpha-${objectiveCode}-01`,
      body,
    ], {
      openStore: () => openRegentQueueStore(queueFile),
      currentAgentName: async () => "stager-citation",
      readRole: async () => ({ status: IdentityLineReadStatus.Found, value: "Stager" }),
      resolveLaunchDefaults: () => {
        throw new Error("every launch fact was given");
      },
      now: () => 1_800_000_000_000,
    });
    const store = openRegentQueueStore(queueFile);
    try {
      return { exitCode, errors: errors.join(""), filed: findQueueItemByObjectiveCode(store, objectiveCode) !== undefined };
    } finally {
      store.close();
    }
  } finally {
    process.stderr.write = writeError;
    process.stdout.write = writeOutput;
  }
}

test("a body naming a real sub-feature ID of the target's spec is filed", async () => {
  const result = await fileRow("cites", fixture.specRepository, `${LAUNCH_READY_BODY}\nREUSE: specs/greeting/greeter.md (${REAL_SPEC_ID}) — says hello.`);
  assert.deepEqual([result.exitCode, result.filed, result.errors], [0, true, ""]);
});

test("a body naming no sub-feature ID of the target's spec is refused, nothing is written, and the refusal names the spec path and the escape line", async () => {
  const result = await fileRow("uncited", fixture.specRepository, `${LAUNCH_READY_BODY}\nREUSE: none found.`);
  assert.equal(result.exitCode, 1);
  assert.equal(result.filed, false);
  assert.ok(result.errors.includes(path.join(fixture.specRepository, "specs")), result.errors);
  assert.match(result.errors, /SPECS: none applies/);
  assert.match(result.errors, /throne spec-location/);
  assert.match(result.errors, /Nothing was added to the queue/);
});

test("a body with SPECS: none applies and a reason is filed", async () => {
  const result = await fileRow("escape", fixture.specRepository, `${LAUNCH_READY_BODY}\nSPECS: none applies — this only renames a build script.`);
  assert.deepEqual([result.exitCode, result.filed], [0, true]);
});

test("a SPECS: none applies line without a reason does not count", async () => {
  const result = await fileRow("bareescape", fixture.specRepository, `${LAUNCH_READY_BODY}\nSPECS: none applies`);
  assert.deepEqual([result.exitCode, result.filed], [1, false]);
});

test("an ID that exists in no spec file does not count as a citation", async () => {
  const result = await fileRow("madeup", fixture.specRepository, `${LAUNCH_READY_BODY}\nREUSE: specs/greeting/greeter.md (GREET-WAVE) — waves.`);
  assert.deepEqual([result.exitCode, result.filed], [1, false]);
});

test("a target with no spec is filed as today", async () => {
  const result = await fileRow("nospec", fixture.plainRepository, LAUNCH_READY_BODY);
  assert.deepEqual([result.exitCode, result.filed, result.errors], [0, true, ""]);
});

test("a spec folder that cannot be read files the row and prints one line", async () => {
  const result = await fileRow("broken", fixture.brokenSpecRepository, LAUNCH_READY_BODY);
  assert.deepEqual([result.exitCode, result.filed], [0, true]);
  assert.equal(result.errors.trim().split("\n").length, 1, result.errors);
  assert.match(result.errors, /spec citation check was skipped/);
});
