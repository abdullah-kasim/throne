import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { openForgejoApi } from "../src/forge/forgejo-api.ts";
import { writeStagingMetadataComment } from "../src/forge/staging-metadata.ts";
import { git } from "./git-repo-test-fixture.ts";
import { startFakeForgejo, type FakeForgejo } from "./forge-fake-forgejo.ts";
import {
  forgeDependenciesWithFakeGithub,
  repositoryWithOriginAndFeatureBranch,
  runForgeCapturing,
  TEST_FORGEJO_TOKEN,
  TEST_TAILNET_ADDRESS,
  useFreshForgejoStateDirectory,
  type ForgejoStateDirectory,
} from "./forge-test-support.ts";

let state: ForgejoStateDirectory;
let checkout: Awaited<ReturnType<typeof repositoryWithOriginAndFeatureBranch>>;
let forgejo: FakeForgejo | undefined;

beforeEach(async () => {
  state = await useFreshForgejoStateDirectory();
  checkout = await repositoryWithOriginAndFeatureBranch("forge-host-");
});

afterEach(async () => {
  await forgejo?.close();
  forgejo = undefined;
  await checkout.remove();
  await state.remove();
});

async function writeBody(text: string): Promise<string> {
  const bodyFile = path.join(checkout.repo, "pr-body.md");
  await writeFile(bodyFile, text);
  return bodyFile;
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/`;
}

test("a host with Forgejo installed and answering opens pull requests in Forgejo", async () => {
  forgejo = await startFakeForgejo(TEST_FORGEJO_TOKEN);
  await state.installForgejo(forgejo.rootUrl);
  const dependencies = forgeDependenciesWithFakeGithub();
  const bodyFile = await writeBody("## Summary\n\nAdds the feature.\n");

  const pushed = await runForgeCapturing(["push-branch", "--branch", "add/feature"], dependencies, checkout.repo);
  assert.equal(pushed.exitCode, 0, pushed.stderr);
  const created = await runForgeCapturing(
    ["pr", "create", "--draft", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile],
    dependencies,
    checkout.repo,
  );

  assert.equal(created.exitCode, 0, created.stderr);
  assert.equal(created.stdout, `${forgejo.rootUrl}court-admin/staging-demo/pulls/1\n`);
  const status = JSON.parse((await runForgeCapturing(["status", created.stdout.trim(), "--json"], dependencies, checkout.repo)).stdout);
  assert.equal(status.hostForge, "forgejo");
  assert.equal(status.stage, "forgejo-only");
  assert.equal(forgejo.pullRequests.length, 1);
  assert.equal(forgejo.pullRequests[0]!.title, "WIP: [GH-##] Add the feature");
  assert.equal(forgejo.pullRequests[0]!.body, "## Summary\n\nAdds the feature.\n");
  assert.deepEqual(dependencies.githubCalls, []);
  assert.equal(await git(checkout.origin, ["branch", "--list", "add/feature"]), "");
});

test("a host without the Forgejo marker keeps opening pull requests on GitHub with the same gh command", async () => {
  const dependencies = forgeDependenciesWithFakeGithub(() => ({ exitCode: 0, stdout: "https://github.com/example/staging-demo/pull/9\n", stderr: "" }));
  const bodyFile = await writeBody("Body\n");

  const pushed = await runForgeCapturing(["push-branch", "--branch", "add/feature"], dependencies, checkout.repo);
  const created = await runForgeCapturing(
    ["pr", "create", "--draft", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile],
    dependencies,
    checkout.repo,
  );
  const bypassed = await runForgeCapturing(
    ["pr", "create", "--bypass", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile],
    dependencies,
    checkout.repo,
  );

  assert.equal(pushed.exitCode, 0, pushed.stderr);
  assert.equal(await git(checkout.origin, ["rev-parse", "refs/heads/add/feature"]), await git(checkout.repo, ["rev-parse", "add/feature"]));
  assert.equal(await git(checkout.repo, ["rev-parse", "--abbrev-ref", "add/feature@{upstream}"]), "origin/add/feature");
  assert.equal(created.stdout, "https://github.com/example/staging-demo/pull/9\n");
  assert.equal(bypassed.exitCode, 0);
  assert.deepEqual(dependencies.githubCalls, [
    {
      program: "gh",
      args: ["pr", "create", "--draft", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile],
      cwd: checkout.repo,
    },
    {
      program: "gh",
      args: ["--bypass", "pr", "create", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile],
      cwd: checkout.repo,
    },
  ]);
});

test("an installed Forgejo that does not answer refuses instead of falling back to GitHub", async () => {
  const deadUrl = await closedPortUrl();
  await state.installForgejo(deadUrl);
  const dependencies = forgeDependenciesWithFakeGithub();
  const bodyFile = await writeBody("Body\n");

  const status = await runForgeCapturing(["status", "1"], dependencies, checkout.repo);
  const created = await runForgeCapturing(
    ["pr", "create", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile],
    dependencies,
    checkout.repo,
  );
  const pushed = await runForgeCapturing(["push-branch", "--branch", "add/feature"], dependencies, checkout.repo);

  for (const refused of [status, created, pushed]) {
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, new RegExp(`${deadUrl}api/v1/version does not answer`));
    assert.match(refused.stderr, /nothing is sent to GitHub instead/);
    assert.match(refused.stderr, process.platform === "darwin" ? /launchctl print/ : /systemctl --user status forgejo\.service/);
  }
  assert.deepEqual(dependencies.githubCalls, []);
  assert.equal(await git(checkout.origin, ["branch", "--list", "add/feature"]), "");
});

test("a GitHub pull request URL stays on GitHub", async () => {
  forgejo = await startFakeForgejo(TEST_FORGEJO_TOKEN);
  await state.installForgejo(forgejo.rootUrl);
  const dependencies = forgeDependenciesWithFakeGithub((call) => ({ exitCode: 0, stdout: `${JSON.stringify({ url: call.args[2], state: "OPEN" })}\n`, stderr: "" }));
  const githubUrl = "https://github.com/example/staging-demo/pull/5";
  const enterpriseUrl = "https://github.example-corp.test/team/service/pull/12";
  const status = (url: string) => runForgeCapturing(["status", url, "--json"], dependencies, checkout.repo);

  for (const url of [githubUrl, enterpriseUrl]) {
    const found = JSON.parse((await status(url)).stdout);
    assert.deepEqual([found.target.kind, found.target.resolvedOn, found.forgejo], ["github-url", "github", null]);
  }
  for (const url of [`${forgejo.rootUrl}court-admin/staging-demo/pulls/3`, `http://${TEST_TAILNET_ADDRESS}:8420/court-admin/staging-demo/pulls/3`]) {
    assert.match((await status(url)).stderr, /Forgejo has no pull request at /);
  }
  const statusCalls = dependencies.githubCalls.length;

  await runForgeCapturing(["pr", "view", githubUrl], dependencies, checkout.repo);
  await runForgeCapturing(["pr", "diff", enterpriseUrl], dependencies, checkout.repo);

  assert.deepEqual(
    dependencies.githubCalls.map((call) => call.program),
    ["gh", "ghe", "gh", "ghe"],
  );
  assert.deepEqual(
    dependencies.githubCalls.slice(statusCalls).map((call) => [call.program, ...call.args]),
    [
      ["gh", "pr", "view", githubUrl, "--json", "number,url,title,body,state,isDraft,headRefName,baseRefName"],
      ["ghe", "pr", "diff", enterpriseUrl],
    ],
  );
  assert.equal(forgejo.pullRequests.length, 0);
});

