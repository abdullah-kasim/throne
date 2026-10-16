import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_FORGEJO_ADMIN, type FakeForgejo } from "./forge-fake-forgejo.ts";
import {
  forgeDependenciesWithFakeGithub,
  runForgeCapturing,
  startForgejoWithCheckoutForEachTest,
  TEST_FORGEJO_TOKEN,
  type CheckoutWithOrigin,
  type ForgejoStateDirectory,
} from "./forge-test-support.ts";

const forgejoWithCheckout = startForgejoWithCheckoutForEachTest("forge-forgejo-");
let state: ForgejoStateDirectory;
let checkout: CheckoutWithOrigin;
let forgejo: FakeForgejo;
const dependencies = forgeDependenciesWithFakeGithub();

beforeEach(() => {
  ({ state, checkout, forgejo } = forgejoWithCheckout());
});

async function writeFileInRepo(name: string, text: string | Uint8Array): Promise<string> {
  const filePath = path.join(checkout.repo, name);
  await writeFile(filePath, text);
  return filePath;
}

async function forge(args: readonly string[]) {
  const result = await runForgeCapturing(args, dependencies, checkout.repo);
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}

async function createDraftPullRequest(): Promise<string> {
  const bodyFile = await writeFileInRepo("pr-body.md", "Adds the feature.\n");
  const created = await forge(["pr", "create", "--draft", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile]);
  return created.stdout.trim();
}

const repositoryKey = `${FAKE_FORGEJO_ADMIN}/staging-demo`;

test("creating a pull request for a repository with no Forgejo copy creates the repository, adds the forgejo remote and pushes the base branch", async () => {
  assert.equal(forgejo.repositories.size, 0);
  assert.equal(await git(checkout.repo, ["remote"]), "origin");

  const url = await createDraftPullRequest();

  assert.deepEqual([...forgejo.repositories], [[repositoryKey, { private: true }]]);
  assert.equal(await git(checkout.repo, ["remote", "get-url", "forgejo"]), `${forgejo.rootUrl}${repositoryKey}.git`);
  const bare = forgejo.bareRepositoryPath(repositoryKey);
  assert.equal(await git(bare, ["rev-parse", "refs/heads/main"]), await git(checkout.repo, ["rev-parse", "main"]));
  assert.equal(await git(bare, ["rev-parse", "refs/heads/add/feature"]), await git(checkout.repo, ["rev-parse", "add/feature"]));
  assert.equal(url, `${forgejo.rootUrl}${repositoryKey}/pulls/1`);
});

test("creating the same pull request twice opens one pull request and one repository", async () => {
  const first = await createDraftPullRequest();
  const second = await createDraftPullRequest();
  const ensured = await forge(["ensure-repository"]);

  assert.equal(second, first);
  assert.equal(forgejo.pullRequests.length, 1);
  assert.equal(forgejo.repositories.size, 1);
  assert.equal(await git(checkout.repo, ["remote"]), "forgejo\norigin");
  assert.deepEqual(JSON.parse(ensured.stdout), { owner: FAKE_FORGEJO_ADMIN, name: "staging-demo", created: false });
});

test("the first pull request in a brand-new Forgejo copy opens even when Forgejo registers the pushed branch late", async () => {
  forgejo.registerPushedBranchesAfterReads(3);

  const url = await createDraftPullRequest();

  assert.equal(url, `${forgejo.rootUrl}${repositoryKey}/pulls/1`);
  assert.equal(forgejo.pullRequests.length, 1);
  assert.deepEqual(forgejo.pullRequestCreateRequests, ["add/feature"]);
});

test("the Forgejo token never lands in the repository's git config", async () => {
  const url = await createDraftPullRequest();
  const outputs = [url, (await forge(["push-branch", "--branch", "add/feature"])).stdout, (await forge(["pr", "view", "1"])).stdout];

  const config = await readFile(path.join(checkout.repo, ".git", "config"), "utf8");
  const encoded = Buffer.from(`${FAKE_FORGEJO_ADMIN}:${TEST_FORGEJO_TOKEN}`).toString("base64");
  for (const text of [config, ...outputs]) {
    assert.doesNotMatch(text, new RegExp(TEST_FORGEJO_TOKEN));
    assert.doesNotMatch(text, new RegExp(encoded));
  }
  assert.doesNotMatch(await git(checkout.repo, ["remote", "get-url", "forgejo"]), /@/);
  assert.ok(forgejo.gitAuthorizations.length > 0);
  assert.ok(forgejo.gitAuthorizations.every((header) => header === `Basic ${encoded}`));
});

test("a pull request created in Forgejo is titled with the unknown GitHub marker", async () => {
  const bodyFile = await writeFileInRepo("pr-body.md", "Adds the feature.\n");

  await forge(["pr", "create", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile]);

  assert.equal(forgejo.pullRequests[0]!.title, "[GH-##] Add the feature");
});

