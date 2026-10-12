import assert from "node:assert/strict";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { git } from "../../test/git-repo-test-fixture.ts";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { FAKE_FORGEJO_ADMIN } from "../../test/forge-fake-forgejo.ts";
import { forge, stagingDependencies } from "../../test/forge-staging-test-support.ts";
import { recordingEditor, removeWorktreesBesideCheckout, startOpenHost, type OpenHost } from "../../test/forge-open-test-support.ts";
import { runForgeCapturing, TEST_FORGEJO_TOKEN } from "../../test/forge-test-support.ts";
import { hydrationLogPath } from "./background-hydration.ts";
import { parseForgeArguments } from "./forge-arguments.ts";

const PRINT_ONLY_EDITOR_WAIT_MILLISECONDS = 500;

let host: OpenHost;

before(async () => {
  await import("./forge.command.ts");
  host = await startOpenHost("forge-open-");
});

afterEach(async () => {
  await host.setLiveAgents([]);
  await removeWorktreesBesideCheckout(host);
});

after(async () => {
  await host.remove();
});

function reviewWorktreeOf(checkout: string, number: number): string {
  return path.join(path.dirname(checkout), `${path.basename(checkout)}-pr-${number}`);
}

async function reviewerCloneWithoutTheHead(): Promise<string> {
  const reviewer = path.join(host.scratch, `reviewer-${Date.now()}`);
  await git(host.scratch, ["clone", "-q", host.staging.checkout.origin, reviewer]);
  await git(reviewer, ["remote", "add", "forgejo", await git(host.checkout, ["remote", "get-url", "forgejo"])]);
  return reviewer;
}

async function open(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runForgeCapturing(["open", ...args], stagingDependencies, host.checkout);
}

test("opening a pull request resolves its head through forge status and opens the chosen checkout", async () => {
  const pullRequest = host.addForgejoPullRequest("open");
  const reviewer = await reviewerCloneWithoutTheHead();
  const editor = await recordingEditor(host.scratch);
  const authorizationsBefore = host.staging.forgejo.gitAuthorizations.length;
  const status = await forge(host.staging, ["status", pullRequest.url]);

  const opened = await open([pullRequest.url, "--repo", reviewer, "--editor", editor.command]);

  const reviewWorktree = reviewWorktreeOf(reviewer, pullRequest.number);
  assert.equal(opened.exitCode, 0, opened.stderr);
  assert.equal(
    opened.stdout,
    [reviewWorktree, "created a detached review worktree at the pull request head", `editor: ${editor.command}`, "dependencies already current", ""].join("\n"),
  );
  assert.equal(await editor.launchedPath(), reviewWorktree);
  assert.equal(await git(reviewWorktree, ["rev-parse", "HEAD"]), host.featureSha);
  assert.equal(await git(reviewWorktree, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
  const forgejoCredentials = Buffer.from(`${FAKE_FORGEJO_ADMIN}:${TEST_FORGEJO_TOKEN}`).toString("base64");
  assert.ok(host.staging.forgejo.gitAuthorizations.slice(authorizationsBefore).includes(`Basic ${forgejoCredentials}`));
  assert.equal(await forge(host.staging, ["status", pullRequest.url]), status);
});

test("opening a pull request with --print prints only the path and launches nothing", async () => {
  const pullRequest = host.addForgejoPullRequest("open");
  const editor = await recordingEditor(host.scratch);
  const reviewWorktree = reviewWorktreeOf(host.checkout, pullRequest.number);

  const opened = await open([pullRequest.url, "--editor", editor.command, "--print"]);

  assert.equal(opened.exitCode, 0, opened.stderr);
  assert.equal(opened.stdout, `${reviewWorktree}\n`);
  assert.equal(await editor.launchedPath(PRINT_ONLY_EDITOR_WAIT_MILLISECONDS), undefined);
  assert.equal(await pathExists(hydrationLogPath(reviewWorktree)), false);
});

test("opening a pull request skips and names a live agent's worktree but not one at a different head", async () => {
  const pullRequest = host.addForgejoPullRequest("open");
  const liveAgentWorktree = await host.addDetachedWorktree(path.join(host.scratch, "busy-alpha"));
  await host.setLiveAgents(["busy-alpha"]);
  const editor = await recordingEditor(host.scratch);

  const opened = await open([pullRequest.url, "--editor", editor.command]);

  assert.equal(opened.exitCode, 0, opened.stderr);
  assert.equal(
    opened.stdout,
    [
      reviewWorktreeOf(host.checkout, pullRequest.number),
      "created a detached review worktree at the pull request head",
      `skipped ${liveAgentWorktree}: live agent busy-alpha`,
      `editor: ${editor.command}`,
      "dependencies already current",
      "",
    ].join("\n"),
  );
});

test("forge open needs a pull request unless --cleanup is given, and --cleanup takes none", () => {
  assert.throws(() => parseForgeArguments(["open"]), /forge open needs a pull request number, URL or branch/);
  assert.throws(() => parseForgeArguments(["open", "7", "--cleanup"]), /forge open --cleanup takes no pull request, but was given "7"/);
  assert.deepEqual([...parseForgeArguments(["open", "--cleanup"]).flags], ["--cleanup"]);
  const opened = parseForgeArguments(["open", "7", "--editor", "vim", "--print", "--repo", "/srv/project"]);
  assert.equal(opened.target, "7");
  assert.deepEqual(Object.fromEntries(opened.values), { "--editor": "vim", "--repo": "/srv/project" });
  assert.deepEqual([...opened.flags], ["--print"]);
});
