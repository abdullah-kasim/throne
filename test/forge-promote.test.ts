import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import type { ProcessResult } from "../src/forge/forge-dependencies.ts";
import { PUBLISH_SCRIPT_PATH } from "../src/forge/promotion-media.ts";
import { stagingMetadataCommentBody } from "../src/forge/staging-metadata.ts";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_GITHUB_REPOSITORY } from "./forge-fake-github.ts";
import { runForgeCapturing } from "./forge-test-support.ts";
import {
  dependenciesWithPublish,
  forge,
  openForgejoDraftPullRequest,
  openForgejoPullRequestWithMedia,
  promote,
  stagingDependencies,
  startStagingHostForEachTest,
  type StagingHost,
} from "./forge-staging-test-support.ts";

const stagingHostForThisTest = startStagingHostForEachTest("forge-promote-");
let host: StagingHost;

beforeEach(async () => {
  host = stagingHostForThisTest();
});

function anchoredUrlsIn(body: string): Map<string, string> {
  const urls = new Map<string, string>();
  for (const match of body.matchAll(/<!-- pr-media: (.+?) -->([\s\S]*?)<!-- \/pr-media: \1 -->/g)) {
    urls.set(match[1]!, /https:\/\/\S*user-attachments\S*?(?=[)\s])/.exec(match[2]!)?.[0] ?? "");
  }
  return urls;
}

const PUBLISH_THAT_UPLOADS_NOTHING = async (): Promise<ProcessResult> => ({ exitCode: 0, stdout: "", stderr: "" });

async function refusedPromotion(forgejoUrl: string, publish: () => Promise<ProcessResult>): Promise<string> {
  const refused = await runForgeCapturing(["promote", forgejoUrl], dependenciesWithPublish(publish), host.checkout.repo);
  assert.equal(refused.exitCode, 1, refused.stdout);
  assert.equal(refused.stdout, "");
  assert.ok(refused.stderr.trim().endsWith(`run: throne forge promote ${forgejoUrl}`), refused.stderr);
  return refused.stderr;
}

test("promoting a Forgejo pull request opens the same pull request on GitHub with GitHub-hosted media", async () => {
  const forgejoUrl = await openForgejoPullRequestWithMedia(host);

  const promotion = await promote(host, forgejoUrl);

  const [githubPullRequest, ...others] = (await host.github.read()).pullRequests;
  assert.deepEqual(others, []);
  assert.equal(promotion.created, true);
  assert.equal(promotion.githubUrl, `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/7`);
  assert.deepEqual(
    { title: githubPullRequest!.title, base: githubPullRequest!.base, head: githubPullRequest!.head, draft: githubPullRequest!.draft },
    { title: "Add the feature", base: "main", head: "add/feature", draft: true },
  );
  assert.match(githubPullRequest!.body, /^## Summary\n\nAdds the feature\.\n/);
  const hosted = anchoredUrlsIn(githubPullRequest!.body);
  assert.deepEqual([...hosted.keys()].sort(), ["01-feature-page.png", "02-feature-click.mp4", "diagram.png"]);
  for (const url of hosted.values()) assert.match(url, /^https:\/\/github\.com\/user-attachments\/assets\/\d+$/);
  assert.doesNotMatch(githubPullRequest!.body, /attachments\/uuid-|<!-- drop /);
  const promotedHead = await git(host.checkout.repo, ["rev-parse", "add/feature"]);
  assert.equal(await git(host.checkout.origin, ["rev-parse", "refs/heads/add/feature"]), promotedHead);
  const createCall = (await host.github.read()).calls.find((call) => call.includes("create"))!;
  assert.deepEqual(createCall.slice(0, 4), ["--bypass", "pr", "create", "--draft"]);
  assert.deepEqual(
    host.forgejo.comments.map((comment) => comment.body),
    [stagingMetadataCommentBody({ githubUrl: promotion.githubUrl, sync: { promotedHead, carriedAnswers: [] } })],
  );
});

test("the first promote sends GitHub a title without the marker and leaves the Forgejo title with the GitHub number", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  assert.equal(host.forgejo.pullRequests[0]!.title, "WIP: [GH-##] Add the feature");

  await promote(host, forgejoUrl);

  assert.equal((await host.github.read()).pullRequests[0]!.title, "Add the feature");
  assert.equal(host.forgejo.pullRequests[0]!.title, "WIP: [GH-7] Add the feature");
});

