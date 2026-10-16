import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openForgejoApi } from "../src/forge/forgejo-api.ts";
import { writeStagingMetadataComment } from "../src/forge/staging-metadata.ts";
import { FAKE_FORGEJO_ADMIN, startFakeForgejo, type FakeForgejo } from "./forge-fake-forgejo.ts";
import { FAKE_GITHUB_REPOSITORY } from "./forge-fake-github.ts";
import {
  forgeDependenciesWithFakeGithub,
  runForgeCapturing,
  TEST_FORGEJO_TOKEN,
  useFreshForgejoStateDirectory,
  type ForgejoStateDirectory,
} from "./forge-test-support.ts";

interface StagedPair {
  readonly forgejoUrl: string;
  readonly githubUrl: string;
}

const FORGEJO_REPOSITORY_NAME = "staging-demo";
const FORGEJO_REPOSITORY = `${FAKE_FORGEJO_ADMIN}/${FORGEJO_REPOSITORY_NAME}`;
const GITHUB_IMAGE_URL = "https://github.example.test/user-attachments/assets/7a1b2c3d-0000-4e5f-8a9b-0c1d2e3f4a5b";
const GITHUB_VIDEO_URL = "https://github.com/user-attachments/assets/0fcd8e6c-0000-4479-8213-1aa6651d09f3";
const PLAIN_BODY = "## Summary\n\nAdds the feature.\n";

let state: ForgejoStateDirectory;
let forgejo: FakeForgejo;
const githubBodies = new Map<string, string>();

const dependencies = forgeDependenciesWithFakeGithub((call) => {
  const url = call.args[2]!;
  const pullRequest = { number: Number(url.split("/").pop()), url, state: "OPEN", isDraft: false, headRefName: "add/feature", baseRefName: "main", headRefOid: "", body: githubBodies.get(url) };
  return { exitCode: 0, stdout: `${JSON.stringify(pullRequest)}\n`, stderr: "" };
});

before(async () => {
  await import("../src/forge/forge.command.ts");
  state = await useFreshForgejoStateDirectory();
  forgejo = await startFakeForgejo(TEST_FORGEJO_TOKEN);
  await state.installForgejo(forgejo.rootUrl);
  forgejo.repositories.set(FORGEJO_REPOSITORY, { private: true });
});

after(async () => {
  await forgejo.close();
  await state.remove();
});

async function stagedPairWithBodies(forgejoBody: string, githubBody: string): Promise<StagedPair> {
  const number = forgejo.pullRequests.length + 1;
  const forgejoUrl = `${forgejo.rootUrl}${FORGEJO_REPOSITORY}/pulls/${number}`;
  const githubUrl = `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/${40 + number}`;
  forgejo.pullRequests.push({
    number,
    html_url: forgejoUrl,
    title: "Add the feature",
    body: forgejoBody,
    state: "open",
    merged: false,
    head: { ref: "add/feature" },
    base: { ref: "main" },
    repository: FORGEJO_REPOSITORY,
  });
  githubBodies.set(githubUrl, githubBody);
  const api = await openForgejoApi(forgejo.rootUrl, dependencies);
  await writeStagingMetadataComment({ repository: { owner: FAKE_FORGEJO_ADMIN, name: FORGEJO_REPOSITORY_NAME }, number }, githubUrl, {}, api);
  return { forgejoUrl, githubUrl };
}

function forgejoAttachmentUrl(name: string): string {
  return `${forgejo.rootUrl}attachments/${name}`;
}

function checkMediaLinks(target: string, ...flags: string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return runForgeCapturing(["check-media-links", target, ...flags], dependencies, process.cwd());
}

