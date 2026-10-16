import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ProcessResult } from "../src/forge/forge-dependencies.ts";
import { stagingMetadataCommentBody } from "../src/forge/staging-metadata.ts";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_FORGEJO_ADMIN, type FakeAttachment, type FakePullRequest } from "./forge-fake-forgejo.ts";
import type { FakeGithubPullRequest } from "./forge-fake-github.ts";
import { runForgeCapturing } from "./forge-test-support.ts";
import {
  dependenciesWithPublish,
  forgeJson,
  installForgeCommandOnPath,
  openGithubPullRequestToStage,
  stagingDependencies,
  startStagingHost,
  type StagingHost,
} from "./forge-staging-test-support.ts";

interface Staging {
  readonly githubUrl: string;
  readonly twinUrl: string;
  readonly created: boolean;
  readonly mediaLinksInMirroredComments: readonly unknown[];
}

const IMAGE_URL = "https://github.com/user-attachments/assets/2fc621a7-0000-4604-a5df-ffe119813416";
const VIDEO_URL = "https://github.com/user-attachments/assets/0fcd8e6c-0000-4479-8213-1aa6651d09f3";
const LOOSE_IMAGE_URL = "https://github.com/user-attachments/assets/68dd100f-0000-4b1a-9c2d-3e4f5a6b7c8d";
const OUTSIDE_IMAGE_URL = "https://cdn.example.com/bakery-logo.png";
const ENTERPRISE_GITHUB_ORIGIN = "https://github.example.test";
const ENTERPRISE_IMAGE_URL = `${ENTERPRISE_GITHUB_ORIGIN}/user-attachments/assets/7a1b2c3d-0000-4e5f-8a9b-0c1d2e3f4a5b`;
const ENTERPRISE_VIDEO_URL = `${ENTERPRISE_GITHUB_ORIGIN}/user-attachments/assets/9f8e7d6c-0000-4b5a-9c3d-2e1f0a9b8c7d`;
const REFUSED_LOOSE_IMAGE_URL = `${ENTERPRISE_GITHUB_ORIGIN}/user-attachments/assets/1d2e3f4a-0000-4c5b-8d6e-7f8a9b0c1d2e`;
const REVIEW_COMMENT = { id: 301, author: "pastry-reviewer", body: "Could the button say Order instead of Pay?", createdAt: "2026-10-07T10:04:00Z" };
const NOTHING_SYNCED = { promotedHead: null, carriedAnswers: [] };

let host: StagingHost;
let branchCount = 0;

before(async () => {
  await import("../src/forge/forge.command.ts");
  host = await startStagingHost("forge-stage-");
});

after(async () => {
  await host.remove();
});

async function githubPullRequestOnItsOwnBranch(fields: Partial<FakeGithubPullRequest> = {}, githubOrigin?: string): Promise<string> {
  branchCount += 1;
  const head = `stage/case-${branchCount}`;
  await git(host.checkout.repo, ["branch", head, "add/feature"]);
  return openGithubPullRequestToStage(host, { head, ...fields }, githubOrigin);
}

async function serveGithubMedia(media: Record<string, string>): Promise<void> {
  const state = await host.github.read();
  state.media = media;
  await host.github.write(state);
}

async function stageWithForgeCommandOnPath(githubUrl: string): Promise<FakePullRequest> {
  const forgeCommand = await installForgeCommandOnPath();
  try {
    return twinAt((await stage(githubUrl)).twinUrl);
  } finally {
    await forgeCommand.remove();
  }
}

function attachmentsOn(twin: FakePullRequest): FakeAttachment[] {
  return host.forgejo.attachments.filter((attachment) => attachment.repository === twin.repository && attachment.number === twin.number);
}

function bytesOfEveryAttachmentEmbeddedIn(twin: FakePullRequest): Array<string | undefined> {
  const attachments = attachmentsOn(twin);
  for (const attachment of attachments) {
    assert.ok(twin.body.includes(`/attachments/${attachment.uuid}`), `${attachment.name} is embedded in the twin's body`);
  }
  return attachments.map((attachment) => host.forgejo.attachmentContents.get(attachment.uuid)?.toString()).sort();
}

