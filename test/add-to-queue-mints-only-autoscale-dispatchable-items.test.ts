// Requirement: `add-to-queue` MUST add items that are DEFINITELY eligible for
// the autoscaler to dispatch. Adding to the queue and being dispatchable are
// one fact, not two states an operator reconciles by hand.
//
// This is an integration test in the sense the court requires: it drives the
// real `run()` that the command delegates to, against the real SQLite queue
// store, and then asks the REAL autoscale dispatch classifier
// (`classifyEffectiveQueueDecision`) and the REAL ready-queue reader whether
// the resulting row is dispatchable. Nothing about eligibility is asserted by
// restating what the writer wrote.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { run, resolveLaunchMetadata } from "../src/add-to-queue/add-to-queue-runtime.ts";
import { IdentityLineReadStatus } from "../src/agentdata/identity-data.service.ts";
import { openRegentQueueStore } from "../src/regent-queue/regent-queue.store.ts";
import { classifyEffectiveQueueDecision } from "../src/regent-queue/regent-queue-dispatch.ts";
import { parseAddToQueueArgs } from "../src/add-to-queue/add-to-queue-runtime.ts";

/** The repository an objective is filed FOR. --target-repo is mandatory
 *  since 2026-08-27, so every invocation must name it. */
const REPO_PATH = "/var/home/theuser/repos/example-target";

const scratchDirectories: string[] = [];

function scratchStorePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "throne-add-to-queue-"));
  scratchDirectories.push(directory);
  return join(directory, "regent-queue.sqlite3");
}

