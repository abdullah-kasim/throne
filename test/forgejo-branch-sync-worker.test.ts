import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import type { ForgeDependencies } from "../src/forge/forge-dependencies.ts";
import { openForgejoApiOnThisHost } from "../src/forge/pull-request-operations.ts";
import {
  FORGEJO_BRANCH_SYNC_HOSTED_WORKER_NAME,
  ForgejoBranchSyncHostedWorker,
} from "../src/throne-backend/forgejo-branch-sync.hosted-worker.ts";
import { HostedWorkerRegistrarService } from "../src/throne-backend/hosted-worker-registrar.service.ts";
import { FAKE_FORGEJO_ADMIN } from "./forge-fake-forgejo.ts";
import {
  commitInBareByHand,
  forgeDependenciesWithFakeGithub,
  recordingGitCalls,
  runForgeCapturing,
  startForgejoWithCheckoutForEachTest,
  useFreshForgejoStateDirectory,
} from "./forge-test-support.ts";
import { git } from "./git-repo-test-fixture.ts";

const dependencies = forgeDependenciesWithFakeGithub();
const SECOND_COPY_NAME = "second-demo";
const forgejoWithCheckout = startForgejoWithCheckoutForEachTest("forgejo-branch-sync-worker-");
const checkout = () => forgejoWithCheckout().checkout;
const forgejo = () => forgejoWithCheckout().forgejo;

function workerLoggingTo(log: string[], forge: ForgeDependencies = dependencies): ForgejoBranchSyncHostedWorker {
  return new ForgejoBranchSyncHostedWorker({ forge, log: (message) => log.push(message) });
}

function countingFetches(forge: ForgeDependencies): ForgeDependencies & { readonly fetchedUrls: string[] } {
  const fetchedUrls: string[] = [];
  return {
    ...forge,
    fetchedUrls,
    fetch: (input, init) => {
      fetchedUrls.push(String(input));
      return forge.fetch(input, init);
    },
  };
}

test("the branch mirror does nothing on a host without Forgejo", async () => {
  const state = await useFreshForgejoStateDirectory();
  try {
    const log: string[] = [];
    const recording = countingFetches(recordingGitCalls(dependencies));

    await workerLoggingTo(log, recording).runOnce();

    assert.deepEqual(recording.gitCalls, []);
    assert.deepEqual(recording.fetchedUrls, []);
    assert.deepEqual(log, []);
  } finally {
    await state.remove();
  }
});

function forgejoCopy(name: string): string {
  return forgejo().bareRepositoryPath(`${FAKE_FORGEJO_ADMIN}/${name}`);
}

async function copyToForgejoFrom(repo: string): Promise<void> {
  const copied = await runForgeCapturing(["ensure-repository"], dependencies, repo);
  assert.equal(copied.exitCode, 0, copied.stderr);
}

async function secondCheckoutWithForgejoCopy(): Promise<{ readonly repo: string; readonly origin: string }> {
  const root = await forgejoWithCheckout().scratchDirectory("forgejo-branch-sync-worker-second-");
  const origin = path.join(root, `${SECOND_COPY_NAME}.git`);
  const repo = path.join(root, "checkout");
  await git(root, ["clone", "-q", "--bare", checkout().origin, origin]);
  await git(root, ["clone", "-q", origin, repo]);
  await git(repo, ["remote", "set-head", "origin", "main"]);
  await copyToForgejoFrom(repo);
  return { repo, origin };
}

async function branchOnGithub(origin: string, branch: string): Promise<string> {
  await git(origin, ["branch", branch, "main"]);
  return commitInBareByHand(origin, branch, `work on ${branch}`);
}

test("the branch mirror syncs every Forgejo repository that has a recorded checkout", async () => {
  await copyToForgejoFrom(checkout().repo);
  const second = await secondCheckoutWithForgejoCopy();
  const api = await openForgejoApiOnThisHost(dependencies);
  await api.sendJson("POST", "user/repos", { name: "made-by-hand", private: true });
  const firstRelease = await branchOnGithub(checkout().origin, "release/next");
  const secondRelease = await branchOnGithub(second.origin, "release/next");
  const log: string[] = [];

  await workerLoggingTo(log).runOnce();

  assert.equal(await git(forgejoCopy("staging-demo"), ["rev-parse", "refs/heads/release/next"]), firstRelease);
  assert.equal(await git(forgejoCopy(SECOND_COPY_NAME), ["rev-parse", "refs/heads/release/next"]), secondRelease);
  assert.ok(log.includes(`${FAKE_FORGEJO_ADMIN}/staging-demo: created 1, fast-forwarded 0, diverged 0, failed 0; every open pull request base is current`), log.join("\n"));
  assert.ok(log.some((line) => line.startsWith(`${FAKE_FORGEJO_ADMIN}/made-by-hand: skipped`)), log.join("\n"));
});

test("a failed branch sync is logged and does not throw out of the backend worker", async () => {
  await copyToForgejoFrom(checkout().repo);
  const second = await secondCheckoutWithForgejoCopy();
  await git(checkout().repo, ["remote", "set-url", "origin", path.join(tmpdir(), "no-such-github-repository.git")]);
  const secondRelease = await branchOnGithub(second.origin, "release/next");
  const log: string[] = [];

  await workerLoggingTo(log).runOnce();

  assert.ok(log.some((line) => line.startsWith(`${FAKE_FORGEJO_ADMIN}/staging-demo: branch sync failed:`)), log.join("\n"));
  assert.equal(await git(forgejoCopy(SECOND_COPY_NAME), ["rev-parse", "refs/heads/release/next"]), secondRelease);
});

test("the branch mirror runs once when the backend starts and then every ten minutes", async () => {
  await copyToForgejoFrom(checkout().repo);
  const log: string[] = [];
  const worker = workerLoggingTo(log);
  const runs: Promise<void>[] = [];
  const runOnce = worker.runOnce.bind(worker);
  worker.runOnce = () => {
    const run = runOnce();
    runs.push(run);
    return run;
  };
  const scheduler = new SchedulerRegistry();

  new HostedWorkerRegistrarService([worker], scheduler).onApplicationBootstrap();
  const job = scheduler.getCronJob(FORGEJO_BRANCH_SYNC_HOSTED_WORKER_NAME);
  try {
    assert.equal(job.cronTime.source, CronExpression.EVERY_10_MINUTES);
    assert.equal(runs.length, 1);
    await Promise.all(runs);
    assert.ok(log.some((line) => line.startsWith(`${FAKE_FORGEJO_ADMIN}/staging-demo: created 0`)), log.join("\n"));
  } finally {
    job.stop();
  }
});

test("a branch mirror run that starts while the previous one is still going does nothing", async () => {
  await copyToForgejoFrom(checkout().repo);
  const release = await branchOnGithub(checkout().origin, "release/next");
  const log: string[] = [];
  const worker = workerLoggingTo(log);

  const firstRun = worker.runOnce();
  await worker.runOnce();
  const logWhileTheFirstRunWasGoing = [...log];
  await firstRun;

  assert.deepEqual(logWhileTheFirstRunWasGoing, ["skipped: the previous branch mirror run is still going"]);
  assert.equal(await git(forgejoCopy("staging-demo"), ["rev-parse", "refs/heads/release/next"]), release);
  assert.equal(log.filter((line) => line.startsWith(`${FAKE_FORGEJO_ADMIN}/staging-demo:`)).length, 1);
});
