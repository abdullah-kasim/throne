import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { openRegentQueueStore, RegentQueueItemStatus } from "../regent-queue/regent-queue.store.ts";
import { QueueOutcome } from "../regent-queue/regent-queue-outcome.ts";
import { intentFirstSentence } from "./work-log-queue-rows.ts";
import { runWorkLog, WorkLogExitCode } from "./work-log-runtime.ts";

const HOUR = 60 * 60 * 1000;
const SINCE_ARGUMENT = "2026-10-06";
const SINCE = new Date(`${SINCE_ARGUMENT}T00:00:00`).getTime();
const NOW = SINCE + 20 * HOUR;
const PULL_REQUEST_URL = "https://github.com/example/shop/pull/42";
const RESULT_COMMIT = "6e5ea7a0c1d2e3f405162738495a6b7c8d9e0f1a";

interface WorkLogScene {
  readonly queueDatabasePath: string;
  readonly githubActionLogPath: string;
}

async function sceneDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "work-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function buildQueue(queueDatabasePath: string): void {
  let clock = SINCE - 30 * HOUR;
  const store = openRegentQueueStore(queueDatabasePath, () => clock);
  const before = store.insertItem({ objectiveCode: "before", body: "INTENT: Finished long ago." });
  store.mutateItem(before.id, { status: RegentQueueItemStatus.Complete });
  const touched = store.insertItem({ objectiveCode: "touched", body: "INTENT: Still under way." });
  const finished = store.insertItem({
    objectiveCode: "finished",
    body: "  INTENT: Land the sign-in return path. Keep the old link working.\n\nSCOPE: the sign-in page only.",
  });
  const unrecorded = store.insertItem({ objectiveCode: "unrecorded", body: "INTENT: Dropped quietly." });
  clock = SINCE + 2 * HOUR;
  store.mutateItem(touched.id, { status: RegentQueueItemStatus.InFlight });
  clock = SINCE + 4 * HOUR;
  store.mutateItem(finished.id, {
    status: RegentQueueItemStatus.Complete,
    outcome: QueueOutcome.Merged,
    outcomeSummary: "Merged the sign-in return path.",
    prUrl: PULL_REQUEST_URL,
    resultCommit: RESULT_COMMIT,
  });
  clock = SINCE + 6 * HOUR;
  store.mutateItem(unrecorded.id, { status: RegentQueueItemStatus.Abandoned });
  store.close();
}

function githubActionLine(timestamp: number, subcommand: string, pr: number | null): string {
  return JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    agent: "stager-first",
    host: "github.com",
    repo: "example/shop",
    subcommand,
    pr,
    exit_code: 0,
  });
}

async function writeGithubActionLog(githubActionLogPath: string): Promise<void> {
  await writeFile(
    githubActionLogPath,
    [
      githubActionLine(SINCE - 3 * HOUR, "pr comment", 41),
      "{not json",
      githubActionLine(SINCE + 5 * HOUR, "pr edit --add-reviewer", 42),
      "",
    ].join("\n"),
  );
}

async function buildScene(t: TestContext): Promise<WorkLogScene> {
  const directory = await sceneDirectory(t);
  const scene = {
    queueDatabasePath: path.join(directory, "regent-queue.sqlite3"),
    githubActionLogPath: path.join(directory, "github-actions.jsonl"),
  };
  buildQueue(scene.queueDatabasePath);
  await writeGithubActionLog(scene.githubActionLogPath);
  return scene;
}

async function workLogOutput(scene: WorkLogScene, commandArguments: readonly string[]): Promise<string> {
  const printed: string[] = [];
  const exitCode = await runWorkLog(commandArguments, {
    ...scene,
    now: () => new Date(NOW),
    out: (message) => void printed.push(message),
    err: (message) => assert.fail(message),
  });
  assert.equal(exitCode, WorkLogExitCode.Listed);
  return printed.join("");
}

function lineFor(output: string, objectiveCode: string): string {
  return output.split("\n").find((line) => line.includes(`**${objectiveCode}**`)) ?? "";
}

function intentLineAfter(output: string, objectiveCode: string): string {
  const lines = output.split("\n");
  return lines[lines.findIndex((line) => line.includes(`**${objectiveCode}**`)) + 1] ?? "";
}