test("a repromote puts back the marker the Lord deleted from the Forgejo title", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  await promote(host, forgejoUrl);
  host.forgejo.pullRequests[0]!.title = "WIP: Add the feature";

  await promote(host, forgejoUrl);

  assert.equal(host.forgejo.pullRequests[0]!.title, "WIP: [GH-7] Add the feature");
  assert.equal((await host.github.read()).pullRequests[0]!.title, "Add the feature");
});

test("promoting the same pull request twice opens nothing new", async () => {
  const forgejoUrl = await openForgejoPullRequestWithMedia(host);

  const first = await promote(host, forgejoUrl);
  const second = await promote(host, "1");

  assert.equal(second.githubUrl, first.githubUrl);
  assert.equal(second.created, false);
  assert.equal((await host.github.read()).pullRequests.length, 1);
  assert.equal((await host.github.read()).calls.filter((call) => call.includes("create")).length, 1);
  assert.equal(host.forgejo.comments.length, 1);
});

test("promote records the promoted head in the one metadata comment instead of posting a second comment", async () => {
  const forgejoUrl = await openForgejoPullRequestWithMedia(host);
  const { githubUrl } = await promote(host, forgejoUrl);
  const metadataCommentId = host.forgejo.comments.length;
  await writeFile(path.join(host.checkout.repo, "feature.txt"), "first line\nsecond line, reworded\nthird line\n");
  await git(host.checkout.repo, ["commit", "--no-gpg-sign", "-q", "-am", "reword the second line"]);
  await forge(host, ["push-branch", "--branch", "add/feature"]);

  await promote(host, forgejoUrl);

  const promotedHead = await git(host.checkout.repo, ["rev-parse", "add/feature"]);
  assert.equal(host.forgejo.comments.length, metadataCommentId);
  assert.deepEqual(
    host.forgejo.comments.map((comment) => comment.body),
    [stagingMetadataCommentBody({ githubUrl, sync: { promotedHead, carriedAnswers: [] } })],
  );
  assert.equal(await git(host.checkout.origin, ["rev-parse", "refs/heads/add/feature"]), promotedHead);
});

test("promote refuses a GitHub pull request that was never staged", async () => {
  const state = await host.github.read();
  state.pullRequests.push({
    number: 3,
    url: `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/3`,
    title: "A colleague's change",
    body: "Plain GitHub pull request.",
    base: "main",
    head: "colleague/change",
    draft: false,
    threads: [],
    issueComments: [],
    reviews: [],
  });
  await host.github.write(state);

  const refused = await runForgeCapturing(
    ["promote", `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/3`],
    stagingDependencies,
    host.checkout.repo,
  );

  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /was never staged or promoted: no Forgejo metadata comment links it/);
  assert.deepEqual(await host.github.mutatingCalls(), []);
});

test("a promote whose media publish leaves drop placeholders on GitHub fails and names them", async () => {
  const forgejoUrl = await openForgejoPullRequestWithMedia(host);

  const message = await refusedPromotion(forgejoUrl, PUBLISH_THAT_UPLOADS_NOTHING);

  assert.match(message, /still holds drop placeholders for diagram\.png, 01-feature-page\.png, 02-feature-click\.mp4 after the media publish/);
});

