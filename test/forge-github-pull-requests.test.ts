import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  copyOfCheckoutForEachTest,
  forgeDependenciesWithFakeGithub,
  runForgeCapturing,
  useFreshForgejoStateDirectory,
  type CheckoutWithOrigin,
  type ForgejoStateDirectory,
} from "./forge-test-support.ts";

const checkoutForThisTest = copyOfCheckoutForEachTest("forge-github-");
let state: ForgejoStateDirectory;
let checkout: CheckoutWithOrigin;

beforeEach(async () => {
  state = await useFreshForgejoStateDirectory();
  checkout = checkoutForThisTest();
});

afterEach(async () => {
  await state.remove();
});

test("every GitHub pull request operation runs today's gh command and adds --bypass only when the caller passed it", async () => {
  const dependencies = forgeDependenciesWithFakeGithub(() => ({ exitCode: 0, stdout: "from gh\n", stderr: "" }));
  const bodyFile = path.join(checkout.repo, "pr-body.md");
  await writeFile(bodyFile, "> [!NOTE]\n> Body.\n");
  const viewFields = "number,url,title,body,state,isDraft,headRefName,baseRefName";

  const invocations: string[][] = [
    ["pr", "view", "12"],
    ["pr", "edit", "add/feature", "--body-file", bodyFile, "--bypass"],
    ["pr", "list"],
    ["pr", "list", "--limit", "5"],
    ["pr", "diff", "12"],
    ["pr", "merge", "12", "--squash", "--bypass"],
    ["pr", "comment", "12", "--body-file", bodyFile, "--bypass"],
    ["render-markdown", "--file", bodyFile, "--bypass"],
  ];
  for (const args of invocations) {
    const result = await runForgeCapturing(args, dependencies, checkout.repo);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "from gh\n");
  }

  assert.deepEqual(
    dependencies.githubCalls.map((call) => [call.program, call.cwd, ...call.args]),
    [
      ["gh", checkout.repo, "pr", "view", "12", "--json", viewFields],
      ["gh", checkout.repo, "--bypass", "pr", "edit", "add/feature", "--body-file", bodyFile],
      ["gh", checkout.repo, "pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,headRefName,url,files"],
      ["gh", checkout.repo, "pr", "list", "--state", "open", "--limit", "5", "--json", "number,title,headRefName,url,files"],
      ["gh", checkout.repo, "pr", "diff", "12"],
      ["gh", checkout.repo, "--bypass", "pr", "merge", "12", "--squash", "--delete-branch=false"],
      ["gh", checkout.repo, "--bypass", "pr", "comment", "12", "--body-file", bodyFile],
      ["gh", checkout.repo, "--bypass", "api", "-X", "POST", "/markdown", "-f", "mode=gfm", "-f", "text=> [!NOTE]\n> Body.\n"],
    ],
  );
});

test("a refused gh command keeps its exit status and message", async () => {
  const dependencies = forgeDependenciesWithFakeGithub(() => ({
    exitCode: 64,
    stdout: "",
    stderr: "throne gh guard: denied GitHub mutation or unclassified command: gh pr merge 12\n",
  }));

  const result = await runForgeCapturing(["pr", "merge", "12", "--squash"], dependencies, checkout.repo);

  assert.equal(result.exitCode, 64);
  assert.match(result.stderr, /throne gh guard: denied/);
});

test("operations with no GitHub equivalent on a GitHub host say so and run nothing", async () => {
  const dependencies = forgeDependenciesWithFakeGithub();
  const file = path.join(checkout.repo, "shot.png");
  await writeFile(file, "png");

  const attach = await runForgeCapturing(["attach", "12", "--file", file], dependencies, checkout.repo);
  const ensure = await runForgeCapturing(["ensure-repository"], dependencies, checkout.repo);

  assert.equal(attach.exitCode, 1);
  assert.match(attach.stderr, /GitHub has no upload that returns an attachment URL/);
  assert.equal(ensure.exitCode, 1);
  assert.match(ensure.stderr, /this host's forge is GitHub/);
  assert.deepEqual(dependencies.githubCalls, []);
});

test("forge refuses an unknown operation, a missing value and a bad limit before doing anything", async () => {
  const dependencies = forgeDependenciesWithFakeGithub();

  for (const args of [["pr", "close", "12"], ["pr", "edit", "12"], ["pr", "list", "--limit", "many"], ["pr", "view"], ["status", "--verbose"]]) {
    const result = await runForgeCapturing(args, dependencies, checkout.repo);
    assert.equal(result.exitCode, 2, args.join(" "));
    assert.match(result.stderr, /Usage: throne forge <operation>/);
    assert.match(result.stderr, /forge entrance validation refused/);
  }
  assert.deepEqual(dependencies.githubCalls, []);
});

test("a GitHub pull request's title can be changed with throne forge pr edit --title", async () => {
  const dependencies = forgeDependenciesWithFakeGithub(() => ({ exitCode: 0, stdout: "from gh\n", stderr: "" }));

  const result = await runForgeCapturing(["pr", "edit", "12", "--title", "Add the feature", "--bypass"], dependencies, checkout.repo);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(
    dependencies.githubCalls.map((call) => [call.program, ...call.args]),
    [["gh", "--bypass", "pr", "edit", "12", "--title", "Add the feature"]],
  );
});

test("throne forge pr edit with neither a title nor a body file is refused", async () => {
  const dependencies = forgeDependenciesWithFakeGithub();

  const result = await runForgeCapturing(["pr", "edit", "12", "--bypass"], dependencies, checkout.repo);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /forge pr edit requires --title or --body-file/);
  assert.deepEqual(dependencies.githubCalls, []);
});