async function stagingRefusalFor(githubUrl: string): Promise<string> {
  const refused = await runForgeCapturing(["stage", githubUrl], stagingDependencies, host.checkout.repo);
  assert.equal(refused.exitCode, 1, refused.stdout);
  assert.equal(refused.stdout, "");
  return refused.stderr;
}

function stage(githubUrl: string): Promise<Staging> {
  return forgeJson<Staging>(host, ["stage", githubUrl]);
}

function twinAt(twinUrl: string): FakePullRequest {
  const twin = host.forgejo.pullRequests.find((pullRequest) => pullRequest.html_url === twinUrl);
  assert.ok(twin !== undefined, `Forgejo holds ${twinUrl}`);
  return twin;
}

function commentBodiesOn(twin: FakePullRequest): string[] {
  return host.forgejo.comments
    .filter((comment) => comment.repository === twin.repository && comment.number === twin.number)
    .map((comment) => comment.body);
}

function numberOf(githubUrl: string): number {
  return Number(githubUrl.split("/").pop());
}

test("staging a GitHub pull request opens its Forgejo twin titled with the GitHub number, with the live body", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch({
    body: "## Summary\n\nAdds the feature.\n\n<!-- forgejo-twin: staging-demo#9 -->\n",
  });

  const twin = twinAt((await stage(githubUrl)).twinUrl);

  assert.equal(twin.title, `[GH-${numberOf(githubUrl)}] Add the feature`);
  assert.equal(twin.body, "## Summary\n\nAdds the feature.");
  assert.deepEqual({ head: twin.head.ref, base: twin.base.ref }, { head: `stage/case-${branchCount}`, base: "main" });
  const forgejoHead = await git(host.forgejo.bareRepositoryPath(`${FAKE_FORGEJO_ADMIN}/staging-demo`), ["rev-parse", `refs/heads/${twin.head.ref}`]);
  assert.equal(forgejoHead, await git(host.checkout.repo, ["rev-parse", twin.head.ref]));
});

test("staging a draft GitHub pull request opens a WIP Forgejo twin with the GitHub number after WIP", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch({ draft: true });

  const twin = twinAt((await stage(githubUrl)).twinUrl);

  assert.equal(twin.title, `WIP: [GH-${numberOf(githubUrl)}] Add the feature`);
});

test("re-staging puts back the GitHub number deleted from the Forgejo title, never doubling it", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch({ draft: true });
  const twin = twinAt((await stage(githubUrl)).twinUrl);
  twin.title = "WIP: Add the feature";

  await stage(githubUrl);
  await stage(githubUrl);

  assert.equal(twin.title, `WIP: [GH-${numberOf(githubUrl)}] Add the feature`);
});

test("staging re-hosts GitHub-hosted images and videos as Forgejo attachments", async () => {
  const body = [
    "## Summary",
    "",
    "Adds the feature.",
    "",
    `![bakery logo](${OUTSIDE_IMAGE_URL})`,
    "",
    `![loose screenshot](${LOOSE_IMAGE_URL})`,
    "",
    "## Screenshots",
    "",
    `<!-- pr-media: 01-feature-page.png -->\n![feature page](${IMAGE_URL})\n<!-- /pr-media: 01-feature-page.png -->`,
    "",
    `<!-- pr-media: 02-feature-click.mp4 -->\n${VIDEO_URL}\n<!-- /pr-media: 02-feature-click.mp4 -->`,
    "",
  ].join("\n");
  const githubUrl = await githubPullRequestOnItsOwnBranch({ body });
  const state = await host.github.read();
  state.media = { [IMAGE_URL]: "page image bytes", [VIDEO_URL]: "click video bytes", [LOOSE_IMAGE_URL]: "loose image bytes" };
  await host.github.write(state);
  const forgeCommand = await installForgeCommandOnPath();

  let twin: FakePullRequest;
  try {
    twin = twinAt((await stage(githubUrl)).twinUrl);
  } finally {
    await forgeCommand.remove();
  }

  assert.doesNotMatch(twin.body, /user-attachments|<!-- drop /);
  assert.ok(twin.body.includes(`![bakery logo](${OUTSIDE_IMAGE_URL})`));
  const attachments = host.forgejo.attachments.filter((attachment) => attachment.number === twin.number);
  assert.deepEqual(attachments.map((attachment) => attachment.name).sort(), [
    "01-feature-page.png",
    "02-feature-click.mp4",
    "68dd100f-0000-4b1a-9c2d-3e4f5a6b7c8d.png",
  ]);
  assert.deepEqual(bytesOfEveryAttachmentEmbeddedIn(twin), ["click video bytes", "loose image bytes", "page image bytes"]);
});