async function forgejoPullRequestStagedAs(githubUrl: string, dependencies: ReturnType<typeof forgeDependenciesWithFakeGithub>): Promise<string> {
  const created = await runForgeCapturing(
    ["pr", "create", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", await writeBody("Body\n")],
    dependencies,
    checkout.repo,
  );
  assert.equal(created.exitCode, 0, created.stderr);
  const api = await openForgejoApi(forgejo!.rootUrl, dependencies);
  await writeStagingMetadataComment({ repository: { owner: "court-admin", name: "staging-demo" }, number: 1 }, githubUrl, {}, api);
  return created.stdout.trim();
}

test("status finds a staged GitHub pull request's Forgejo twin through the Forgejo metadata, from its files tab URL too", async () => {
  forgejo = await startFakeForgejo(TEST_FORGEJO_TOKEN);
  await state.installForgejo(forgejo.rootUrl);
  const githubUrl = "https://github.com/example/staging-demo/pull/5645";
  const dependencies = forgeDependenciesWithFakeGithub(() => ({ exitCode: 0, stdout: `${JSON.stringify({ url: githubUrl, state: "OPEN" })}\n`, stderr: "" }));
  const forgejoUrl = await forgejoPullRequestStagedAs(githubUrl, dependencies);

  const status = JSON.parse((await runForgeCapturing(["status", githubUrl, "--json"], dependencies, checkout.repo)).stdout);
  const statusFromFilesTab = JSON.parse((await runForgeCapturing(["status", `${githubUrl}/files`, "--json"], dependencies, checkout.repo)).stdout);

  assert.equal(status.forgejo.url, forgejoUrl);
  assert.equal(status.stage, "promoted");
  assert.equal(status.publishTo, "github");
  assert.equal(statusFromFilesTab.forgejo.url, forgejoUrl);
});
