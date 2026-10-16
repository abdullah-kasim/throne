import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, before, beforeEach } from "node:test";
import { PRODUCTION_FORGE_DEPENDENCIES, runForgeProcess, type ForgeDependencies, type ProcessResult } from "../src/forge/forge-dependencies.ts";
import { PUBLISH_SCRIPT_PATH } from "../src/forge/promotion-media.ts";
import { installCommandsAnsweredInThisProcess } from "./commands-answered-in-this-process.ts";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_FORGEJO_ADMIN_PASSWORD, startFakeForgejo, type FakeForgejo } from "./forge-fake-forgejo.ts";
import type { FakeForgejoSnapshot } from "./forge-fake-forgejo-snapshot.ts";
import { FAKE_GITHUB_REPOSITORY, installFakeGithub, type FakeGithub, type FakeGithubPullRequest, type FakeGithubState } from "./forge-fake-github.ts";
import {
  copyOfCheckout,
  repositoryWithOriginAndFeatureBranch,
  runForgeCapturing,
  TEST_FORGEJO_TOKEN,
  TEST_TAILNET_ADDRESS,
  useFreshForgejoStateDirectory,
  type CheckoutWithOrigin,
  type ForgejoStateDirectory,
} from "./forge-test-support.ts";

export interface StagingHost {
  readonly state: ForgejoStateDirectory;
  readonly forgejo: FakeForgejo;
  readonly github: FakeGithub;
  readonly checkout: CheckoutWithOrigin;
  remove(): Promise<void>;
}

const PUBLIC_GITHUB_ORIGIN = "https://github.com";
export const FEATURE_LINES = ["first line", "second line", "third line"];

export const stagingDependencies: ForgeDependencies = {
  fetch: (input, init) => fetch(input, init),
  runProcess: runForgeProcess,
  readTailnetAddress: async () => TEST_TAILNET_ADDRESS,
};

export function dependenciesWithPublish(publish: () => Promise<ProcessResult>): ForgeDependencies {
  return {
    ...stagingDependencies,
    runProcess: (file, args, options) => (args[0] === PUBLISH_SCRIPT_PATH ? publish() : stagingDependencies.runProcess(file, args, options)),
  };
}

async function checkoutWithFeatureLines(prefix: string): Promise<CheckoutWithOrigin> {
  const checkout = await repositoryWithOriginAndFeatureBranch(prefix);
  await writeFile(path.join(checkout.repo, "feature.txt"), `${FEATURE_LINES.join("\n")}\n`);
  await git(checkout.repo, ["commit", "--no-gpg-sign", "-q", "-am", "fill in the feature"]);
  return checkout;
}

async function freshStateDirectoryFor(forgejo: FakeForgejo): Promise<ForgejoStateDirectory> {
  const state = await useFreshForgejoStateDirectory();
  await state.installForgejo(forgejo.rootUrl);
  await writeFile(path.join(state.forgejoDirectory, "admin-password"), `${FAKE_FORGEJO_ADMIN_PASSWORD}\n`, { mode: 0o600 });
  return state;
}

export async function startStagingHost(prefix: string): Promise<StagingHost> {
  const forgejo = await startFakeForgejo(TEST_FORGEJO_TOKEN);
  const state = await freshStateDirectoryFor(forgejo);
  const github = await installFakeGithub();
  const checkout = await checkoutWithFeatureLines(prefix);
  return {
    state,
    forgejo,
    github,
    checkout,
    async remove() {
      await forgejo.close();
      await github.remove();
      await checkout.remove();
      await state.remove();
    },
  };
}

export function startStagingHostForEachTest(prefix: string, prepareOnce: (host: StagingHost) => Promise<void> = async () => {}): () => StagingHost {
  let forgejo: FakeForgejo;
  let github: FakeGithub;
  let original: CheckoutWithOrigin;
  let prepared: { readonly forgejo: FakeForgejoSnapshot; readonly github: FakeGithubState };
  let current: StagingHost;
  before(async () => {
    await import("../src/forge/forge.command.ts");
    forgejo = await startFakeForgejo(TEST_FORGEJO_TOKEN);
    github = await installFakeGithub();
    original = await checkoutWithFeatureLines(prefix);
    const state = await freshStateDirectoryFor(forgejo);
    await prepareOnce({ state, forgejo, github, checkout: original, remove: async () => {} });
    await state.remove();
    prepared = { forgejo: await forgejo.snapshot(), github: await github.read() };
  });
  after(async () => {
    await forgejo.close();
    await github.remove();
    await original.remove();
  });
  beforeEach(async () => {
    await forgejo.restore(prepared.forgejo);
    await github.write(prepared.github);
    const state = await freshStateDirectoryFor(forgejo);
    const checkout = await copyOfCheckout(original, prefix);
    current = {
      state,
      forgejo,
      github,
      checkout,
      async remove() {
        await checkout.remove();
        await state.remove();
      },
    };
  });
  afterEach(() => current.remove());
  return () => current;
}