test("staging a pull request on another GitHub host re-hosts its user-attachments media as Forgejo attachments", async () => {
  const body = ["## Screenshots", "", `![feature page](${ENTERPRISE_IMAGE_URL})`, "", ENTERPRISE_VIDEO_URL, ""].join("\n");
  const githubUrl = await githubPullRequestOnItsOwnBranch({ body }, ENTERPRISE_GITHUB_ORIGIN);
  await serveGithubMedia({ [ENTERPRISE_IMAGE_URL]: "enterprise image bytes", [ENTERPRISE_VIDEO_URL]: "enterprise video bytes" });

  const twin = await stageWithForgeCommandOnPath(githubUrl);

  assert.doesNotMatch(twin.body, /user-attachments|<!-- drop /);
  assert.deepEqual(bytesOfEveryAttachmentEmbeddedIn(twin), ["enterprise image bytes", "enterprise video bytes"]);
  const downloads = (await host.github.read()).calls.filter((call) => call[0] === "api" && call[1]?.startsWith(ENTERPRISE_GITHUB_ORIGIN));
  assert.deepEqual(downloads, [
    ["api", ENTERPRISE_IMAGE_URL],
    ["api", ENTERPRISE_VIDEO_URL],
  ]);
});

test("staging a pull request whose media could not be re-hosted opens the twin, then refuses naming each GitHub link and /pr-media publish", async () => {
  const refusedEmbed = `![refused screenshot](${ENTERPRISE_VIDEO_URL})`;
  const body = ["## Screenshots", "", `![feature page](${ENTERPRISE_IMAGE_URL})`, "", refusedEmbed, "", REFUSED_LOOSE_IMAGE_URL, ""].join("\n");
  const githubUrl = await githubPullRequestOnItsOwnBranch({ body, issueComments: [REVIEW_COMMENT] }, ENTERPRISE_GITHUB_ORIGIN);
  await serveGithubMedia({ [ENTERPRISE_IMAGE_URL]: "enterprise image bytes" });
  const forgeCommand = await installForgeCommandOnPath();

  const refusal = await stagingRefusalFor(githubUrl).finally(() => forgeCommand.remove());

  const twin = host.forgejo.pullRequests.at(-1)!;
  assert.equal(
    refusal,
    `forge stage: ${twin.html_url} still holds GitHub media links, which do not load in Forgejo (${ENTERPRISE_VIDEO_URL}, ${REFUSED_LOOSE_IMAGE_URL}), so the staging is not finished; run: /pr-media publish ${twin.html_url}\n`,
  );
  assert.ok(twin.body.includes(refusedEmbed), twin.body);
  assert.doesNotMatch(twin.body, /<!-- drop /);
  assert.ok(!twin.body.includes(ENTERPRISE_IMAGE_URL), twin.body);
  const attachments = attachmentsOn(twin);
  assert.deepEqual(attachments.map((attachment) => host.forgejo.attachmentContents.get(attachment.uuid)?.toString()), ["enterprise image bytes"]);
  assert.ok(twin.body.includes(`/attachments/${attachments[0]!.uuid}`), twin.body);
  const comments = commentBodiesOn(twin);
  assert.ok(comments.includes(stagingMetadataCommentBody({ githubUrl, sync: NOTHING_SYNCED })), comments.join("\n---\n"));
  assert.equal(comments.filter((comment) => comment.includes(REVIEW_COMMENT.body)).length, 1);
});