test("check-media-links prints the GitHub media links in a Forgejo body and exits 1", async () => {
  const forgejoBody = `${PLAIN_BODY}\n![feature page](${GITHUB_IMAGE_URL})\n\n${GITHUB_VIDEO_URL}\n`;
  const { forgejoUrl, githubUrl } = await stagedPairWithBodies(forgejoBody, PLAIN_BODY);
  const githubCallsBefore = dependencies.githubCalls.length;
  const commentsBefore = forgejo.comments.length;

  const checked = await checkMediaLinks(forgejoUrl);

  assert.equal(checked.exitCode, 1, checked.stderr);
  assert.equal(checked.stdout, `forgejo: ${GITHUB_IMAGE_URL}\nforgejo: ${GITHUB_VIDEO_URL}\n`);
  assert.equal(checked.stderr, "");
  assert.deepEqual(
    dependencies.githubCalls.slice(githubCallsBefore).map((call) => call.args.slice(0, 3)),
    [["pr", "view", githubUrl]],
  );
  assert.equal(forgejo.comments.length, commentsBefore);
});

test("check-media-links prints the Forgejo media links in a GitHub body and exits 1", async () => {
  const attachmentUrl = forgejoAttachmentUrl("5d2c7f10-0000-4a6b-9c1d-8e7f6a5b4c3d");
  const { forgejoUrl } = await stagedPairWithBodies(PLAIN_BODY, `${PLAIN_BODY}\n![feature page](${attachmentUrl})\n`);

  const checked = await checkMediaLinks(forgejoUrl);
  const asJson = await checkMediaLinks(forgejoUrl, "--json");

  assert.equal(checked.exitCode, 1, checked.stderr);
  assert.equal(checked.stdout, `github: ${attachmentUrl}\n`);
  assert.equal(asJson.exitCode, 1, asJson.stderr);
  assert.deepEqual(JSON.parse(asJson.stdout), { forgejo: [], github: [attachmentUrl] });
});

test("check-media-links exits 0 when neither side holds a cross-host media link", async () => {
  const hostedHere = `${PLAIN_BODY}\n![feature page](${forgejoAttachmentUrl("8b1e4a22-0000-4d3c-8f5e-1a2b3c4d5e6f")})\n`;
  const { forgejoUrl, githubUrl } = await stagedPairWithBodies(hostedHere, `${PLAIN_BODY}\n![feature page](${GITHUB_IMAGE_URL})\n`);
  const neverPromotedUrl = `${forgejo.rootUrl}${FORGEJO_REPOSITORY}/pulls/${forgejo.pullRequests.length + 1}`;
  forgejo.pullRequests.push({ ...forgejo.pullRequests.at(-1)!, number: forgejo.pullRequests.length + 1, html_url: neverPromotedUrl });

  const checked = await checkMediaLinks(githubUrl);
  const asJson = await checkMediaLinks(forgejoUrl, "--json");
  const oneSided = await checkMediaLinks(neverPromotedUrl, "--json");

  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.equal(checked.stdout, "no cross-host media links were found\n");
  assert.equal(asJson.exitCode, 0, asJson.stderr);
  assert.deepEqual(JSON.parse(asJson.stdout), { forgejo: [], github: [] });
  assert.equal(oneSided.exitCode, 0, oneSided.stderr);
  assert.deepEqual(JSON.parse(oneSided.stdout), { forgejo: [], github: [] });
});

test("check-media-links finds the same pair from either side's url", async () => {
  const attachmentUrl = forgejoAttachmentUrl("3c9d1e55-0000-4f2a-8b7c-6d5e4f3a2b1c");
  const { forgejoUrl, githubUrl } = await stagedPairWithBodies(`${PLAIN_BODY}\n${GITHUB_VIDEO_URL}\n`, `${PLAIN_BODY}\n![feature page](${attachmentUrl})\n`);

  const fromForgejo = await checkMediaLinks(forgejoUrl);
  const fromGithub = await checkMediaLinks(githubUrl);

  assert.equal(fromForgejo.exitCode, 1, fromForgejo.stderr);
  assert.equal(fromForgejo.stdout, `forgejo: ${GITHUB_VIDEO_URL}\ngithub: ${attachmentUrl}\n`);
  assert.deepEqual(fromGithub, fromForgejo);
});