export async function forge(host: StagingHost, args: readonly string[]): Promise<string> {
  const result = await runForgeCapturing(args, stagingDependencies, host.checkout.repo);
  assert.equal(result.exitCode, 0, `forge ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

export async function forgeJson<T>(host: StagingHost, args: readonly string[]): Promise<T> {
  return JSON.parse(await forge(host, args)) as T;
}

async function writeInRepo(host: StagingHost, name: string, content: string | Uint8Array): Promise<string> {
  const filePath = path.join(host.checkout.repo, name);
  await writeFile(filePath, content);
  return filePath;
}

export async function openForgejoDraftPullRequest(host: StagingHost): Promise<string> {
  const bodyFile = await writeInRepo(host, "pr-body.md", "## Summary\n\nAdds the feature.\n");
  return (
    await forge(host, ["pr", "create", "--draft", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile])
  ).trim();
}

export async function openForgejoPullRequestWithMedia(host: StagingHost): Promise<string> {
  const url = await openForgejoDraftPullRequest(host);
  const image = await writeInRepo(host, "01-feature-page.png", new Uint8Array([137, 80, 78, 71, 13, 10]));
  const video = await writeInRepo(host, "02-feature-click.mp4", new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
  const diagram = await writeInRepo(host, "diagram.png", new Uint8Array([137, 80, 78, 71, 1]));
  const attachedImage = await forgeJson<{ markdown: string }>(host, ["attach", url, "--file", image]);
  const attachedVideo = await forgeJson<{ markdown: string }>(host, ["attach", url, "--file", video]);
  await forgeJson(host, ["attach", url, "--file", diagram]);
  const body = [
    "## Summary",
    "",
    "Adds the feature.",
    "",
    "![diagram](/attachments/uuid-3)",
    "",
    "## Screenshots",
    "",
    `<!-- pr-media: 01-feature-page.png -->\n${attachedImage.markdown}\n<!-- /pr-media: 01-feature-page.png -->`,
    "",
    `<!-- pr-media: 02-feature-click.mp4 -->\n${attachedVideo.markdown}\n<!-- /pr-media: 02-feature-click.mp4 -->`,
    "",
  ].join("\n");
  await forge(host, ["pr", "edit", url, "--body-file", await writeInRepo(host, "pr-body-with-media.md", body)]);
  return url;
}

export async function promote(host: StagingHost, target: string): Promise<{ githubUrl: string; created: boolean; answers: { replied: number[]; resolved: string[] } }> {
  return forgeJson(host, ["promote", target]);
}

export async function answerFile(host: StagingHost, text: string): Promise<string> {
  return writeInRepo(host, `answer-${Date.now()}-${Math.random().toString(16).slice(2)}.md`, text);
}

export async function openGithubPullRequestToStage(
  host: StagingHost,
  fields: Partial<FakeGithubPullRequest> = {},
  githubOrigin: string = PUBLIC_GITHUB_ORIGIN,
): Promise<string> {
  const state = await host.github.read();
  const number = 41 + state.pullRequests.length;
  const url = `${githubOrigin}/${FAKE_GITHUB_REPOSITORY}/pull/${number}`;
  state.pullRequests.push({
    number,
    url,
    title: "Add the feature",
    body: "## Summary\n\nAdds the feature.\n",
    base: "main",
    head: "add/feature",
    draft: false,
    threads: [],
    issueComments: [],
    reviews: [],
    ...fields,
  });
  await host.github.write(state);
  return url;
}

export async function installForgeCommandOnPath(): Promise<{ remove(): Promise<void> }> {
  return installCommandsAnsweredInThisProcess({
    throne: (args, callerDirectory) => runForgeCapturing(args.slice(1), PRODUCTION_FORGE_DEPENDENCIES, callerDirectory),
  });
}
