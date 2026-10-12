import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openForgejoApi, type ForgejoApi } from "../src/forge/forgejo-api.ts";
import type { ForgejoPullRequestAddress } from "../src/forge/forgejo-pull-requests.ts";
import { readStagingMetadataComment, writeStagingMetadataComment } from "../src/forge/staging-metadata.ts";
import {
  githubFeedbackRecord,
  githubTwinRecord,
  stagingSyncRecord,
  withoutStagingRecords,
  withRecordAppended,
} from "../src/forge/staging-records.ts";
import { FAKE_FORGEJO_ADMIN, startFakeForgejo, type FakeForgejo } from "./forge-fake-forgejo.ts";
import {
  forgeDependenciesWithFakeGithub,
  TEST_FORGEJO_TOKEN,
  useFreshForgejoStateDirectory,
  type ForgejoStateDirectory,
} from "./forge-test-support.ts";

const REPOSITORY = "staging-demo";
const GITHUB_URL = "https://github.com/example/staging-demo/pull/5645";

let state: ForgejoStateDirectory;
let forgejo: FakeForgejo;
let api: ForgejoApi;

before(async () => {
  state = await useFreshForgejoStateDirectory();
  forgejo = await startFakeForgejo(TEST_FORGEJO_TOKEN);
  await state.installForgejo(forgejo.rootUrl);
  forgejo.repositories.set(`${FAKE_FORGEJO_ADMIN}/${REPOSITORY}`, { private: true });
  api = await openForgejoApi(forgejo.rootUrl, forgeDependenciesWithFakeGithub());
});

after(async () => {
  await forgejo.close();
  await state.remove();
});

function openPullRequest(): ForgejoPullRequestAddress {
  const number = forgejo.pullRequests.length + 1;
  forgejo.pullRequests.push({
    number,
    html_url: `${forgejo.rootUrl}${FAKE_FORGEJO_ADMIN}/${REPOSITORY}/pulls/${number}`,
    title: "Add the feature",
    body: "Body\n",
    state: "open",
    merged: false,
    head: { ref: `add/feature-${number}` },
    base: { ref: "main" },
    repository: `${FAKE_FORGEJO_ADMIN}/${REPOSITORY}`,
  });
  return { repository: { owner: FAKE_FORGEJO_ADMIN, name: REPOSITORY }, number };
}

function conversationOf(address: ForgejoPullRequestAddress): string[] {
  return forgejo.comments.filter((comment) => comment.number === address.number).map((comment) => comment.body);
}

test("the metadata comment is written once and rewritten in place, never duplicated", async () => {
  const address = openPullRequest();
  const repository = `${FAKE_FORGEJO_ADMIN}/${REPOSITORY}`;
  const oldShape = withRecordAppended(`Promoted to GitHub: ${GITHUB_URL}`, githubTwinRecord(GITHUB_URL));
  forgejo.comments.push({ repository, number: address.number, body: "Looks good.", author: "pastry-reviewer" });
  forgejo.comments.push({ repository, number: address.number, body: oldShape });
  forgejo.comments.push({ repository, number: address.number, body: githubTwinRecord("https://github.com/example/other/pull/1"), author: "pastry-reviewer" });

  const firstId = await writeStagingMetadataComment(address, GITHUB_URL, { promotedHead: "abc123" }, api);
  const secondId = await writeStagingMetadataComment(address, GITHUB_URL, { promotedHead: "def456" }, api);

  assert.equal(secondId, firstId);
  assert.deepEqual(conversationOf(address), [
    "Looks good.",
    `GitHub: ${GITHUB_URL}\n\n<!-- github-twin: ${GITHUB_URL} -->\n<!-- staging-sync: {"promotedHead":"def456","carriedAnswers":[]} -->\n`,
    githubTwinRecord("https://github.com/example/other/pull/1"),
  ]);

  const fresh = openPullRequest();
  await writeStagingMetadataComment(fresh, GITHUB_URL, {}, api);
  await writeStagingMetadataComment(fresh, GITHUB_URL, {}, api);
  assert.deepEqual(conversationOf(fresh), [
    `GitHub: ${GITHUB_URL}\n\n<!-- github-twin: ${GITHUB_URL} -->\n<!-- staging-sync: {"promotedHead":null,"carriedAnswers":[]} -->\n`,
  ]);
});

test("writing new sync data keeps the sync data already recorded", async () => {
  const address = openPullRequest();

  await writeStagingMetadataComment(address, GITHUB_URL, { carriedAnswers: [11, 12] }, api);
  await writeStagingMetadataComment(address, GITHUB_URL, { promotedHead: "abc123" }, api);

  const recorded = await readStagingMetadataComment(address, api);
  assert.deepEqual(recorded?.sync, { promotedHead: "abc123", carriedAnswers: [11, 12] });
  assert.equal(recorded?.githubUrl, GITHUB_URL);
});

test("staging records are stripped from text, the sync record included", () => {
  const text = [
    "Answer for the reviewer.",
    githubTwinRecord(GITHUB_URL),
    githubFeedbackRecord("comment 1 2"),
    stagingSyncRecord({ promotedHead: "abc123", carriedAnswers: [11] }),
  ].join("\n");

  assert.equal(withoutStagingRecords(text), "Answer for the reviewer.");
});
