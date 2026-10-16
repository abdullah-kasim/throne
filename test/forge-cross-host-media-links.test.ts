import assert from "node:assert/strict";
import { test } from "node:test";
import { crossHostMediaLinksIn } from "../src/forge/cross-host-media-links.ts";
import { FORGE, type Forge } from "../src/forge/host-forge.ts";
import { forgeDependenciesWithFakeGithub, TEST_TAILNET_ADDRESS } from "./forge-test-support.ts";

const FORGEJO_ROOT_URL = "https://forge.example.test:8443/";
const FORGEJO_TWIN_URL = `${FORGEJO_ROOT_URL}example-bakery/staging-demo/pulls/3`;
const FORGEJO_ATTACHMENT_URL = `${FORGEJO_ROOT_URL}attachments/5d2c7f10-0000-4a6b-9c1d-8e7f6a5b4c3d`;
const FORGEJO_BARE_ATTACHMENT_URL = `${FORGEJO_ROOT_URL}attachments/8b1e4a22-0000-4d3c-8f5e-1a2b3c4d5e6f`;
const FORGEJO_EMBEDDED_URL = `${FORGEJO_ROOT_URL}example-bakery/staging-demo/media/branch/main/oven`;
const FORGEJO_TAILNET_VIDEO_URL = `http://${TEST_TAILNET_ADDRESS}:8420/example-bakery/staging-demo/raw/branch/main/ordering.mp4`;
const GITHUB_TWIN_URL = "https://github.example.test/example-bakery/staging-demo/pull/41";
const GITHUB_COMMIT_URL = "https://github.com/example-bakery/staging-demo/commit/4f2a9c1";
const PUBLIC_IMAGE_URL = "https://github.com/user-attachments/assets/2fc621a7-0000-4604-a5df-ffe119813416";
const ENTERPRISE_VIDEO_URL = "https://github.example.test/user-attachments/assets/0fcd8e6c-0000-4479-8213-1aa6651d09f3";
const OLD_IMAGE_URL = "https://private-user-images.githubusercontent.com/1234/5678-oven.png?jwt=abc";
const OUTSIDE_IMAGE_URL = "https://cdn.example.com/bakery-logo.png";

function linksIn(body: string, livesOn: Forge): Promise<string[]> {
  return crossHostMediaLinksIn(body, livesOn, FORGEJO_ROOT_URL, forgeDependenciesWithFakeGithub());
}

test("a GitHub attachment link in a Forgejo body is a cross-host media link, whatever GitHub host it is on", async () => {
  const body = [
    "## Screenshots",
    "",
    `![feature page](${PUBLIC_IMAGE_URL})`,
    "",
    `<!-- pr-media: 02-ordering.mp4 -->\n${ENTERPRISE_VIDEO_URL}\n<!-- /pr-media: 02-ordering.mp4 -->`,
    "",
    `<img width="400" src="${OLD_IMAGE_URL}">`,
    "",
    `The same page again: ![feature page](${PUBLIC_IMAGE_URL})`,
    "",
    `![bakery logo](${OUTSIDE_IMAGE_URL})`,
    "",
    `![hosted here](${FORGEJO_ATTACHMENT_URL})`,
  ].join("\n");

  assert.deepEqual(await linksIn(body, FORGE.forgejo), [PUBLIC_IMAGE_URL, ENTERPRISE_VIDEO_URL, OLD_IMAGE_URL]);
});

test("a link to the GitHub twin pull request or to a GitHub commit in a Forgejo body is not a cross-host media link", async () => {
  const body = `Staged from ${GITHUB_TWIN_URL}.\n\nFixed in [4f2a9c1](${GITHUB_COMMIT_URL}).\n`;

  assert.deepEqual(await linksIn(body, FORGE.forgejo), []);
});

test("a Forgejo attachment embedded in a GitHub body is a cross-host media link", async () => {
  const body = [
    `Staged as [the Forgejo pull request](${FORGEJO_TWIN_URL}).`,
    "",
    `![feature page](${FORGEJO_ATTACHMENT_URL})`,
    "",
    `<img width="400" src="${FORGEJO_EMBEDDED_URL}">`,
    "",
    FORGEJO_TAILNET_VIDEO_URL,
    "",
    FORGEJO_BARE_ATTACHMENT_URL,
    "",
    `The same recording again: ${FORGEJO_BARE_ATTACHMENT_URL}`,
    "",
    `![published here](${PUBLIC_IMAGE_URL})`,
  ].join("\n");

  assert.deepEqual(await linksIn(body, FORGE.github), [
    FORGEJO_ATTACHMENT_URL,
    FORGEJO_EMBEDDED_URL,
    FORGEJO_TAILNET_VIDEO_URL,
    FORGEJO_BARE_ATTACHMENT_URL,
  ]);
});

test("a GitHub body with no link to this host's Forgejo has no cross-host media links", async () => {
  const body = `![published here](${PUBLIC_IMAGE_URL})\n\n${ENTERPRISE_VIDEO_URL}\n\n![bakery logo](${OUTSIDE_IMAGE_URL})\n`;

  assert.deepEqual(await linksIn(body, FORGE.github), []);
});