test("a promote that leaves a media link to the Forgejo host in the GitHub body fails and names the promote command that finishes it", async () => {
  const forgejoUrl = await openForgejoPullRequestWithMedia(host);
  const publishThatLinksForgejo = async (): Promise<ProcessResult> => {
    const state = await host.github.read();
    const pullRequest = state.pullRequests[0]!;
    pullRequest.body = pullRequest.body.replace(/<!-- drop (.+?) here -->/g, `![$1](${host.forgejo.rootUrl}/attachments/$1)`);
    await host.github.write(state);
    return PUBLISH_THAT_UPLOADS_NOTHING();
  };

  const message = await refusedPromotion(forgejoUrl, publishThatLinksForgejo);

  const forgejoMediaLinks = ["diagram.png", "01-feature-page.png", "02-feature-click.mp4"].map((name) => `${host.forgejo.rootUrl}/attachments/${name}`);
  const githubUrl = (await host.github.read()).pullRequests[0]!.url;
  assert.equal(
    message,
    `forge promote: ${githubUrl} still holds media links to the Forgejo host (${forgejoMediaLinks.join(", ")}) after the media publish, so the promotion is not finished; run: throne forge promote ${forgejoUrl}\n`,
  );
});

test("a promote whose GitHub Enterprise upload needs a sign-in says so and names the one command that finishes it", async () => {
  const forgejoUrl = await openForgejoPullRequestWithMedia(host);
  const publishWithNoSignIn = async (): Promise<ProcessResult> => ({
    exitCode: 1,
    stdout: "",
    stderr: "pr-media: github.com is not signed in. A browser window is open on its sign-in page; sign in there. Waiting up to 600s.\nno sign-in to github.com within 600s; run publish again to retry\n",
  });

  const message = await refusedPromotion(forgejoUrl, publishWithNoSignIn);

  assert.match(message, /^forge promote: the upload to github\.com needs you to sign in in the browser window it opens/);
  assert.equal(message.match(/run: /g)?.length, 1);
});

test("a repromote with nothing else changed re-publishes the media while GitHub still holds drop placeholders", async () => {
  const forgejoUrl = await openForgejoPullRequestWithMedia(host);
  await refusedPromotion(forgejoUrl, PUBLISH_THAT_UPLOADS_NOTHING);

  const repromotion = await promote(host, forgejoUrl);

  assert.equal(repromotion.created, false);
  const githubBody = (await host.github.read()).pullRequests[0]!.body;
  assert.doesNotMatch(githubBody, /<!-- drop /);
  assert.deepEqual([...anchoredUrlsIn(githubBody).keys()].sort(), ["01-feature-page.png", "02-feature-click.mp4", "diagram.png"]);
  for (const url of anchoredUrlsIn(githubBody).values()) assert.match(url, /^https:\/\/github\.com\/user-attachments\/assets\/\d+$/);
});

test("a promote whose GitHub Enterprise upload falls back to the wizard keeps the media and names the one command that starts the wizard", async () => {
  const forgejoUrl = await openForgejoPullRequestWithMedia(host);
  const home = await mkdtemp(path.join(tmpdir(), "forge-promote-home-"));
  await mkdir(path.join(home, "tmp", "pr-media-7"), { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const publishOnAChangedPage = async (): Promise<ProcessResult> => ({
    exitCode: 1,
    stdout: "",
    stderr: `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/7 has no #new_comment_field comment box with a #fc-new_comment_field file input; the page layout changed, so fall back to --wizard and --collect\n`,
  });
  try {
    const refused = await runForgeCapturing(["promote", forgejoUrl], dependenciesWithPublish(publishOnAChangedPage), host.checkout.repo);

    assert.equal(refused.exitCode, 1, refused.stdout);
    const message = refused.stderr.trim();
    assert.match(message, /^forge promote: the upload to github\.com needs the hand-upload wizard/);
    const command = /run: (.+)$/.exec(message)?.[1] ?? "";
    assert.equal(message.match(/run: /g)?.length, 1);
    const keptFolder = /--folder (\S+) --wizard$/.exec(command)?.[1] ?? "";
    assert.equal(command, `node ${PUBLISH_SCRIPT_PATH} https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/7 --folder ${keptFolder} --wizard`);
    assert.equal(path.dirname(keptFolder), path.join(home, "tmp"));
    assert.notEqual(keptFolder, path.join(home, "tmp", "pr-media-7"));
    assert.deepEqual((await readdir(keptFolder)).sort(), ["01-feature-page.png", "02-feature-click.mp4", "diagram.png"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