test("staging an already staged pull request whose Forgejo body still holds GitHub media links refuses the same way and changes nothing", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch();
  const twin = twinAt((await stage(githubUrl)).twinUrl);
  twin.body = `## Screenshots\n\n![feature page](${ENTERPRISE_IMAGE_URL})\n`;
  const pullRequestsBefore = structuredClone(host.forgejo.pullRequests);
  const commentsBefore = structuredClone(host.forgejo.comments);

  const refusal = await stagingRefusalFor(githubUrl);

  assert.equal(
    refusal,
    `forge stage: ${twin.html_url} still holds GitHub media links, which do not load in Forgejo (${ENTERPRISE_IMAGE_URL}), so the staging is not finished; run: /pr-media publish ${twin.html_url}\n`,
  );
  assert.deepEqual(host.forgejo.pullRequests, pullRequestsBefore);
  assert.deepEqual(host.forgejo.comments, commentsBefore);
});

test("a first staging that refuses for its body still reports every GitHub media link in the comments it mirrored", async () => {
  const screenshotComment = { ...REVIEW_COMMENT, id: 302, body: `The button overlaps the total:\n\n![overlap](${LOOSE_IMAGE_URL})` };
  const body = `## Screenshots\n\n![feature page](${REFUSED_LOOSE_IMAGE_URL})\n`;
  const githubUrl = await githubPullRequestOnItsOwnBranch({ body, issueComments: [screenshotComment] }, ENTERPRISE_GITHUB_ORIGIN);
  await serveGithubMedia({});

  const refusal = await stagingRefusalFor(githubUrl);

  const twin = host.forgejo.pullRequests.at(-1)!;
  assert.equal(
    refusal,
    [
      `forge stage: ${twin.html_url} still holds GitHub media links, which do not load in Forgejo (${REFUSED_LOOSE_IMAGE_URL}), so the staging is not finished; run: /pr-media publish ${twin.html_url}`,
      `a mirrored review comment holds the GitHub media link ${LOOSE_IMAGE_URL}, which does not load in Forgejo; see it on GitHub at ${githubUrl}#issuecomment-302`,
      "",
    ].join("\n"),
  );
});

test("staging a pull request whose media was all re-hosted succeeds", async () => {
  const body = ["## Screenshots", "", `![feature page](${ENTERPRISE_IMAGE_URL})`, ""].join("\n");
  const githubUrl = await githubPullRequestOnItsOwnBranch({ body }, ENTERPRISE_GITHUB_ORIGIN);
  await serveGithubMedia({ [ENTERPRISE_IMAGE_URL]: "enterprise image bytes" });
  const publishThatHostsEveryFileOnForgejo = async (): Promise<ProcessResult> => {
    const twin = host.forgejo.pullRequests.at(-1)!;
    twin.body = twin.body.replace(/<!-- drop (.+?) here -->/g, `![$1](${host.forgejo.rootUrl}attachments/$1)`);
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const staged = await runForgeCapturing(["stage", githubUrl], dependenciesWithPublish(publishThatHostsEveryFileOnForgejo), host.checkout.repo);

  const twin = host.forgejo.pullRequests.at(-1)!;
  assert.equal(staged.exitCode, 0, staged.stderr);
  assert.equal(staged.stdout, `${JSON.stringify({ githubUrl, twinUrl: twin.html_url, created: true, mediaLinksInMirroredComments: [] })}\n`);
  assert.equal(staged.stderr, "");
  assert.doesNotMatch(twin.body, /user-attachments|<!-- drop /);
  assert.ok(twin.body.includes(`](${host.forgejo.rootUrl}attachments/`), twin.body);
});

test("staging writes the one metadata comment linking the GitHub pull request", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch();

  const twin = twinAt((await stage(githubUrl)).twinUrl);

  const metadata = stagingMetadataCommentBody({ githubUrl, sync: NOTHING_SYNCED });
  assert.deepEqual(commentBodiesOn(twin), [metadata]);
  assert.ok(metadata.startsWith(`GitHub: ${githubUrl}\n`));
});

test("staging mirrors the GitHub feedback once", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch({ issueComments: [REVIEW_COMMENT] });

  const twin = twinAt((await stage(githubUrl)).twinUrl);
  await stage(githubUrl);

  const mirrored = commentBodiesOn(twin).filter((body) => body.includes(REVIEW_COMMENT.body));
  assert.equal(mirrored.length, 1);
  assert.ok(mirrored[0]!.includes(`<!-- github-feedback: comment ${numberOf(githubUrl)} ${REVIEW_COMMENT.id} -->`));
});