test("a draft created in Forgejo keeps WIP first and the marker after it, and is still a draft", async () => {
  await createDraftPullRequest();

  const view = JSON.parse((await forge(["pr", "view", "add/feature"])).stdout);

  assert.equal(forgejo.pullRequests[0]!.title, "WIP: [GH-##] Add the feature");
  assert.deepEqual(view, {
    number: 1,
    url: `${forgejo.rootUrl}${repositoryKey}/pulls/1`,
    title: "[GH-##] Add the feature",
    body: "Adds the feature.\n",
    state: "OPEN",
    isDraft: true,
    headRefName: "add/feature",
    baseRefName: "main",
  });
});

test("pull request view, edit, list, diff and comment work against Forgejo", async () => {
  const url = await createDraftPullRequest();
  const newBody = await writeFileInRepo("new-body.md", "Rewritten body.\n");
  const commentBody = await writeFileInRepo("comment.md", "Looks right.\n");

  const edited = await forge(["pr", "edit", url, "--body-file", newBody]);
  const listed = JSON.parse((await forge(["pr", "list"])).stdout);
  const diff = (await forge(["pr", "diff", "1"])).stdout;
  const comment = (await forge(["pr", "comment", "add/feature", "--body-file", commentBody])).stdout;

  assert.equal(edited.stdout, `${url}\n`);
  assert.equal(forgejo.pullRequests[0]!.body, "Rewritten body.\n");
  assert.deepEqual(listed, [
    { number: 1, title: "[GH-##] Add the feature", headRefName: "add/feature", url, files: [{ path: "feature.txt" }] },
  ]);
  assert.match(diff, /^\+\+\+ b\/feature\.txt$/m);
  assert.equal(comment, `${url}#issuecomment-1\n`);
  assert.deepEqual(forgejo.comments, [{ repository: repositoryKey, number: 1, body: "Looks right.\n" }]);
  assert.deepEqual(dependencies.githubCalls, []);
});

test("attaching a file returns its URL and the markdown that shows it inline in Forgejo", async () => {
  const url = await createDraftPullRequest();
  const video = await writeFileInRepo("checkout-flow.mp4", new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
  const image = await writeFileInRepo("checkout-page.png", new Uint8Array([137, 80, 78, 71]));

  const attachedVideo = JSON.parse((await forge(["attach", url, "--file", video])).stdout);
  const attachedImage = JSON.parse((await forge(["attach", "1", "--file", image])).stdout);

  assert.deepEqual(attachedVideo, {
    url: `${forgejo.rootUrl}attachments/uuid-1`,
    markdown: `<video src="${forgejo.rootUrl}attachments/uuid-1" title="checkout-flow" controls></video>`,
  });
  assert.deepEqual(attachedImage, {
    url: `${forgejo.rootUrl}attachments/uuid-2`,
    markdown: `![checkout-page](${forgejo.rootUrl}attachments/uuid-2)`,
  });
  assert.deepEqual(forgejo.attachments, [
    { id: 1, uuid: "uuid-1", repository: repositoryKey, number: 1, name: "checkout-flow.mp4", bytes: 8 },
    { id: 2, uuid: "uuid-2", repository: repositoryKey, number: 1, name: "checkout-page.png", bytes: 4 },
  ]);
});

test("detaching an attachment URL from a Forgejo pull request deletes that attachment and leaves the others", async () => {
  const url = await createDraftPullRequest();
  const kept = JSON.parse((await forge(["attach", url, "--file", await writeFileInRepo("kept.png", "kept")])).stdout);
  const replaced = JSON.parse((await forge(["attach", url, "--file", await writeFileInRepo("replaced.png", "replaced")])).stdout);

  const detached = JSON.parse((await forge(["detach", url, "--url", replaced.url])).stdout);
  const detachedAgain = JSON.parse((await forge(["detach", url, "--url", replaced.url])).stdout);

  assert.deepEqual(detached, { detached: true });
  assert.deepEqual(detachedAgain, { detached: false });
  assert.deepEqual(forgejo.attachments.map((attachment) => `${forgejo.rootUrl}attachments/${attachment.uuid}`), [kept.url]);
});

test("markdown renders through Forgejo in gfm mode with the repository as context", async () => {
  const markdown = await writeFileInRepo("body.md", "> [!NOTE]\n> Rendered here.\n");

  const rendered = await forge(["render-markdown", "--file", markdown]);

  assert.equal(rendered.stdout, "<p>rendered</p>\n");
  assert.deepEqual(forgejo.markdownRequests, [{ Mode: "gfm", Text: "> [!NOTE]\n> Rendered here.\n", Context: repositoryKey }]);
  assert.equal(forgejo.repositories.size, 0);
});

test("a Forgejo host without the API token refuses and names install-forgejo.sh", async () => {
  await state.installForgejo(forgejo.rootUrl, { token: null });
  const bodyFile = await writeFileInRepo("pr-body.md", "Body\n");

  const refused = await runForgeCapturing(
    ["pr", "create", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile],
    dependencies,
    checkout.repo,
  );

  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /api-token is missing or empty; run install-forgejo\.sh/);
  assert.equal(forgejo.repositories.size, 0);
  assert.equal(await git(checkout.repo, ["remote"]), "origin");
});