test("work-log lists only the queue rows completed or updated since the given date", async (t) => {
  const output = await workLogOutput(await buildScene(t), ["--since", SINCE_ARGUMENT]);

  assert.match(output, /## Queue rows \(3\)/);
  assert.match(lineFor(output, "touched"), /\(in-flight\)/);
  assert.match(lineFor(output, "finished"), /\(complete\)/);
  assert.match(lineFor(output, "unrecorded"), /\(abandoned\)/);
  assert.equal(lineFor(output, "before"), "");
});

test("work-log shows a finished row's outcome fields and the first sentence of its intent", async (t) => {
  const output = await workLogOutput(await buildScene(t), ["--since", SINCE_ARGUMENT]);
  const finished = lineFor(output, "finished");

  assert.match(finished, /outcome: merged/);
  assert.match(finished, /summary: Merged the sign-in return path\./);
  assert.ok(finished.includes(`pull request: ${PULL_REQUEST_URL}`));
  assert.ok(finished.includes(`result commit: ${RESULT_COMMIT}`));
  assert.ok(finished.includes(`completed: ${new Date(SINCE + 4 * HOUR).toISOString()}`));
  assert.equal(intentLineAfter(output, "finished"), "  Intent: Land the sign-in return path.");
});

test("work-log shows not recorded for a row with no outcome", async (t) => {
  const output = await workLogOutput(await buildScene(t), ["--since", SINCE_ARGUMENT]);

  assert.match(lineFor(output, "unrecorded"), /outcome: not recorded/);
  assert.match(lineFor(output, "touched"), /outcome: not recorded/);
});

test("work-log includes only the GitHub actions logged since the given date", async (t) => {
  const output = await workLogOutput(await buildScene(t), ["--since", SINCE_ARGUMENT]);

  assert.match(output, /## GitHub actions \(1\)/);
  assert.ok(output.includes("`pr edit --add-reviewer` on github.com/example/shop #42 by stager-first exit 0"));
  assert.ok(!output.includes("`pr comment`"));
  assert.match(output, /Skipped 1 malformed GitHub action log line/);
});

test("work-log reads no GitHub actions when the log file does not exist yet", async (t) => {
  const scene = await buildScene(t);
  await rm(scene.githubActionLogPath);
  const output = await workLogOutput(scene, ["--since", SINCE_ARGUMENT]);

  assert.match(output, /## GitHub actions \(0\)\n\nNone\./);
  assert.match(output, /## Queue rows \(3\)/);
});

test("work-log prints the same window as JSON when asked", async (t) => {
  const log = JSON.parse(await workLogOutput(await buildScene(t), ["--since", SINCE_ARGUMENT, "--json"]));

  assert.equal(log.since, new Date(SINCE).toISOString());
  assert.deepEqual(
    log.rows.map((row: { objectiveCode: string }) => row.objectiveCode),
    ["touched", "finished", "unrecorded"],
  );
  assert.deepEqual(log.rows[1], {
    objectiveCode: "finished",
    status: "complete",
    outcome: "merged",
    outcomeSummary: "Merged the sign-in return path.",
    prUrl: PULL_REQUEST_URL,
    resultCommit: RESULT_COMMIT,
    completedAt: new Date(SINCE + 4 * HOUR).toISOString(),
    updatedAt: new Date(SINCE + 4 * HOUR).toISOString(),
    intent: "Land the sign-in return path.",
  });
  assert.equal(log.rows[2].outcome, null);
  assert.deepEqual(
    log.githubActions.map((action: { subcommand: string; pr: number }) => [action.subcommand, action.pr]),
    [["pr edit --add-reviewer", 42]],
  );
  assert.equal(log.malformedGithubActionLines, 1);
});

const REFUSED_INVOCATIONS: ReadonlyArray<readonly [readonly string[], RegExp]> = [
  [["--since", "yesterday"], /--since "yesterday" is not an ISO date/],
  [["--since", SINCE_ARGUMENT, "--until", "2026-10-07"], /Unknown option '--until'/],
  [["--json"], /--since <date> is required/],
];

test("work-log refuses an unknown flag, a missing --since or a since value that is not an ISO date before reading anything", async (t) => {
  const scene = await buildScene(t);
  for (const [commandArguments, reason] of REFUSED_INVOCATIONS) {
    const refusals: string[] = [];
    const exitCode = await runWorkLog(commandArguments, {
      ...scene,
      now: () => new Date(NOW),
      out: (message) => assert.fail(message),
      err: (message) => void refusals.push(message),
    });

    assert.equal(exitCode, WorkLogExitCode.InvalidInvocation);
    assert.match(refusals.join(""), reason);
    assert.match(refusals.join(""), /usage: throne work-log --since <date> \[--json\]/);
  }
});

test("work-log does not end an intent's first sentence at a numbered list marker", () => {
  const stackedIntent = [
    "INTENT: Split the shop change into a stack a reviewer reads one layer at a time:",
    "1. the API calls;",
    "2. the shared pieces;",
    "3. the page itself.",
    "The first two keep their numbers.",
    "",
    "SCOPE: the shop only.",
  ].join("\n");
  const unfinishedIntent = "INTENT: Teach the skill two standing rules:\n1. no middlemen;\n2. always a checked bag\n\nSCOPE: the skill.";

  assert.equal(
    intentFirstSentence(stackedIntent),
    "Split the shop change into a stack a reviewer reads one layer at a time: 1. the API calls; 2. the shared pieces; 3. the page itself.",
  );
  assert.equal(intentFirstSentence(unfinishedIntent), "Teach the skill two standing rules: 1. no middlemen; 2. always a checked bag");
});