test("staging makes no GitHub write", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch({ issueComments: [REVIEW_COMMENT] });
  const writesBefore = (await host.github.mutatingCalls()).length;

  await stage(githubUrl);
  await stage(githubUrl);

  assert.equal((await host.github.mutatingCalls()).length, writesBefore);
  const github = (await host.github.read()).pullRequests.find((pullRequest) => pullRequest.url === githubUrl)!;
  assert.equal(github.body, "## Summary\n\nAdds the feature.\n");
  assert.deepEqual(github.issueComments, [REVIEW_COMMENT]);
});

test("staging an already staged pull request prints its twin and changes nothing", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch();
  const first = await stage(githubUrl);
  const pullRequestsBefore = structuredClone(host.forgejo.pullRequests);
  const commentsBefore = structuredClone(host.forgejo.comments);

  const second = await stage(githubUrl);

  assert.deepEqual(second, { githubUrl, twinUrl: first.twinUrl, created: false, mediaLinksInMirroredComments: [] });
  assert.deepEqual(host.forgejo.pullRequests, pullRequestsBefore);
  assert.deepEqual(host.forgejo.comments, commentsBefore);
});

test("staging an already staged pull request rewrites an old-shape twin comment into the metadata comment", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch();
  const twin = twinAt((await stage(githubUrl)).twinUrl);
  const metadataComment = host.forgejo.comments.find(
    (comment) => comment.number === twin.number && comment.repository === twin.repository && comment.body.includes("github-twin"),
  )!;
  metadataComment.body = `Promoted to GitHub: ${githubUrl}\n\n<!-- github-twin: ${githubUrl} -->\n`;

  const again = await stage(githubUrl);

  assert.equal(again.created, false);
  assert.deepEqual(commentBodiesOn(twin), [stagingMetadataCommentBody({ githubUrl, sync: NOTHING_SYNCED })]);
});

test("staging refuses a pull request whose head branch is not fetched, naming the fetch", async () => {
  const githubUrl = await openGithubPullRequestToStage(host, { head: "colleague/change" });
  const pullRequestsBefore = host.forgejo.pullRequests.length;

  const refused = await runForgeCapturing(["stage", githubUrl], stagingDependencies, host.checkout.repo);

  assert.equal(refused.exitCode, 1);
  assert.ok(refused.stderr.includes("`git fetch origin colleague/change:colleague/change`"), refused.stderr);
  assert.equal(host.forgejo.pullRequests.length, pullRequestsBefore);
});

test("staging names the review hook base when the review hook refuses the push", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch();
  const hooks = await mkdtemp(path.join(tmpdir(), "forge-stage-hooks-"));
  await writeFile(
    path.join(hooks, "pre-push"),
    "#!/bin/sh\necho 'no merge-base with origin/trunk, skipping review (set AI_REVIEW_HOOK_BASE)' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  await git(host.checkout.repo, ["config", "core.hooksPath", hooks]);

  try {
    const refused = await runForgeCapturing(["stage", githubUrl], stagingDependencies, host.checkout.repo);

    assert.equal(refused.exitCode, 1);
    assert.ok(refused.stderr.includes("`git fetch origin +refs/heads/main:refs/remotes/origin/main`"), refused.stderr);
    assert.ok(refused.stderr.includes(`\`AI_REVIEW_HOOK_BASE=origin/main throne forge stage ${githubUrl}\``), refused.stderr);
  } finally {
    await git(host.checkout.repo, ["config", "--unset", "core.hooksPath"]);
    await rm(hooks, { recursive: true, force: true });
  }
});

test("staging prints the GitHub url, the twin url and whether it was created", async () => {
  const githubUrl = await githubPullRequestOnItsOwnBranch();

  const printed = await runForgeCapturing(["stage", `${githubUrl}/files`], stagingDependencies, host.checkout.repo);

  assert.equal(printed.exitCode, 0, printed.stderr);
  const twin = host.forgejo.pullRequests.at(-1)!;
  assert.equal(printed.stdout, `${JSON.stringify({ githubUrl, twinUrl: twin.html_url, created: true, mediaLinksInMirroredComments: [] })}\n`);
});
