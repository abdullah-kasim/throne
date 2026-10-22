import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { git } from "./git-repo-test-fixture.ts";
import { recordingGitCalls, runForgeCapturing } from "./forge-test-support.ts";
import {
  FEATURE_LINES,
  forge,
  forgeJson,
  openGithubPullRequestToStage,
  stagingDependencies,
  startStagingHostForEachTest,
  writeInRepo,
  type StagingHost,
} from "./forge-staging-test-support.ts";

interface Landing {
  readonly forgejoUrl: string;
  readonly landedCommit: string;
  readonly base: string;
  readonly closed: boolean;
}

const LANDS_ON_MAIN_KEY = "throne.forge.landsOnMain";
const SIGNER_EMAIL = "lander@example.invalid";
const HUMAN_SUMMARY = "Adds the feature so the bakery can list its loaves.";
const PULL_REQUEST_BODY = [
  "<!-- forge-record: self-reviewed abc123 -->",
  "## What (human)",
  "",
  HUMAN_SUMMARY,
  "",
  "## What",
  "",
  "<details>",
  "<summary>What</summary>",
  "",
  "The machine description.",
  "",
  "</details>",
  "",
].join("\n");
const execFileAsync = promisify(execFile);

let signingFolder: string;
let environmentBeforeSigning: NodeJS.ProcessEnv;
let host: StagingHost;
let forgejoUrl: string;

