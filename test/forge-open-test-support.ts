import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordReviewedPullRequest } from "../src/forge/reviewed-pull-request-record.ts";
import { THRONE_HERDR_SESSION_NAMES } from "../src/herdr/herdr-client.ts";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_FORGEJO_ADMIN } from "./forge-fake-forgejo.ts";
import { forge, stagingDependencies, startStagingHost, type StagingHost } from "./forge-staging-test-support.ts";

export const FEATURE_BRANCH = "add/feature";

export interface OpenHost {
  readonly staging: StagingHost;
  readonly checkout: string;
  readonly featureSha: string;
  readonly scratch: string;
  addForgejoPullRequest(state: "open" | "closed"): { readonly url: string; readonly number: number };
  setLiveAgents(names: readonly string[]): Promise<void>;
  addDetachedWorktree(worktree: string): Promise<string>;
  addReviewWorktree(worktree: string, pullRequestUrl: string): Promise<string>;
  remove(): Promise<void>;
}

export interface RecordingEditor {
  readonly command: string;
  launchedPath(waitMilliseconds?: number): Promise<string | undefined>;
}

const NO_AGENTS = JSON.stringify({ result: { agents: [] } });
const EDITOR_WAIT_MILLISECONDS = 5000;
const EDITOR_POLL_MILLISECONDS = 50;

function fakeHerdrScript(agentsDirectory: string): string {
  return ["#!/bin/sh", `cat "${agentsDirectory}/$2.json" 2>/dev/null || printf '%s\\n' '${NO_AGENTS}'`, ""].join("\n");
}

async function installFakeHerdr(scratch: string): Promise<{ agentsDirectory: string; restore(): void }> {
  const agentsDirectory = path.join(scratch, "herdr-agents");
  const herdrPath = path.join(scratch, "herdr");
  await mkdir(agentsDirectory);
  await writeFile(herdrPath, fakeHerdrScript(agentsDirectory));
  await chmod(herdrPath, 0o755);
  const previous = process.env.THRONE_HERDR_CLIENT_PATH;
  process.env.THRONE_HERDR_CLIENT_PATH = herdrPath;
  return {
    agentsDirectory,
    restore() {
      if (previous === undefined) delete process.env.THRONE_HERDR_CLIENT_PATH;
      else process.env.THRONE_HERDR_CLIENT_PATH = previous;
    },
  };
}

function liveAgentListing(names: readonly string[]): string {
  const agents = names.map((name, index) => ({ agent: "claude", terminal_id: `terminal-${index}`, tab_label: name, agent_status: "working" }));
  return JSON.stringify({ result: { agents } });
}

export async function startOpenHost(prefix: string): Promise<OpenHost> {
  const staging = await startStagingHost(prefix);
  await forge(staging, ["push-branch", "--branch", FEATURE_BRANCH]);
  const featureSha = await git(staging.checkout.repo, ["rev-parse", FEATURE_BRANCH]);
  await git(staging.checkout.repo, ["checkout", "-q", "main"]);
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), `${prefix}scratch-`)));
  const herdr = await installFakeHerdr(scratch);
  const checkout = await realpath(staging.checkout.repo);
  const host: OpenHost = {
    staging,
    checkout,
    featureSha,
    scratch,
    addForgejoPullRequest(state) {
      const number = staging.forgejo.pullRequests.length + 1;
      const repository = `${FAKE_FORGEJO_ADMIN}/staging-demo`;
      const url = `${staging.forgejo.rootUrl}${repository}/pulls/${number}`;
      const pullRequest = { number, html_url: url, title: "Add the feature", body: "Adds the feature.\n", state, merged: false };
      staging.forgejo.pullRequests.push({ ...pullRequest, head: { ref: FEATURE_BRANCH }, base: { ref: "main" }, repository });
      return { url, number };
    },
    async setLiveAgents(names) {
      await writeFile(path.join(herdr.agentsDirectory, `${THRONE_HERDR_SESSION_NAMES[0]}.json`), liveAgentListing(names));
    },
    async addDetachedWorktree(worktree) {
      await git(checkout, ["worktree", "add", "-q", "--detach", worktree, featureSha]);
      return worktree;
    },
    async addReviewWorktree(worktree, pullRequestUrl) {
      await host.addDetachedWorktree(worktree);
      await recordReviewedPullRequest(worktree, pullRequestUrl, stagingDependencies);
      return worktree;
    },
    async remove() {
      herdr.restore();
      await removeWorktreesBesideCheckout(host);
      await staging.remove();
      await rm(scratch, { recursive: true, force: true });
    },
  };
  return host;
}

export async function removeWorktreesBesideCheckout(host: OpenHost): Promise<void> {
  await git(host.checkout, ["worktree", "prune"]);
  for (const listed of (await git(host.checkout, ["worktree", "list", "--porcelain"])).split("\n")) {
    const worktree = listed.startsWith("worktree ") ? listed.slice("worktree ".length) : undefined;
    if (worktree !== undefined && worktree !== host.checkout) await git(host.checkout, ["worktree", "remove", "--force", worktree]);
  }
}

export async function recordingEditor(directory: string): Promise<RecordingEditor> {
  const recordPath = path.join(directory, `editor-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const command = `${recordPath}.sh`;
  await writeFile(command, `#!/bin/sh\nprintf '%s' "$1" > "${recordPath}"\n`);
  await chmod(command, 0o755);
  return {
    command,
    async launchedPath(waitMilliseconds = EDITOR_WAIT_MILLISECONDS) {
      const deadline = Date.now() + waitMilliseconds;
      while (Date.now() < deadline) {
        const recorded = await readFile(recordPath, "utf8").catch(() => undefined);
        if (recorded !== undefined) return recorded;
        await new Promise((resolve) => setTimeout(resolve, EDITOR_POLL_MILLISECONDS));
      }
      return undefined;
    },
  };
}
