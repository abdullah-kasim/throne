// Requirement: filing a queue objective is admitted for the Stager role and no
// other (AGENTS.md, "The Stager" -> "Only a Stager files queue objectives").
// The Lord caps what the court is allowed to be working on and sets that cap
// through the one role that talks to him; every other role reports findings
// and lets him decide. Before this gate existed the cap rested on prose, and
// it was breached within twelve minutes of being set.
//
// This is an integration test in the sense the court requires: it drives the
// real `run()` the command delegates to against a real SQLite queue store, and
// asserts on the STORE's contents — whether a row exists — rather than on the
// exit code alone. A refusal that still wrote the row would pass an
// exit-code-only assertion while defeating the entire point.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { run } from "../src/add-to-queue/add-to-queue-runtime.ts";
import { openRegentQueueStore } from "../src/regent-queue/regent-queue.store.ts";
import { IdentityLineReadStatus } from "../src/agentdata/identity-data.service.ts";

/** The repository an objective is filed FOR. --target-repo is mandatory
 *  since 2026-08-27, so every invocation must name it. */
const REPO_PATH = "/var/home/theuser/repos/example-target";

const scratchDirectories: string[] = [];

function scratchStorePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "throne-queue-filer-"));
  scratchDirectories.push(directory);
  return join(directory, "regent-queue.sqlite3");
}

after(() => {
  for (const directory of scratchDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const LAUNCH_DEFAULTS_ROOT = mkdtempSync(
  join(tmpdir(), "throne-queue-filer-repo-"),
);
scratchDirectories.push(LAUNCH_DEFAULTS_ROOT);

function depsFor(
  databasePath: string,
  caller: { name: string; role?: string },
): Parameters<typeof run>[1] {
  return {
    openStore: () => openRegentQueueStore(databasePath),
    currentAgentName: async () => caller.name,
    readRole: async () =>
      caller.role === undefined
        ? { status: IdentityLineReadStatus.FieldAbsent }
        : { status: IdentityLineReadStatus.Found, value: caller.role },
    resolveLaunchDefaults: (_repoPath: string) => ({
      targetRepo: join(LAUNCH_DEFAULTS_ROOT, "repo"),
      targetBranch: "main",
      baseCommit: "0".repeat(40),
    }),
    now: () => 1_700_000_000_000,
  };
}

function rowCount(databasePath: string): number {
  const store = openRegentQueueStore(databasePath);
  try {
    const read = store.readAll();
    if (read.state === "items") return read.items.length;
    if (read.state === "positively-empty") return 0;
    throw new Error(`queue read did not resolve: ${read.reason}`);
  } finally {
    store.close();
  }
}

test("add-to-queue admits a Stager and the row genuinely lands", async () => {
  const databasePath = scratchStorePath();
  const exitCode = await run(
    ["--target-repo", REPO_PATH, "--objective-code", "stg", "A Stager files this"],
    depsFor(databasePath, { name: "stager-test", role: "Stager" }),
  );

  assert.equal(exitCode, 0);
  assert.equal(rowCount(databasePath), 1);
});

for (const role of ["Alpha", "Shadow", "Regent"]) {
  test(`add-to-queue refuses a ${role} and writes no row`, async () => {
    const databasePath = scratchStorePath();
    const exitCode = await run(
      ["--target-repo", REPO_PATH, "--objective-code", "nop", `A ${role} tries to file`],
      depsFor(databasePath, { name: `${role.toLowerCase()}-test`, role }),
    );

    assert.equal(exitCode, 1);
    assert.equal(rowCount(databasePath), 0);
  });
}

test("add-to-queue fails closed when the caller's role cannot be read", async () => {
  const databasePath = scratchStorePath();
  const exitCode = await run(
    ["--objective-code", "unk", "An unidentifiable caller tries to file"],
    depsFor(databasePath, { name: "mystery" }),
  );

  assert.equal(exitCode, 1);
  assert.equal(rowCount(databasePath), 0);
});

test("add-to-queue fails closed when the calling agent cannot be resolved at all", async () => {
  const databasePath = scratchStorePath();
  const deps = depsFor(databasePath, { name: "unused", role: "Stager" });
  const exitCode = await run(["--target-repo", REPO_PATH, "--objective-code", "err", "Resolution throws"], {
    ...deps,
    currentAgentName: async () => {
      throw new Error("no herdr session");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(rowCount(databasePath), 0);
});