async function signCommitsWithThrowawayKey(): Promise<void> {
  signingFolder = await mkdtemp(path.join(tmpdir(), "forge-land-signing-"));
  const key = path.join(signingFolder, "signing-key");
  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", SIGNER_EMAIL, "-f", key]);
  const allowedSigners = path.join(signingFolder, "allowed-signers");
  await writeFile(allowedSigners, `${SIGNER_EMAIL} ${await readFile(`${key}.pub`, "utf8")}`);
  environmentBeforeSigning = { ...process.env };
  const signing = { "user.signingkey": key, "gpg.format": "ssh", "gpg.ssh.allowedSignersFile": allowedSigners };
  const index = Number(process.env.GIT_CONFIG_COUNT ?? "0") || 0;
  Object.entries(signing).forEach(([name, value], offset) => {
    process.env[`GIT_CONFIG_KEY_${index + offset}`] = name;
    process.env[`GIT_CONFIG_VALUE_${index + offset}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(index + Object.keys(signing).length);
  Object.assign(process.env, {
    THRONE_GIT_SIGNING_KEY: key,
    THRONE_GIT_SIGNING_FORMAT: "ssh",
    GIT_AUTHOR_NAME: "Lander",
    GIT_AUTHOR_EMAIL: SIGNER_EMAIL,
    GIT_COMMITTER_NAME: "Lander",
    GIT_COMMITTER_EMAIL: SIGNER_EMAIL,
  });
  delete process.env.THRONE_GIT_IDENTITY_ORIGIN;
}

async function restoreEnvironmentBeforeSigning(): Promise<void> {
  for (const name of Object.keys(process.env)) if (!(name in environmentBeforeSigning)) delete process.env[name];
  Object.assign(process.env, environmentBeforeSigning);
  await rm(signingFolder, { recursive: true, force: true });
}

before(signCommitsWithThrowawayKey);
after(restoreEnvironmentBeforeSigning);

async function openForgejoPullRequest(prepared: StagingHost): Promise<void> {
  const bodyFile = path.join(prepared.checkout.repo, "pr-body.md");
  await writeFile(bodyFile, PULL_REQUEST_BODY);
  forgejoUrl = (
    await forge(prepared, ["pr", "create", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile])
  ).trim();
}

const stagingHostForThisTest = startStagingHostForEachTest("forge-land-on-main-", openForgejoPullRequest);

beforeEach(() => {
  host = stagingHostForThisTest();
});

async function markToLandOnMain(value: "true" | "false" | null): Promise<void> {
  if (value === null) await execFileAsync("git", ["config", "--unset-all", LANDS_ON_MAIN_KEY], { cwd: host.checkout.repo }).catch(() => undefined);
  else await git(host.checkout.repo, ["config", LANDS_ON_MAIN_KEY, value]);
}

function originMain(): Promise<string> {
  return git(host.checkout.origin, ["rev-parse", "refs/heads/main"]);
}

function forgejoMain(): Promise<string> {
  const forgejoRepository = new URL(forgejoUrl).pathname.split("/").slice(1, 3).join("/");
  return git(host.forgejo.bareRepositoryPath(forgejoRepository), ["rev-parse", "refs/heads/main"]);
}

function landedMessages(): string[] {
  return host.forgejo.comments.map((comment) => comment.body).filter((body) => body.startsWith("Landed on main"));
}

async function liveCheckoutState(): Promise<string[]> {
  const worktrees = (await git(host.checkout.repo, ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree "));
  return [
    await git(host.checkout.repo, ["status", "--porcelain"]),
    await git(host.checkout.repo, ["rev-parse", "HEAD"]),
    await git(host.checkout.repo, ["branch", "--show-current"]),
    String(worktrees.length),
  ];
}

async function refused(args: readonly string[]): Promise<string> {
  const result = await runForgeCapturing(args, stagingDependencies, host.checkout.repo);
  assert.equal(result.exitCode, 1, result.stdout);
  return result.stderr;
}

test("landing a Forgejo pull request puts one signed squash commit on main named after the pull request", async () => {
  await markToLandOnMain("true");
  const mainBefore = await originMain();
  const checkoutBefore = await liveCheckoutState();

  const landing = await forgeJson<Landing>(host, ["land", forgejoUrl]);

  assert.deepEqual(landing, { forgejoUrl, landedCommit: await originMain(), base: "main", closed: true });
  const commit = landing.landedCommit;
  assert.equal(await git(host.checkout.repo, ["rev-list", "--parents", "-n", "1", commit]), `${commit} ${mainBefore}`);
  assert.equal(await git(host.checkout.repo, ["log", "-1", "--format=%G?", commit]), "G");
  assert.equal(await git(host.checkout.repo, ["log", "-1", "--format=%B", commit]), `Add the feature\n\n${HUMAN_SUMMARY}`);
  assert.equal(await git(host.checkout.repo, ["show", `${commit}:feature.txt`]), FEATURE_LINES.join("\n"));
  assert.deepEqual(await liveCheckoutState(), checkoutBefore);
});

test("landing pushes the commit to GitHub's main and then to Forgejo's main", async () => {
  await markToLandOnMain("true");
  const recording = recordingGitCalls(stagingDependencies);

  const result = await runForgeCapturing(["land", forgejoUrl], recording, host.checkout.repo);

  assert.equal(result.exitCode, 0, result.stderr);
  const commit = (JSON.parse(result.stdout) as Landing).landedCommit;
  assert.deepEqual([await originMain(), await forgejoMain()], [commit, commit]);
  const pushes = recording.gitCalls.filter((call) => call[0] === "push");
  assert.deepEqual(pushes, [
    ["push", "origin", `${commit}:refs/heads/main`],
    ["push", "forgejo", `${commit}:refs/heads/main`],
  ]);
  assert.deepEqual((await host.github.read()).calls, []);
});

function landedPullRequestState(): unknown[] {
  const { state, merged, merge_commit_sha } = host.forgejo.pullRequests[0]!;
  return [state, merged, merge_commit_sha, host.forgejo.merges];
}

test('landing comments "Landed on main as <sha>" and records the Forgejo pull request as merged with the landed commit, and Forgejo makes no commit', async () => {
  await markToLandOnMain("true");

  const landing = await forgeJson<Landing>(host, ["land", forgejoUrl]);

  assert.match(landing.landedCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(landedMessages(), [`Landed on main as ${landing.landedCommit}`]);
  assert.deepEqual(landedPullRequestState(), ["closed", true, landing.landedCommit, []]);
  assert.deepEqual(host.forgejo.manualMerges.map(({ commit }) => commit), [landing.landedCommit]);
  assert.equal(await forgejoMain(), landing.landedCommit);
});

test("a landing that Forgejo refuses to record as merged says the commit already landed on both mains", async () => {
  await markToLandOnMain("true");
  host.forgejo.pullRequests[0]!.state = "closed";

  const stderr = await refused(["land", forgejoUrl]);

  const commit = await originMain();
  assert.equal(await forgejoMain(), commit);
  assert.match(stderr, new RegExp(`${commit} already landed on main in GitHub and in Forgejo, and ${forgejoUrl} was commented on, but it was not recorded as merged`));
  assert.deepEqual([landedMessages(), host.forgejo.pullRequests[0]!.merged], [[`Landed on main as ${commit}`], false]);
});

test("a landing whose squash conflicts refuses with the conflicting paths and changes nothing", async () => {
  await markToLandOnMain("true");
  const elsewhere = await mkdtemp(path.join(tmpdir(), "forge-land-elsewhere-"));
  try {
    await git(elsewhere, ["clone", "-q", "-b", "main", host.checkout.origin, "clone"]);
    const clone = path.join(elsewhere, "clone");
    await writeFile(path.join(clone, "feature.txt"), "a different feature\n");
    await git(clone, ["add", "feature.txt"]);
    await git(clone, ["-c", "user.name=Other", "-c", `user.email=${SIGNER_EMAIL}`, "commit", "--no-gpg-sign", "-q", "-m", "other feature"]);
    await git(clone, ["push", "-q", "origin", "main"]);
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
  const [originBefore, forgejoBefore, checkoutBefore] = [await originMain(), await forgejoMain(), await liveCheckoutState()];

  const stderr = await refused(["land", forgejoUrl]);

  assert.match(stderr, /conflicts with refs\/remotes\/origin\/main in feature\.txt/);
  assert.ok(stderr.trim().endsWith("Nothing was changed."), stderr);
  assert.deepEqual([await originMain(), await forgejoMain()], [originBefore, forgejoBefore]);
  assert.deepEqual([host.forgejo.pullRequests[0]!.state, landedMessages()], ["open", []]);
  assert.deepEqual(await liveCheckoutState(), checkoutBefore);
});

test("landing refuses in a repository that is not marked to land on main", async () => {
  const mainBefore = await originMain();

  for (const value of [null, "false"] as const) {
    await markToLandOnMain(value);
    const stderr = await refused(["land", forgejoUrl]);
    assert.match(stderr, /^forge land: .* does not set throne\.forge\.landsOnMain to true/);
    assert.ok(stderr.trim().endsWith("Nothing was changed."), stderr);
    assert.deepEqual([await originMain(), host.forgejo.pullRequests[0]!.state, landedMessages()], [mainBefore, "open", []]);
  }
  await markToLandOnMain("true");
  const landing = await forgeJson<Landing>(host, ["land", forgejoUrl]);

  assert.equal(await originMain(), landing.landedCommit);
});

test("promoting a pull request in a repository that lands on main lands it instead of opening a GitHub pull request", async () => {
  await markToLandOnMain(null);
  const promotion = await forgeJson<{ githubUrl: string }>(host, ["promote", forgejoUrl]);
  assert.match(promotion.githubUrl, /^https:\/\/github\.com\//);
  const githubCallsBeforeTheKey = (await host.github.mutatingCalls()).length;
  const mainBefore = await originMain();

  await markToLandOnMain("true");
  const landing = await forgeJson<Landing>(host, ["promote", forgejoUrl]);

  assert.deepEqual(landing, { forgejoUrl, landedCommit: await originMain(), base: "main", closed: true });
  assert.notEqual(landing.landedCommit, mainBefore);
  assert.equal((await host.github.mutatingCalls()).length, githubCallsBeforeTheKey);
  assert.deepEqual(landedMessages(), [`Landed on main as ${landing.landedCommit}`]);
});

test("merging a Forgejo pull request in a repository that lands on main lands it instead of refusing", async () => {
  await markToLandOnMain(null);
  assert.match(await refused(["pr", "merge", forgejoUrl, "--squash"]), /Nothing is merged in Forgejo/);

  await markToLandOnMain("true");
  const landing = await forgeJson<Landing>(host, ["pr", "merge", forgejoUrl, "--squash"]);

  assert.deepEqual(landing, { forgejoUrl, landedCommit: await originMain(), base: "main", closed: true });
  assert.deepEqual(landedPullRequestState(), ["closed", true, landing.landedCommit, []]);
  assert.deepEqual((await host.github.read()).calls, []);
});

test("a repository that lands on main never gets a GitHub pull request, comment or review from the forge", async () => {
  const githubUrl = await openGithubPullRequestToStage(host);
  const bodyFile = await writeInRepo(host, "github-text.md", "A note.\n");
  const findingsFile = path.join(host.checkout.repo, "findings.json");
  const githubWrites = [
    ["pr", "comment", githubUrl, "--body-file", bodyFile],
    ["pr", "edit", githubUrl, "--body-file", bodyFile],
    ["pr", "create", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile],
    ["pr", "review-findings", forgejoUrl, "--out", findingsFile],
  ];
  await rm(path.join(host.state.forgejoDirectory, "enabled"));

  await markToLandOnMain(null);
  for (const args of githubWrites) {
    const before = (await host.github.mutatingCalls()).length;
    const result = await runForgeCapturing(args, stagingDependencies, host.checkout.repo);
    assert.doesNotMatch(result.stderr, /landsOnMain/, args.join(" "));
    if (args[1] !== "review-findings") assert.equal((await host.github.mutatingCalls()).length, before + 1, args.join(" "));
  }
  await markToLandOnMain("true");
  const githubCallsBefore = (await host.github.read()).calls.length;
  for (const args of githubWrites) {
    const stderr = await refused(args);
    assert.match(stderr, /sets throne\.forge\.landsOnMain to true, so its pull requests live only in Forgejo and land on main through `throne forge land`/, args.join(" "));
    assert.ok(stderr.trim().endsWith("nothing was sent to GitHub."), stderr);
  }

  assert.equal((await host.github.read()).calls.length, githubCallsBefore);
});

test("landing summarises a pull request body without a human section by its first paragraph", async () => {
  await markToLandOnMain("true");
  const bodyFile = await writeInRepo(host, "plain-body.md", "## Summary\n\n<!-- a record -->Adds the feature.\nIn two lines.\n\nMore detail.\n");
  await forge(host, ["pr", "edit", forgejoUrl, "--title", "[GH-##] Add the feature", "--body-file", bodyFile]);

  const landing = await forgeJson<Landing>(host, ["land", forgejoUrl]);

  assert.equal(await git(host.checkout.repo, ["log", "-1", "--format=%B", landing.landedCommit]), "Add the feature\n\nAdds the feature.\nIn two lines.");
});