after(() => {
  for (const directory of scratchDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// `targetRepo` is opaque launch metadata to everything under test here — no
// assertion inspects its value, and `resolveLaunchDefaults` is stubbed out
// entirely, so nothing requires a real checkout path. Deriving it from the
// test's own scratch root (rather than naming the operator's home directory)
// keeps this fixture free of any private-reference lint hit.
const LAUNCH_DEFAULTS_REPO_ROOT = mkdtempSync(
  join(tmpdir(), "throne-add-to-queue-repo-"),
);
scratchDirectories.push(LAUNCH_DEFAULTS_REPO_ROOT);
// `add-to-queue` admits the Stager role only (AGENTS.md, "The Stager" ->
// "Only a Stager files queue objectives"), so every caller here declares one.
// WHO may file is a different requirement with its own test; these cases are
// about whether a filed item is dispatchable, and a non-Stager stub would fail
// them for the wrong reason.
const AS_STAGER = {
  currentAgentName: async () => "stager-test",
  readRole: async () => ({
    status: IdentityLineReadStatus.Found,
    value: "Stager",
  }),
};

const LAUNCH_DEFAULTS = {
  targetRepo: join(LAUNCH_DEFAULTS_REPO_ROOT, "repo"),
  targetBranch: "main",
  baseCommit: "0".repeat(40),
};

test("add-to-queue mints an item the autoscale dispatch classifier calls eligible, with no reconcile pass in between", async () => {
  const databasePath = scratchStorePath();
  const exitCode = await run(["--target-repo", REPO_PATH, "--objective-code", "dsc", "Delete the status command"], {
    openStore: () => openRegentQueueStore(databasePath),
    ...AS_STAGER,
    resolveLaunchDefaults: (_repoPath: string) => LAUNCH_DEFAULTS,
    now: () => 1_700_000_000_000,
  });
  assert.equal(exitCode, 0);

  const store = openRegentQueueStore(databasePath);
  try {
    const item = store.readItem("dsc");
    assert.ok(item, "the item was written under its objective code");

    // The autoscaler's own classifier is the judge, not this test's opinion.
    const decision = classifyEffectiveQueueDecision(item!);
    assert.equal(
      decision.state,
      "eligible",
      `dispatch classifier refused a freshly added item: ${JSON.stringify(decision)}`,
    );
    assert.equal(item!.launchEligibility?.eligible, true);
  } finally {
    store.close();
  }
});

test("add-to-queue derives the branch and base an operator omitted, from the repo they named", () => {
  const parsed = parseAddToQueueArgs(["--target-repo", REPO_PATH, "--objective-code", "ent", "Fix enable throne"]);
  const launch = resolveLaunchMetadata(parsed, (_repoPath: string) => LAUNCH_DEFAULTS);

  // The repo is NOT derived any more — it is the one the caller named.
  assert.equal(launch.targetRepo, REPO_PATH);
  assert.equal(launch.targetBranch, LAUNCH_DEFAULTS.targetBranch);
  assert.equal(launch.baseCommit, LAUNCH_DEFAULTS.baseCommit);
  // `nameCarriesObjectiveCode` requires alpha-<code>-<something>; a bare
  // `alpha-ent` would fail the objective contract downstream.
  assert.match(launch.alphaName, /^alpha-ent-.+/);
});

test("add-to-queue refuses the insert when launch metadata cannot be derived, instead of queueing an undispatchable item", async () => {
  const databasePath = scratchStorePath();
  const exitCode = await run(["--target-repo", REPO_PATH, "--objective-code", "orp", "Orphan objective"], {
    openStore: () => openRegentQueueStore(databasePath),
    ...AS_STAGER,
    resolveLaunchDefaults: () => {
      throw new Error("not a git checkout");
    },
    now: () => 1_700_000_000_000,
  });
  assert.equal(exitCode, 1);

  const store = openRegentQueueStore(databasePath);
  try {
    assert.equal(store.readItem("orp"), undefined, "no item was written");
  } finally {
    store.close();
  }
});

test("add-to-queue refuses an item with no objective code, which could never be launch-eligible", () => {
  assert.throws(
    () => parseAddToQueueArgs(["Fix the thing"]),
    /--objective-code is required/,
  );
});

test("add-to-queue refuses an --alpha-name too long for Herdr to ever spawn", () => {
  const overlong = "alpha-dsc-" + "x".repeat(30);
  const parsed = parseAddToQueueArgs([
    "--target-repo",
    REPO_PATH,
    "--objective-code",
    "dsc",
    "--alpha-name",
    overlong,
    "Delete the status command",
  ]);
  assert.throws(
    () => resolveLaunchMetadata(parsed, (_repoPath: string) => LAUNCH_DEFAULTS),
    /Herdr allows at most 32/,
  );
});

test("add-to-queue refuses a whitespace-padded --alpha-name", () => {
  const parsed = parseAddToQueueArgs([
    "--target-repo",
    REPO_PATH,
    "--objective-code",
    "dsc",
    "--alpha-name",
    "  alpha-dsc-padded  ",
    "Delete the status command",
  ]);
  assert.throws(
    () => resolveLaunchMetadata(parsed, (_repoPath: string) => LAUNCH_DEFAULTS),
    /must be lowercase ASCII alphanumeric words/,
  );
});

test("add-to-queue refuses an --alpha-name that does not carry the item's objective code", () => {
  const parsed = parseAddToQueueArgs([
    "--target-repo",
    REPO_PATH,
    "--objective-code",
    "dsc",
    "--alpha-name",
    "alpha-orp-mismatched",
    "Delete the status command",
  ]);
  assert.throws(
    () => resolveLaunchMetadata(parsed, (_repoPath: string) => LAUNCH_DEFAULTS),
    /must begin "alpha-dsc-"/,
  );
});

// ---------------------------------------------------------------------------
// The Lord, 2026-08-27: "add-to-queue requires a mandatory target repo."
//
// It used to default to the FILER'S OWN CHECKOUT. Filing is Stager-only, and a
// Stager files objectives for OTHER repositories from its own tree, so that
// default was wrong essentially every time it was relied on. Measured that day:
// seven the-runner objectives recorded launch_target_repo pointing at a Stager
// worktree, and autoscale spent an hour trying to fork a the-runner campaign
// off a throne branch while the Alpha floor sat breached.
// ---------------------------------------------------------------------------

test("filing an objective without naming its target repository is refused", () => {
  assert.throws(
    () => parseAddToQueueArgs(["--objective-code", "nrp", "No repo named"]),
    /--target-repo is required/,
    "a missing target repo must refuse at parse time, before any row is written",
  );
});

test("the target repository is never inferred from where the filer is standing", () => {
  // The defect in one assertion: the launch record must carry the repo the
  // caller NAMED, never whatever repo the derivation stub reports.
  const parsed = parseAddToQueueArgs([
    "--target-repo",
    REPO_PATH,
    "--objective-code",
    "cwd",
    "Filed from somewhere else entirely",
  ]);
  const launch = resolveLaunchMetadata(parsed, (repoPath: string) => {
    assert.equal(
      repoPath,
      REPO_PATH,
      "branch and base must be derived from the NAMED repo, not the caller's cwd",
    );
    return LAUNCH_DEFAULTS;
  });
  assert.equal(launch.targetRepo, REPO_PATH);
  assert.notEqual(
    launch.targetRepo,
    LAUNCH_DEFAULTS.targetRepo,
    "the derivation stub's repo must not win over the named one",
  );
});
